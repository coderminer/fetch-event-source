/**
 * Represents a message sent in an event stream
 * https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events#Event_stream_format
 */
export interface EventSourceMessage {
    /** The event ID to set the EventSource object's last event ID value. */
    id: string;
    /** A string identifying the type of event described. */
    event: string;
    /** The event data */
    data: string;
    /** The reconnection interval (in milliseconds) to wait before retrying the connection */
    retry?: number;
}

/**
 * Converts a fetch Response body into a callback pattern.
 * @param response The fetch Response to read from.
 * @param onChunk A function that will be called on each new byte chunk in the stream.
 * @returns {Promise<void>} A promise that will be resolved when the stream closes.
 */
export async function getBytes(response: Response, onChunk: (arr: Uint8Array) => void) {
    // No explicit BOM handling here: getLines decodes the byte slices with a
    // default TextDecoder, whose spec-mandated UTF-8 decode strips one leading
    // BOM — including one that is split across chunks:
    const reader = response.body?.getReader();
    if (reader) {
        let result: ReadableStreamReadResult<Uint8Array>;
        while (!(result = await reader.read()).done) {
            onChunk(result.value);
        }
    } else {
        // some fetch polyfills (e.g. in mobile webviews) don't provide a
        // ReadableStream body; fall back to reading the whole response:
        onChunk(new Uint8Array(await response.arrayBuffer()));
    }
}

const enum ControlChars {
    NewLine = 10,
    CarriageReturn = 13,
    Space = 32,
    Colon = 58,
}

/** 
 * Parses arbitary byte chunks into EventSource line buffers.
 * Each line should be of the format "field: value" and ends with \r, \n, or \r\n. 
 * @param onLine A function that will be called on each new EventSource line.
 * @returns A function that should be called for each incoming byte chunk.
 */
export function getLines(onLine: (line: Uint8Array, fieldLength: number) => void) {
    let buffer: Uint8Array | undefined;
    let position: number; // current read position
    let fieldLength: number; // length of the `field` portion of the line
    let discardTrailingNewline = false;

    // return a function that can process each incoming byte chunk:
    return function onChunk(arr: Uint8Array) {
        if (buffer === undefined) {
            buffer = arr;
            position = 0;
            fieldLength = -1;
        } else {
            // we're still parsing the old line. Append the new bytes into buffer:
            buffer = concat(buffer, arr);
        }

        const bufLength = buffer.length;
        let lineStart = 0; // index where the current line starts
        while (position < bufLength) {
            if (discardTrailingNewline) {
                if (buffer[position] === ControlChars.NewLine) {
                    lineStart = ++position; // skip to next char
                }
                
                discardTrailingNewline = false;
            }
            
            // start looking forward till the end of line:
            let lineEnd = -1; // index of the \r or \n char
            for (; position < bufLength && lineEnd === -1; ++position) {
                switch (buffer[position]) {
                    case ControlChars.Colon:
                        if (fieldLength === -1) { // first colon in line
                            fieldLength = position - lineStart;
                        }
                        break;
                    // @ts-ignore:7029 \r case below should fallthrough to \n:
                    case ControlChars.CarriageReturn:
                        discardTrailingNewline = true;
                    case ControlChars.NewLine:
                        lineEnd = position;
                        break;
                }
            }

            if (lineEnd === -1) {
                // We reached the end of the buffer but the line hasn't ended.
                // Wait for the next arr and then continue parsing:
                break;
            }

            // we've reached the line end, send it out:
            onLine(buffer.subarray(lineStart, lineEnd), fieldLength);
            lineStart = position; // we're now on the next line
            fieldLength = -1;
        }

        if (lineStart === bufLength) {
            buffer = undefined; // we've finished reading it
        } else if (lineStart !== 0) {
            // Create a new view into buffer beginning at lineStart so we don't
            // need to copy over the previous lines when we get the new arr:
            buffer = buffer.subarray(lineStart);
            position -= lineStart;
        }
    }
}

/** 
 * Parses line buffers into EventSourceMessages.
 * @param onId A function that will be called on each `id` field.
 * @param onRetry A function that will be called on each `retry` field.
 * @param onMessage A function that will be called on each message.
 * @returns A function that should be called for each incoming line buffer.
 */
export function getMessages(
    onId: (id: string) => void,
    onRetry: (retry: number) => void,
    onMessage?: (msg: EventSourceMessage) => void
) {
    let message = newMessage();
    const decoder = new TextDecoder();

    // return a function that can process each incoming line buffer:
    return function onLine(line: Uint8Array, fieldLength: number) {
        if (line.length === 0) {
            // empty line denotes end of message. Per the SSE spec, a message
            // with no data field is not dispatched: the data and event-type
            // buffers are just cleared:
            if (message.data === '') {
                message = newMessage();
                return;
            }

            // if the data buffer's last character is a U+000A LINE FEED
            // character, then remove the last character from the data buffer:
            if (message.data.endsWith('\n')) {
                message.data = message.data.substring(0, message.data.length - 1);
            }

            // empty line denotes end of message. Trigger the callback and start a new message:
            onMessage?.(message);
            message = newMessage();
        } else if (fieldLength !== 0) { // comment lines (first char is ':') are ignored, per the spec
            // per the spec, a line without a colon is processed as a field
            // name with an empty value; only lines containing a colon have a
            // separate value:
            const field = fieldLength === -1
                ? decoder.decode(line)
                : decoder.decode(line.subarray(0, fieldLength));
            let value = '';
            if (fieldLength !== -1) {
                // line is of format "<field>:<value>" or "<field>: <value>"
                // https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation
                const valueOffset = fieldLength + (line[fieldLength + 1] === ControlChars.Space ? 2 : 1);
                value = decoder.decode(line.subarray(valueOffset));
            }

            switch (field) {
                case 'data':
                    // append the field value to the data buffer, then append a
                    // single U+000A LINE FEED character so empty `data:` fields
                    // are not silently dropped (https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation):
                    message.data = message.data + value + '\n';
                    break;
                case 'event':
                    message.event = value;
                    break;
                case 'id':
                    // per spec, an id field value containing U+0000 is
                    // ignored; other values (including the empty string,
                    // which resets the last event id) are applied:
                    if (!value.includes('\u0000')) {
                        onId(message.id = value);
                    }
                    break;
                case 'retry':
                    // per spec, the value must consist of only ASCII digits;
                    // ' 42' (leading padding) and '42abc' are ignored:
                    if (/^\d+$/.test(value)) {
                        onRetry(message.retry = parseInt(value, 10));
                    }
                    break;
            }
        }
    }
}

function concat(a: Uint8Array, b: Uint8Array) {
    const res = new Uint8Array(a.length + b.length);
    res.set(a);
    res.set(b, a.length);
    return res;
}

function newMessage(): EventSourceMessage {
    // data, event, and id must be initialized to empty strings:
    // https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation
    // retry should be initialized to undefined so we return a consistent shape
    // to the js engine all the time: https://mathiasbynens.be/notes/shapes-ics#takeaways
    return {
        data: '',
        event: '',
        id: '',
        retry: undefined,
    };
}

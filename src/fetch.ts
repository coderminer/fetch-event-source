import { EventSourceMessage, getBytes, getLines, getMessages } from './parse';

export const EventStreamContentType = 'text/event-stream';

const DefaultRetryInterval = 1000;
const LastEventId = 'last-event-id';

export interface FetchEventSourceInit extends RequestInit {
    /**
     * The request headers. Supports the Record<string,string>, Headers and
     * string-pair-array formats; all are normalized into a single copy
     * (lowercased keys, duplicates comma-joined like Header.append) which is
     * then mutated with the last-event-id header on retries.
     */
    headers?: Record<string, string> | Headers | [string, string][],

    /**
     * Called when a response is received. Use this to validate that the response
     * actually matches what you expect (and throw if it doesn't.) If not provided,
     * will default to a basic validation to ensure the content-type is text/event-stream.
     * May be async.
     */
    onopen?: (response: Response) => void | Promise<void>,

    /**
     * Called when a message is received. NOTE: Unlike the default browser
     * EventSource.onmessage, this callback is called for _all_ events,
     * even ones with a custom `event` field.
     */
    onmessage?: (ev: EventSourceMessage) => void;

    /**
     * Called when a response finishes. If you don't expect the server to kill
     * the connection, you can throw an exception here and retry using onerror.
     * May be async; an error thrown from the async callback is routed to
     * onerror just like a sync one.
     */
    onclose?: () => void | Promise<void>;

    /**
     * Called when there is any error making the request / processing messages /
     * handling callbacks etc. Use this to control the retry strategy: if the
     * error is fatal, rethrow the error inside the callback to stop the entire
     * operation. Otherwise, you can return an interval (in milliseconds) after
     * which the request will automatically retry (with the last-event-id).
     * If this callback is not specified, or it returns undefined, fetchEventSource
     * will treat every error as retriable and will try again after 1 second.
     * With the default onopen, a 204 response stops reconnection: onerror is
     * still called once (any returned interval is ignored), no onclose is
     * emitted, and the returned promise then rejects with the stop error.
     */
    onerror?: (err: any) => number | null | undefined | void,

    /**
     * If true, will keep the request open even if the document is hidden.
     * By default, fetchEventSource will close the request and reopen it
     * automatically when the document becomes visible again.
     */
    openWhenHidden?: boolean;

    /** The Fetch function to use. Defaults to globalThis.fetch */
    fetch?: typeof fetch;
}

export function fetchEventSource(input: RequestInfo, {
    signal: inputSignal,
    headers: inputHeaders,
    onopen: inputOnOpen,
    onmessage,
    onclose,
    onerror,
    openWhenHidden,
    fetch: inputFetch,
    ...rest
}: FetchEventSourceInit) {
    // if the input signal is already aborted, don't make any requests to begin with:
    if (inputSignal?.aborted) {
        return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
        // normalize all three accepted header forms into one working copy with
        // lowercased keys and comma-joined duplicate values, matching the
        // Headers append/combine semantics; the copy (not the caller's input)
        // is mutated with the last-event-id header on retries. We check for a
        // global Headers constructor before using it: schemas such as
        // fetch polyfills may provide fetch without it, and instances from
        // other realms fail instanceof anyway:
        // null prototype so header names like `constructor` or `__proto__`
        // (e.g. from a JSON.parse'd config) are stored as plain own
        // properties instead of hitting the prototype chain:
        let headers: Record<string, string> = Object.create(null);
        const setHeader = (key: string, value: string) => {
            key = key.toLowerCase();
            headers[key] = key in headers ? `${headers[key]}, ${value}` : value;
        };
        if (Array.isArray(inputHeaders)) {
            inputHeaders.forEach(([key, value]) => setHeader(key, value));
        } else if (typeof Headers !== 'undefined' && inputHeaders instanceof Headers) {
            // Headers#forEach passes (value, key); normalize to (key, value):
            inputHeaders.forEach((value: string, key: string) => setHeader(key, value));
        } else if (inputHeaders && typeof (inputHeaders as any).forEach === 'function') {
            // duck-typed Headers-like (polyfills, other realms) follow the same
            // Headers#forEach (value, key) contract:
            (inputHeaders as any).forEach((value: any, key: any) => setHeader(key, value));
        } else {
            Object.keys(inputHeaders ?? {}).forEach((key) => setHeader(key, (inputHeaders as any)[key]));
        }
        if (!headers.accept) {
            headers.accept = EventStreamContentType;
        }

        let curRequestController: AbortController;
        function onVisibilityChange() {
            curRequestController.abort(); // close existing request on every visibility change
            if (!globalThis.document?.hidden) {
                create(); // page is now visible again, recreate request.
            }
        }

        if (!openWhenHidden) {
            globalThis.document?.addEventListener('visibilitychange', onVisibilityChange);
        }

        let retryInterval = DefaultRetryInterval;
        let retryTimer = 0;
        let stopReconnecting = false;
        function dispose() {
            globalThis.document?.removeEventListener('visibilitychange', onVisibilityChange);
            inputSignal?.removeEventListener('abort', onAbort);
            globalThis.clearTimeout(retryTimer);
            curRequestController.abort();
        }

        // if the incoming signal aborts, dispose resources and resolve:
        function onAbort() {
            dispose();
            resolve(); // don't waste time constructing/logging errors
        }
        inputSignal?.addEventListener('abort', onAbort);

        const fetch = inputFetch ?? globalThis.fetch;
        const onopen = inputOnOpen ?? defaultOnOpen;
        async function create() {
            // close any previous, errored request before retrying, so it
            // doesn't stay open in the background:
            curRequestController?.abort();
            // capture this attempt's own controller so the error handler below
            // can't be confused by a newer attempt racing ahead of this one:
            const currentController = new AbortController();
            curRequestController = currentController;
            try {
                // a Request body can only be read once, so each attempt gets
                // its own clone of the input (the original is never consumed,
                // which previously made non-GET retries fail permanently with
                // "body used already"). Check the constructor exists first:
                // some fetch polyfills provide fetch without Request:
                const attemptInput = typeof Request !== 'undefined' && input instanceof Request
                    ? input.clone()
                    : input;
                const response = await fetch(attemptInput, {
                    ...rest,
                    headers,
                    signal: currentController.signal,
                });

                // per the spec, a 204 response tells the client to stop reconnecting:
                if (!inputOnOpen && response.status === 204) {
                    stopReconnecting = true;
                    throw new Error('Received a 204 response; per spec the client stops reconnecting');
                }

                // native EventSource reconnects to the final URL after
                // redirects; only string inputs are self-sufficient (a Request
                // input would lose its method/body this way):
                if (typeof input === 'string' && response.url && response.url !== input) {
                    input = response.url;
                }

                await onopen(response);

                await getBytes(response, getLines(getMessages(id => {
                    if (id) {
                        // store the id and send it back on the next retry:
                        headers[LastEventId] = id;
                    } else {
                        // don't send the last-event-id header anymore:
                        delete headers[LastEventId];
                    }
                }, retry => {
                    retryInterval = retry;
                }, onmessage)));

                await onclose?.();
                dispose();
                resolve();
            } catch (err) {
                if (!currentController.signal.aborted) {
                    // if we haven't aborted the request ourselves:
                    if (stopReconnecting) {
                        // the server told us to stop reconnecting (204):
                        dispose();
                        try {
                            // surface the stop to onerror-centric callers who do
                            // not await the returned promise; the interval it
                            // may return is meaningless (no retry follows):
                            onerror?.(err);
                        } catch (stopErr) {
                            // an onerror that throws overrides the outcome:
                            err = stopErr;
                        }
                        reject(err);
                        return;
                    }
                    try {
                        // check if we need to retry:
                        const interval: any = onerror?.(err) ?? retryInterval;
                        globalThis.clearTimeout(retryTimer);
                        retryTimer = globalThis.setTimeout(create, interval);
                    } catch (innerErr) {
                        // we should not retry anymore:
                        dispose();
                        reject(innerErr);
                    }
                }
            }
        }

        create();
    });
}

function defaultOnOpen(response: Response) {
    // per the EventSource spec, a SSE connection is only established over a
    // 200 response with the text/event-stream MIME type; MIME types are
    // compared by their case-insensitive essence (ignoring parameters):
    const contentType = response.headers.get('content-type');
    const essence = contentType?.split(';')[0]?.trim()?.toLowerCase();
    if (response.status !== 200 || essence !== EventStreamContentType) {
        throw new Error(`Expected a 200 response with a ${EventStreamContentType} content-type, got status ${response.status} and content-type ${contentType ?? 'none'}`);
    }
}

import { EventSourceMessage, getBytes, getLines, getMessages } from './parse';

export const EventStreamContentType = 'text/event-stream';

const DefaultRetryInterval = 1000;
const LastEventId = 'last-event-id';

/**
 * Any of the request-header input shapes this library and fetch() accept.
 */
type HeadersSource = Record<string, string> | Headers | [string, string][];

export interface FetchEventSourceInit extends Omit<RequestInit, 'headers'> {
    /**
     * The request headers. Supports the Record<string,string>, Headers and
     * string-pair-array formats; all are normalized into a copy (lowercased
     * keys, duplicates comma-joined like Header.append) which is then mutated
     * with the last-event-id header on retries.
     *
     * A function may be given instead, evaluated once per (re)connection, so
     * values are computed fresh per attempt (e.g. tokens that rotate while the
     * connection lives). It may return any accepted format, synchronously or
     * as a promise. A tracked last event id from previous attempts always
     * wins over whatever the function returns for `last-event-id`, per the
     * SSE spec.
     */
    headers?: HeadersSource | (() => HeadersSource | Promise<HeadersSource>),

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

    /**
     * How long to wait between automatic retries, in ms (default 1000).
     * Intervals returned from onerror always take precedence over this value.
     */
    retryIntervalMs?: number;

    /**
     * Optional cap for exponential backoff between automatic retries. When
     * set, every consecutive automatic retry doubles the base interval
     * (retryIntervalMs → 2x → 4x → …) until the cap is reached; the interval
     * resets to its base once a connection is successfully established again
     * (onopen resolves). Intervals explicitly returned from onerror are
     * honored as given and never fed into the backoff. A server-sent
     * `retry:` field value replaces the whole automatic schedule in turn
     * and stays in effect until the server sends a different one.
     */
    maxRetryIntervalMs?: number;

    /**
     * Close-and-retry the current attempt when no bytes (not even comment
     * heartbeats) have arrived for this long, in ms. Reverse proxies and dead
     * networks can kill a connection without signaling it; a stall like that
     * is treated as a retriable error and routed through onerror. The idle
     * timer runs only while the body stream is being read (i.e. after onopen
     * resolved); a stalled handshake is better handled by combining
     * `AbortSignal.timeout` into the init `signal`. Disabled by default: a
     * silent SSE server is legal, so no timer exists unless you ask for one.
     */
    idleTimeoutMs?: number;

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
    retryIntervalMs: inputRetryIntervalMs,
    maxRetryIntervalMs,
    idleTimeoutMs,
    fetch: inputFetch,
    ...rest
}: FetchEventSourceInit) {
    // if the input signal is already aborted, don't make any requests to begin with:
    if (inputSignal?.aborted) {
        return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
        // The last event id observed on the current stream, sent back as the
        // last-event-id header of the next attempt and cleared again when the
        // server resets the id. Tracked separately from the caller's headers:
        // header inputs are normalized fresh per (re)connection (see create),
        // so state has to survive into the new copies:
        let lastEventId = '';

        // The server-controlled reconnection time, set by `retry:` field
        // values and honored until the server sends a different one:
        let serverRetryInterval: number | undefined;

        // next automatic retry interval for exponential backoff: it grows only
        // while maxRetryIntervalMs is configured, caps there, and resets to
        // the base whenever a connection is successfully established:
        const baseRetryInterval = inputRetryIntervalMs ?? DefaultRetryInterval;
        let backoffNext = baseRetryInterval;

        let retryTimer = 0;
        let stopReconnecting = false;

        // (re)normalize a header input into a fresh null-prototype working
        // copy with lowercased keys and comma-joined duplicate values,
        // matching the Headers append/combine semantics; the copy (not the
        // caller's input) is then mutated with the last-event-id header of
        // the attempt. We check for a global Headers constructor before
        // using it: schemas such as fetch polyfills may provide fetch
        // without it, and instances from other realms fail instanceof anyway;
        // the null prototype keeps header names like `constructor` or
        // `__proto__` (e.g. from a JSON.parse'd config) stored as plain own
        // properties instead of hitting the prototype chain:
        function normalizeHeaders(input: HeadersSource | undefined | null): Record<string, string> {
            const copy = Object.create(null);
            const setHeader = (key: string, value: string) => {
                key = key.toLowerCase();
                copy[key] = key in copy ? `${copy[key]}, ${value}` : value;
            };
            if (Array.isArray(input)) {
                input.forEach(([key, value]) => setHeader(key, value));
            } else if (typeof Headers !== 'undefined' && input instanceof Headers) {
                // Headers#forEach passes (value, key); normalize to (key, value):
                input.forEach((value: string, key: string) => setHeader(key, value));
            } else if (input && typeof (input as any).forEach === 'function') {
                // duck-typed Headers-like (polyfills, other realms) follow the
                // same Headers#forEach (value, key) contract:
                (input as any).forEach((value: any, key: any) => setHeader(key, value));
            } else {
                Object.keys(input ?? {}).forEach((key) => setHeader(key, (input as any)[key]));
            }
            if (!copy.accept) {
                copy.accept = EventStreamContentType;
            }
            return copy;
        }

        function scheduleRetry(err: any) {
            globalThis.clearTimeout(retryTimer);
            // explicit, per-error intervals returned from onerror take
            // precedence and are never fed into the backoff; the automatic
            // path also prefers a server-sent `retry:` interval, if the
            // server has sent one:
            let explicit: number | null | undefined;
            try {
                // onerror may return void (the callback equivalent of leaving
                // the automatic path); fold that into the interval union:
                explicit = onerror?.(err) as number | null | undefined;
            } catch (onerrorErr) {
                // an onerror that throws means we should not retry anymore:
                dispose();
                reject(onerrorErr);
                return;
            }
            const interval = explicit === undefined || explicit === null
                ? (serverRetryInterval ?? backoffNext)
                : explicit;
            retryTimer = globalThis.setTimeout(create, interval);
            // only automatic retries ramp up, capped at the configured maximum:
            if (explicit == null && maxRetryIntervalMs != null) {
                backoffNext = Math.min(backoffNext * 2, maxRetryIntervalMs);
            }
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
            // per-attempt idle-stall machinery: attempt-scoped state dies with
            // its attempt, the fire callback aborts only this attempt's own
            // controller, and the finally-clear below keeps a stale timer from
            // ever firing into a later attempt:
            let idleTimer = 0;
            let idleFired = false;
            const resetIdle = () => {
                if (!idleTimeoutMs) {
                    return;
                }
                globalThis.clearTimeout(idleTimer);
                idleTimer = globalThis.setTimeout(() => {
                    idleFired = true;
                    currentController.abort(new DOMException(`No bytes received for ${idleTimeoutMs}ms`, 'TimeoutError'));
                }, idleTimeoutMs);
            };
            try {
                // a Request body can only be read once, so each attempt gets
                // its own clone of the input (the original is never consumed,
                // which previously made non-GET retries fail permanently with
                // "body used already"). Check the constructor exists first:
                // some fetch polyfills provide fetch without Request:
                const attemptInput = typeof Request !== 'undefined' && input instanceof Request
                    ? input.clone()
                    : input;
                // headers are normalized per attempt: given a function, its
                // values must be computed fresh for each (re)connection, and
                // the fresh copy carries the tracked last event id so
                // successive attempts stay spec-correct:
                const headers = normalizeHeaders(
                    typeof inputHeaders === 'function'
                        ? await inputHeaders()
                        : inputHeaders,
                );
                if (lastEventId) {
                    // the server-assigned id governs: it always wins over
                    // whatever the caller supplied for the same field:
                    headers[LastEventId] = lastEventId;
                }
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

                // a successful reconnection resets the backoff schedule:
                backoffNext = baseRetryInterval;

                // every arriving block of bytes re-arms the idle timer, whether
                // or not it parses into a full message (comment heartbeats
                // count as connectivity):
                const linesChunk = getLines(getMessages(id => {
                    if (id) {
                        lastEventId = id;
                    } else {
                        lastEventId = '';
                    }
                }, retry => {
                    serverRetryInterval = retry;
                }, onmessage));
                const onChunk = (arr: Uint8Array) => {
                    resetIdle();
                    linesChunk(arr);
                };

                // arm the idle detector just ahead of the byte read, so the
                // opening-to-first-byte gap is covered too:
                resetIdle();
                await getBytes(response, onChunk);

                await onclose?.();
                dispose();
                resolve();
            } catch (err) {
                if (currentController.signal.aborted && !idleFired) {
                    // aborted from the outside: a caller abort (disposed and
                    // resolved elsewhere), a visibility switch (create() is
                    // coming), or a superseded attempt (the newer attempt
                    // aborted this one). None of these schedule anything:
                    return;
                }
                if (idleFired && curRequestController !== currentController) {
                    // an idle timer that outlived its attempt must not inject
                    // a retry into a newer attempt's schedule (the finally
                    // below clears the pending timer, but an already-firing
                    // callback can race an abort like any timeout callback):
                    return;
                }
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
                scheduleRetry(err);
            } finally {
                globalThis.clearTimeout(idleTimer);
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

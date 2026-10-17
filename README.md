# Fetch Event Source

> **Maintained fork.** The upstream [`@microsoft/fetch-event-source`](https://github.com/Azure/fetch-event-source) is archived and receives no further releases; this repo continues it and publishes on npm as [`@coderminer/fetch-event-source`](https://www.npmjs.com/package/@coderminer/fetch-event-source). It ships a batch of SSE/fetch spec-conformance and robustness fixes on top of the last upstream release — see the [changelog](CHANGELOG.md).

This package provides a better API for making [Event Source requests](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events) - also known as server-sent events - with all the features available in the [Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API).

The [default browser EventSource API](https://developer.mozilla.org/en-US/docs/Web/API/EventSource) imposes several restrictions on the type of request you're allowed to make: the [only parameters](https://developer.mozilla.org/en-US/docs/Web/API/EventSource/EventSource#Parameters) you're allowed to pass in are the `url` and `withCredentials`, so:
* You cannot pass in a request body: you have to encode all the information necessary to execute the request inside the URL, which is [limited to 2000 characters](https://stackoverflow.com/questions/417142) in most browsers.
* You cannot pass in custom request headers
* You can only make GET requests - there is no way to specify another method.
* If the connection is cut, you don't have any control over the retry strategy: the browser will silently retry for you a few times and then stop, which is not good enough for any sort of robust application.

This library provides an alternate interface for consuming server-sent events, based on the Fetch API. It is fully compatible with the [Event Stream format](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events#Event_stream_format), so if you already have a server emitting these events, you can consume it just like before. However, you now have greater control over the request and response so:

* You can use any request method/headers/body, plus all the other functionality exposed by fetch(). You can even provide an alternate fetch() implementation, if the default browser implementation doesn't work for you.
* You have access to the response object if you want to do some custom validation/processing before  parsing the event source. This is useful in case you have API gateways (like nginx) in front of your application server: if the gateway returns an error, you might want to handle it correctly.
* If the connection gets cut or an error occurs, you have full control over the retry strategy.

In addition, this library also plugs into the browser's [Page Visibility API](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API) so the connection closes if the document is hidden (e.g., the user minimizes the window), and automatically retries with the last event ID when it becomes visible again. This reduces the load on your server by not having open connections unnecessarily (but you can opt out of this behavior if you want.)

The opt-out is `openWhenHidden: true`. The mechanics: without it, hiding the page closes the in-flight attempt and nothing opens until the page becomes visible again, at which point a fresh connection starts with the stored `last-event-id` (so no events are missed, only buffered client-side history is replayed by your server if it implements retransmission). With it, the stream keeps streaming behind hidden pages — useful for non-idempotent requests and for connections that must not reset, at the usual battery/network cost.

# Install
```sh
npm install @coderminer/fetch-event-source
```

# Usage
```ts
// BEFORE:
const sse = new EventSource('/api/sse');
sse.onmessage = (ev) => {
    console.log(ev.data);
};

// AFTER:
import { fetchEventSource } from '@coderminer/fetch-event-source';

await fetchEventSource('/api/sse', {
    onmessage(ev) {
        console.log(ev.data);
    }
});
```

You can pass in all the [other parameters](https://developer.mozilla.org/en-US/docs/Web/API/WindowOrWorkerGlobalScope/fetch#Parameters) exposed by the default fetch API, for example:
```ts
const ctrl = new AbortController();
fetchEventSource('/api/sse', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
    },
    body: JSON.stringify({
        foo: 'bar'
    }),
    signal: ctrl.signal,
});
```

You can add better error handling, for example:
```ts
class RetriableError extends Error { }
class FatalError extends Error { }

fetchEventSource('/api/sse', {
    async onopen(response) {
        if (response.ok && response.headers.get('content-type') === EventStreamContentType) {
            return; // everything's good
        } else if (response.status >= 400 && response.status < 500 && response.status !== 429) {
            // client-side errors are usually non-retriable:
            throw new FatalError();
        } else {
            throw new RetriableError();
        }
    },
    onmessage(msg) {
        // if the server emits an error message, throw an exception
        // so it gets handled by the onerror callback below:
        if (msg.event === 'FatalError') {
            throw new FatalError(msg.data);
        }
    },
    onclose() {
        // if the server closes the connection unexpectedly, retry:
        throw new RetriableError();
    },
    onerror(err) {
        if (err instanceof FatalError) {
            throw err; // rethrow to stop the operation
        } else {
            // do nothing to automatically retry. You can also
            // return a specific retry interval here.
        }
    }
});
```

# Dynamic request headers

If header values must be computed at connection time — tokens that rotate, signatures, anything that goes stale — pass a function instead of a plain value. It is evaluated once per (re)connection — that is, for every attempt including retries — and may return any accepted header format, synchronously or as a promise:

```ts
fetchEventSource('/api/sse', {
    headers: async () => ({ authorization: `Bearer ${await getToken()}` }),
    // ...
});
```

The `last-event-id` header that retries send back is managed by the library. From the attempt after the server first sends an `id:` field, the tracked value governs: a non-empty id wins over any caller-supplied value for that field (per the SSE spec), and an empty `id:` field is an explicit reset that removes the header entirely.

# Retry scheduling and dead-connection detection

By default, automatic retries happen 1000ms after the previous attempt failed. Two options tune that schedule:

* `retryIntervalMs` — the base interval between automatic retries (default `1000`). Intervals returned from `onerror` always take precedence. The interval the server sends in a `retry:` field replaces the automatic schedule and, per the SSE spec, persists across reconnections until the server sends a different value.
* `maxRetryIntervalMs` — turns every consecutive automatic retry into an exponential ramp (`retryIntervalMs` → 2× → 4× → …) capped at this value; the clamp applies from the very first retry, so a cap below the base governs there too. The ramp resets to the base — or to the cap when the cap is lower — each time a connection is successfully established again, and intervals explicitly returned from `onerror` are never fed into it.

Beyond explicit failures, some proxies and dead networks terminate a connection *silently* — no FIN, no error, just silence. With SSE that means the promise never resolves and no callback ever fires. `idleTimeoutMs` catches that:

```ts
fetchEventSource('/api/sse', {
    idleTimeoutMs: 30000, // 30 seconds without ANY bytes (heartbeats count) →
                          // treat as a retriable error and route it through onerror
    onerror(err) {
        if (err instanceof DOMException && err.name === 'TimeoutError') {
            // the connection went silent: decide whether to keep listening
        }
    },
});
```

The timer runs only while the response body is being read (after `onopen` resolved), counts any incoming bytes — including comment-line heartbeats — and is disabled by default (a silent server is legal SSE). Pass a positive number: `0` and any non-finite value (`NaN`, `Infinity`) disable the timer — `setTimeout` would clamp `Infinity` to ~0ms otherwise — while a negative value is honored as a ~0ms timer that aborts every attempt almost immediately. A handshake that never even produces a response is out of the idle timer's scope. To time-box ONLY the handshake, arm a caller-side deadline and clear it in `onopen` — note this replaces the default response validation, so its checks move into your `onopen`:

```ts
const controller = new AbortController();
const handshakeTimer = setTimeout(
    () => controller.abort(new DOMException('No response within 5s', 'TimeoutError')),
    5000,
);

fetchEventSource('/api/sse', {
    signal: controller.signal,
    onopen(response) {
        clearTimeout(handshakeTimer); // response arrived: the handshake is over
        // this custom onopen replaced the default validation: keep its exact
        // semantics — the MIME essence, compared case-insensitively:
        const essence = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
        if (response.status !== 200 || essence !== 'text/event-stream') {
            throw new Error('not an SSE stream');
        }
    },
    // ...
});
```

`AbortSignal.timeout(5000)` as the init signal is the one-liner version — but it caps the ENTIRE connection lifetime (healthy long streams included) and cannot be canceled once armed; use it only when that lifetime cap is what you want. Either deadline can coexist with a caller-controlled abort on modern runtimes via `AbortSignal.any` — available from Chrome 116+, Firefox 124+, Safari 17.4+ and Node.js 18.17+/20.3+ (feature-detect it: `typeof AbortSignal.any === 'function'`). On older runtimes, forward the timeout's abort into the caller's controller instead:

```ts
const controller = new AbortController();
const timeout = AbortSignal.timeout(5000);
timeout.addEventListener('abort', () => controller.abort(timeout.reason), { once: true });
// ...then pass controller.signal as the init signal
```

Two engine notes. First, `idleTimeoutMs` routes its stall through `onerror` as the attempt's abort `err` — on engines without abort-reason support (Chrome < 98, Firefox < 97, Safari < 15.4) that `err` arrives as a plain `AbortError` instead of a `TimeoutError` DOMException; retries are unaffected either way, since the library never inspects the error type. Second, the caller-side deadlines above never reach `onerror` at all — a caller abort resolves the promise — and on those same engines every abort reason, including `timeout.reason` in the forwarding snippet above, degenerates into a generic `AbortError`, so an observing listener cannot distinguish a timeout from a manual abort; the connection still closes either way.

# Running under Node.js

The library keeps to `globalThis` with optional-chained `document` access, so it runs unchanged on Node.js 18+ (undici's fetch and streams); without a DOM there is no visibility switching, and the other semantics are identical. Workers, extension scripts, and non-stream-polyfill environments are covered by the same rules as the browser bundles.

# Compatibility
This library is written in typescript and targets ES2017 features supported by all evergreen browsers (Chrome, Firefox, Safari, Edge.) You might need to [polyfill TextDecoder](https://www.npmjs.com/package/fast-text-encoding) for old Edge (versions < 79), though:
```js
require('fast-text-encoding');
```

It also works from web workers and extension background/service scripts: DOM APIs are accessed through `globalThis` with optional chaining, and hidden-tab auto-retry is skipped when no `document` exists.

Known limitations for retries: retried connections replay the original request. For non-GET requests that carry state or a one-time body, the default auto-retry/auto-reopen (on error or tab switch) can duplicate side effects on the server — provide an `onerror` callback (throw to stop) and consider `openWhenHidden: true` for these requests.

Abort semantics: `abort()` on the provided signal stops the connection and **resolves** the returned promise without calling `onclose` or `onerror` (the promise never rejects on abort). To react to an abort, add a listener on the signal itself. Aborting works at any phase — during the handshake, mid-stream, or while a retry timer is pending; the in-flight attempt is cancelled immediately and no retry is scheduled afterwards. This is also the close mechanism: there is no separate `close()` API — to end the connection from your side, keep the `AbortController` and call `abort()`.

204 semantics: when using the default `onopen`, a `204` response means the server told the client to stop reconnecting. The connection is dropped, `onerror` is invoked once (its returned retry interval is ignored, an error thrown from it overrides the rejection), `onclose` is **not** fired, and the returned promise **rejects** with the stop error. With a custom `onopen`, a 204 is whatever your callback decides it to be.

# Contributing

Contributions are welcome! For significant changes, please open an issue first so we can agree on the approach. `npm test` is the gate for every change: it builds both the CJS and ESM outputs, runs the spec suite with coverage over the compiled library, and fails on leftover editor/automation debris in the sources or docs. See [CONTRIBUTING.md](CONTRIBUTING.md) for the detailed workflow.

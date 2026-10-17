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

# Compatibility
This library is written in typescript and targets ES2017 features supported by all evergreen browsers (Chrome, Firefox, Safari, Edge.) You might need to [polyfill TextDecoder](https://www.npmjs.com/package/fast-text-encoding) for old Edge (versions < 79), though:
```js
require('fast-text-encoding');
```

It also works from web workers and extension background/service scripts: DOM APIs are accessed through `globalThis` with optional chaining, and hidden-tab auto-retry is skipped when no `document` exists.

Known limitations for retries: retried connections replay the original request. For non-GET requests that carry state or a one-time body, the default auto-retry/auto-reopen (on error or tab switch) can duplicate side effects on the server — provide an `onerror` callback (throw to stop) and consider `openWhenHidden: true` for these requests.

Abort semantics: `abort()` on the provided signal stops the connection and **resolves** the returned promise without calling `onclose` or `onerror` (the promise never rejects on abort). To react to an abort, add a listener on the signal itself. Aborting works at any phase — during the handshake, mid-stream, or while a retry timer is pending; the in-flight attempt is cancelled immediately and no retry is scheduled afterwards.

204 semantics: when using the default `onopen`, a `204` response means the server told the client to stop reconnecting. The connection is dropped, `onerror` is invoked once (its returned retry interval is ignored, an error thrown from it overrides the rejection), `onclose` is **not** fired, and the returned promise **rejects** with the stop error. With a custom `onopen`, a 204 is whatever your callback decides it to be.

# Contributing

Contributions are welcome! For significant changes, please open an issue first so we can agree on the approach. `npm test` is the gate for every change: it builds both the CJS and ESM outputs, runs the spec suite with coverage over the compiled library, and fails on leftover editor/automation debris in the sources or docs. See [CONTRIBUTING.md](CONTRIBUTING.md) for the detailed workflow.

# CHANGELOG

## 2.0.2
### Fixed
- **Parsing:** empty `data:` fields are now preserved per [the spec](https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation); previously consecutive empty data fields collapsed into nothing (see #50, #65, #104)
- **Parsing:** fixed the TypeScript >= 4.6 build error `Cannot find name 'ReadableStreamDefaultReadResult'` (see #52, #72)
- **Parsing/Polyfills:** `getBytes` no longer assumes `response.body` is a `ReadableStream`; fetch polyfills (e.g. mobile webviews) that lack a stream body now fall back to `response.arrayBuffer()` (see #61)
- **Retries/Abort:** a caller-provided `AbortSignal` that was already aborted now skips the request entirely instead of opening an orphaned connection (see #106)
- **Retries/Abort:** fixed a race condition where an aborted attempt's error handler inspected the wrong `AbortController`, causing duplicate connections when quickly switching tabs (see #94/#95)
- **Retries/Abort:** aborted connections are now closed before scheduling a retry, preventing leaked streams (see #7)
- **Retries/Abort:** errors thrown from an **async** `onclose` are now awaited and routed through `onerror` like sync errors (see #90)
- **Retries/Abort:** the caller's `AbortSignal` listener is removed once the connection ends, so long-lived signals no longer accumulate a listener per connection
- **Retries:** `Request` inputs are cloned per attempt; retried connections no longer fail permanently with "body already used" when the caller passes a body-carrying `Request`
- **Headers:** `Headers` and `[string, string][]` header inputs are normalized instead of silently disappearing in the object spread (see #37); the type now accepts all three forms
- **Parsing:** `retry:` is only honored for all-ASCII-digit values per the spec (`retry: 42abc` / `retry:  42` were previously parsed leniently via `parseInt`; native `EventSource` ignores them)
- **Compat:** `onopen` may now be sync (`void | Promise<void>`, it was already awaited; see #31), and built `.d.ts` files keep interface documentation (`removeComments: false`, see #56)
- **Compat:** standardized on `globalThis` and optionally chained `document` access, enabling use from web workers and extension background scripts even with default options (see #8, #21, #41, #71)
- **Packaging:** npm package now ships `src/` so the bundled (but previously unresolvable) sourcemaps work instead of producing bundler warnings (see #18, #105); spec build outputs are excluded per the existing intent

### Changed
- Restored the missing `npm test` script and `jasmine`/`nyc` devDependencies that were accidentally removed in the v2.0.1 "dependabot fix"; `npm test` now runs a build first
- CI pins action SHAs (#108), adds a Dependabot config, and runs on Node 18.x/20.x (the lockfile is lockfileVersion 2, which npm 6 on Node 12/14 cannot install)

## 2.0.1
This release adds support for esmodule imports (see #4).

## 2.0.0
This release improves the performance of parsing the response stream and fixes some corner cases to better match [the spec](https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation).

### Changed
- The `id`, `event`, and `data` fields are now initialized to empty strings, per the spec (they were previously `undefined`)
- The `onmessage` callback is now called for _all_ messages (it was previously triggered only for messages with a `data` field)
- If a message contains multiple `data` fields, they will be concatenated together into a single string. For example, the following message:
    ````
    data: Foo
    data:Bar
    data
    data: Baz
    ````
    will result in `{ data: 'Foo\nBar\n\nBaz' }`

- If the server sends an `id` field with an empty value, the last-event-id header will no longer be sent on the next reconnect.

### Removed
- The internal `parseStream` function has been removed. The parse implementation was previously based on async generators, which required a lot of supporting code in both the typescript-generated polyfill as well as the javascript engine. The new implementation is based on simple callbacks, which should be much faster.

## 1.0.2
### Changed
- Updated examples in readme to fix typos, added more comments.
- Changed `if` statements in parse.ts to test for specific values instead of truthy/falsy values.

## 1.0.1
### Changed
- Changed the default onOpen validator to allow charset and boundary directives in the content-type

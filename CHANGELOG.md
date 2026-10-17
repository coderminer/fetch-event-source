# CHANGELOG

## 3.1.0
### Added
- **Headers:** `headers` also accepts a function, evaluated once per (re)connection so values are computed fresh per attempt (rotating tokens etc.); it may return any accepted header format, synchronously or as a promise. The tracked `last-event-id` of the previous stream always wins over the function's value for that field, per the SSE spec (see #33, upstream PR #67)
- **Retries:** `retryIntervalMs` (default 1000 — behavior unchanged when unset) and `maxRetryIntervalMs`, which turns consecutive automatic retries into an exponential ramp capped at that value; the ramp resets after each successful reconnection. Intervals explicitly returned from `onerror` take precedence and are never fed into the backoff; a server-sent `retry:` field value replaces the automatic schedule and, per the SSE spec, persists across reconnections until the server sends a different value (see #57, upstream PR #63)
- **Liveness:** `idleTimeoutMs` closes and retries the current attempt when no bytes — not even comment-line heartbeats — arrive for that long, routing the stall through the standard `onerror` path as a `TimeoutError`; the timer runs only while the body stream is read and is disabled by default, since a silent server is legal SSE (see #79, #73, #30, #17)
- Node.js 18+ support is now documented (`engines` field added; the code was already `globalThis`-based and runs on undici)

### Changed
- `FetchEventSourceInit` extends `Omit<RequestInit, 'headers'>` so the function form does not fight the DOM `HeadersInit` type
- README: connection-lifecycle guidance (abort *is* the close mechanism), `openWhenHidden` mechanics, per-attempt header evaluation, retry scheduling and the mapped issue links above

### Fixed
- **Aborting inside `onerror` no longer leaks connections:** the abort resolves the whole operation (via the caller signal), but `scheduleRetry` could still arm a retry (or leave one armed) afterwards, spawning connections nobody owns — most easily triggered now that `idleTimeoutMs` hands a `TimeoutError` to `onerror` and the README documents abort as the close mechanism. `scheduleRetry` refuses to arm when the input signal is aborted, and `create()` re-checks the signal on entry (a retry timer armed pre-abort can never open a connection)
- **`last-event-id` no longer resurrects after a server reset:** 3.0.x deleted the header when the server sent an empty `id:` field, but the per-attempt normalization reintroduced the caller's (static or headers-function) value on later attempts. The tracked id is now three-state: the caller's value passes through until the first server `id:`; a non-empty id wins per the SSE spec; an empty `id:` deletes the header on the next attempt (+specs)
- **Hidden pages no longer reconnect:** a retry timer could fire while `document.hidden`, and a stale timer could abort the healthy connection the visible-edge handler just created. `onVisibilityChange` clears any pending retry timer; nothing connects while hidden, and the visible edge opens the next attempt exactly once
- **`idleTimeoutMs: Infinity` disabled-fix:** `setTimeout` clamps `Infinity` (and huge values) to ~0/1ms with a `TimeoutOverflowWarning`, arming an instant-abort timer; the timer now requires a finite positive value
- **`maxRetryIntervalMs` below the base applies from the first automatic retry** (previously the first retry could exceed the cap; the ramp resets to the capped base as well)
- Docs honesty pass: the handshake-deadline example explains that `AbortSignal.timeout` caps the *whole* connection and shows the onopen-cleared caller-side alternative instead; `AbortSignal.any` availability lists Node.js 18.17+; old engines without abort reasons get the `AbortError`-vs-`TimeoutError` caveat; stale `onerror` JSDoc ("after 1 second") refreshed

## 3.0.1
- **Packaging:** published 3.0.0 carried no `keywords` field (the work landed after its publish); this patch release exists purely to ship it — add npm discoverability keywords (`eventsource`, `server-sent-events`, `sse`, `fetch`, `streaming`, `fetch-event-source`, ...). No functional changes.

## 3.0.0
First release of the maintained community fork, published as [`@coderminer/fetch-event-source`](https://www.npmjs.com/package/@coderminer/fetch-event-source). The upstream [`@microsoft/fetch-event-source`](https://github.com/Azure/fetch-event-source) is archived at 2.0.2 and receives no further releases; this fork ships that baseline plus every fix documented in the 2.0.2 section below (that work post-dates the last upstream publish and was never released under the upstream name), plus the packaging/coverage/hygiene modernization noted there.

The major-version bump signals observable behavior changes carried by the spec-conformance fixes — most notably: `204` responses stop reconnecting and reject the promise, the default `onopen` requires a strict `200` with `text/event-stream` essence, messages without any `data` field are no longer dispatched, and normalized header names are lowercased. There is no re-architecture; the public API surface is unchanged.

## 2.0.2
### Fixed
- **Parsing (spec):** a message whose data buffer is empty is no longer dispatched to `onmessage`, and the event-type buffer is still cleared, exactly as in the [dispatch step of the SSE spec](https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation); comment-only / id-only / retry-only blocks no longer fire `onmessage` with empty data (see #15)
- **Parsing (spec):** a line without a colon is now processed as a field whose name is the entire line and whose value is the empty string, per the spec (previously such lines were skipped entirely)
- **Parsing (spec):** an `id` field value containing U+0000 NULL is now ignored per the spec (previously it overwrote the stored id and was sent back as `Last-Event-ID`)
- **Parsing (spec):** the byte stream is decoded with a default spec-compliant `TextDecoder`, whose UTF-8 decode strips one leading BOM; chunks are buffered into whole lines before decoding, so the strip is correct even when the stream delivers the BOM in pieces; this end-to-end behavior (previously untested) is now pinned by tests, and `getBytes` relies on the decoder instead of a redundant explicit strip
- **Retries (spec):** a `204` response with the default `onopen` now stops reconnection and rejects the promise, per the spec's "re-establish for a 204 means the client stops reconnecting" rule; previously the client kept retrying every second against a server that told it to stop. `onerror` is still invoked (any returned retry interval is ignored, and an error thrown from it overrides the rejection) so unawaited, onerror-centric callers are notified; `onclose` is not fired. A custom `onopen` keeps full control as before
- **Retries (spec):** after a connection follows a redirect, string inputs are re-targeted at the final URL (`response.url`) for the next reconnection, matching native `EventSource`
- **Default onopen (spec):** now requires a `200` response (not merely any 2xx) and a content-type whose case-insensitive MIME essence is exactly `text/event-stream`, per the open-the-connection step of the spec; `text/event-stream;charset=utf-8` still passes, `text/event-stream/foo` and stray whitespace/parameter games no longer do
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
- **Headers:** all three header forms are normalized identically into one working copy — keys are lowercased and duplicate keys are comma-joined like `Headers.append` — so duplicate array-form values are no longer overwritten and an `Accept` key is matched case-insensitively against the built-in SSE accept header (a user value replaces it instead of merging)
- **Compat:** the normalization neither requires a global `Headers`/`Request` constructor to exist (fetch-only polyfills such as node-fetch-style setups now work with `headers: Headers`-free calls) nor breaks on `Headers` instances from another realm (duck-typed instead of a bare `instanceof`, also fixes #37's remaining scenario); the working copy uses a null prototype so JSON-derived header names like `constructor` or `__proto__` are plain own properties
- **Parsing:** `retry:` is only honored for all-ASCII-digit values per the spec (`retry: 42abc` / `retry:  42` were previously parsed leniently via `parseInt`; native `EventSource` ignores them)
- **Compat:** `onopen` may now be sync (`void | Promise<void>`, it was already awaited; see #31), and built `.d.ts` files keep interface documentation (`removeComments: false`, see #56)
- **Compat:** standardized on `globalThis` and optionally chained `document` access, enabling use from web workers and extension background scripts even with default options (see #8, #21, #41, #71)
- **Packaging:** npm package now ships `src/` so the bundled (but previously unresolvable) sourcemaps work instead of producing bundler warnings (see #18, #105); spec build outputs are excluded per the existing intent

### Changed
- Restored the missing `npm test` script and `jasmine`/`nyc` devDependencies that were accidentally removed in the v2.0.1 "dependabot fix"; `npm test` now runs a build first
- CI pins action SHAs (#108), adds a Dependabot config, and runs on Node 18.x/20.x (the lockfile is lockfileVersion 2, which npm 6 on Node 12/14 cannot install)
- `posttest` now scans the shipped sources/docs for automation tool-payload remnants (`scripts/check-tool-fragments.cjs`; it walks `src/` plus the docs so new files are covered automatically, honors inline `scan-exempt` markers, and cannot self-trigger); `scripts/` is not published and the literal-vs-glob `tsconfig.json` entry is fixed to `tsconfig*.json` so `tsconfig.esm.json` leaves the tarball too (`.npmignore`); `.nycrc` drops the legacy `all: true` sweep and excludes spec/`.d.ts`/`.cjs` artifacts so coverage totals reflect the library source only
- a smoke spec imports `./index` so the public re-export barrel stays inside the execution path and coverage (new value exports must deliberately update its assertion)

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

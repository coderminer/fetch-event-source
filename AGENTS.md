# AGENTS.md

Verified guidance for agents working on `@coderminer/fetch-event-source` — the maintained community fork of the (archived) `@microsoft/fetch-event-source` (single-package TypeScript library, ~4 source files, no monorepo, no lint/format config).

## Architecture
- Public API surface is only what `src/index.ts` re-exports: `fetchEventSource`, `EventStreamContentType`, `FetchEventSourceInit`, `EventSourceMessage`.
- `src/parse.ts` — pure SSE byte-stream parser (`getBytes`/`getLines`/`getMessages`), written to the WHATWG spec (empty `data:` fields append `\n`; one trailing `\n` stripped on dispatch; colon-less lines are fields with an empty value; `id` values containing U+0000 are ignored; messages with an empty data buffer are cleared, not dispatched; the byte stream is buffered by `getLines` into whole lines, each decoded by a default `TextDecoder` whose UTF-8 decode strips a leading BOM (it arrives complete in the first line even when chunks split it; no explicit BOM handling in `getBytes`). Fully covered by `src/parse.spec.ts`.
- `src/fetch.ts` — the fetch/retry loop. Written for browsers but keeps to `globalThis` with optional-chained `document` access, so it also runs in web workers / extension scripts and under Node test runners. Covered by `src/fetch.spec.ts` (uses stub fetches, no real network).
- Abort/retry invariants to preserve when editing `fetch.ts`:
  1. Skip everything up front if the caller's `AbortSignal` is already aborted.
  2. Each `create()` attempt captures its `currentController` closure-local and the catch checks THAT controller, not the shared `curRequestController` (visibility switching races).
  3. `create()` aborts the previous attempt's controller before opening a new one (no leaked streams on retry).
  4. `onclose` is awaited so async onclose errors reach `onerror`.
  5. `dispose()` also removes the caller's abort listener (`onAbort`) — long-lived shared signals would otherwise accumulate one listener per connection.
  6. Each attempt fetches a fresh `input.clone()` when the input is a `Request`, so retried connections never hit "body already used" and the original body is never consumed. The constructor is existence-checked (`typeof Request !== 'undefined'`) because fetch-only polyfills don't provide it.
  7. All three header forms are normalized once into a single lowercased, null-prototype Record with comma-joined duplicates (mirrors `Headers` semantics) without requiring the global `Headers` constructor; the `accept` default check and the `last-event-id` mutation operate on that copy. `Headers`-like inputs are matched by brand/duck-typing because instances from other realms fail `instanceof`; the null prototype keeps JSON-derived names like `constructor`/`__proto__` as plain own properties (asserted at the library's boundary — undici's own `Headers` drops `__proto__` end-to-end, platform behavior out of scope).
  8. With the default `onopen`, a `204` response sets `stopReconnecting` and throws, and the catch refuses to schedule a retry — per spec the server told the client to stop reconnecting. The stop path still calls `onerror` once (its interval is ignored; an error thrown from it overrides the rejection) but never `onclose`, then rejects the promise. After a successful response, string `input`s are re-targeted at `response.url` so reconnections follow redirects like native `EventSource`; the connection itself is established only when default validation (`response.status === 200` + `text/event-stream` MIME essence) passes.
- Dual output is required: `npm run build` compiles twice (CJS → `lib/cjs` via `tsconfig.json`, ESM → `lib/esm` via `tsconfig.esm.json`). `package.json` points `main`/`module`/`types` at those paths — don't change `outDir` casually. The ESM config excludes `*.spec.ts`; the CJS config compiles them.
- Language target is ES2017 + DOM lib; CI matrix is Node 18.x/20.x (`.github/workflows/node.js.yml`). Don't introduce syntax or deps beyond that baseline.

## Build & test
- Tests run against **compiled JS**, not TS sources: `jasmine.json` sets `spec_dir: "lib"`. `npm test` handles this itself (`pretest` runs the build). Reference output: 36 specs, 0 failures, ~92% line coverage (branches ~78% — the polyfill fallbacks and other-realm header branches are inherently hard to hit from Node; the function % also counts compiled export shims).
- Coverage quirk: the legacy `.nycrc` had `"all": true`, which sweeps every file on disk (`.d.ts` stubs, ESM artifacts, helper scripts) into the report as 0% and dilutes the totals. The current config drops `all` and excludes `**/*.d.ts`, `**/*.cjs` and `**/*.spec.*`, so totals cover the **library output only** (loaded `lib/**/*.js`, sourcemapped to non-spec `src/*.ts`). Because the `all` sweep is gone, a brand-new source file that no test imports will not appear in the report at all — `src/index.ts` would be in that state, but `fetch.spec.ts` imports the barrel ("index barrel" smoke spec: the public runtime surface is pinned; keep the barrel trivial).
- Repo hygiene: `posttest` runs `scripts/check-tool-fragments.cjs`, which fails when remnants of automation tool-payloads are left in the sources/docs; it walks every code file under `src/` plus a fixed doc whitelist (new files are covered automatically), ignores lines containing the literal `scan-exempt` token (for legitimately quoting a marker), and never scans `scripts/` itself. `scripts/` is excluded from the npm package via `.npmignore`.
```
npm test          # build + nyc jasmine (npm ci first)
npx jasmine --config=jasmine.json   # tests only, requires a prior build
```
- History gotcha: commit a052949 ("depedabot fix") had deleted the `test` script and the `jasmine`/`nyc` devDependencies; they were restored as part of the 2.0.2 fixes. Don't drop them again when hand-editing `package.json` — CI runs plain `npm test`.
- TypeScript is pinned by caret to ^4.2.4, which resolves to 4.9.5; the DOM type in `getBytes` is `ReadableStreamReadResult` (the old `ReadableStreamDefaultReadResult` name broke `tsc` on TS ≥ 4.6 — upstream issue #52).
- No lint, format, or typecheck scripts exist; strict `tsc` compile is the only static check, plus the repo-hygiene `posttest` scan (`scripts/check-tool-fragments.cjs`) that fails when remnants of automation tool-payloads are left in sources/docs.

## Packaging
- `.npmignore` uses nested globs: `lib/*.map`-style single-star patterns do NOT match `lib/cjs/*.map` (that's how spec bundles and unresolvable maps leaked into published packages). Use `lib/**/*.spec.*` and ship `src/` so the bundled maps resolve.

## Repo infra facts
- `package-lock.json` is lockfileVersion 2 → requires npm 7+; that's why the CI matrix is Node 18.x/20.x (Node 12/14 runners ship npm 6 and fail `npm ci`).
- Actions are pinned to full-length SHAs (PR #108, dependabot.yml updates them weekly). Bump the SHA + keep the version comment when upgrading an action manually.
- Upstream `Azure/fetch-event-source` is archived: pushing is impossible, open PRs land here by applying their diffs (PR refs are fetchable via `git fetch origin '+refs/pull/*/head:refs/remotes/origin/pr/*'`).
- This repo publishes as `@coderminer/fetch-event-source` on npm — the `@microsoft` scope belongs to Microsoft — sourced from github.com/coderminer/fetch-event-source. The fork releases start at version 3.0.0 to signal the behavior-tightening fixes above the archived upstream 2.0.2.

## Release conventions (CONTRIBUTING.md)
- Version bumps and `CHANGELOG.md` updates happen inside the PR; publishing waits for review (prereleases use `npm publish --tag prerelease`).
- Release flow: squash-merge the PR (copy description into commit text) → tag the merge commit `v<version>` → push the tag → create a GitHub release with changelog as description → `npm publish` (prepublishOnly runs build + test; `publishConfig.access: "public"` covers the scoped publish).

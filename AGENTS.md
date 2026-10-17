# AGENTS.md

Verified guidance for agents working on `@microsoft/fetch-event-source` (single-package TypeScript library, ~4 source files, no monorepo, no lint/format config).

## Architecture
- Public API surface is only what `src/index.ts` re-exports: `fetchEventSource`, `EventStreamContentType`, `FetchEventSourceInit`, `EventSourceMessage`.
- `src/parse.ts` — pure SSE byte-stream parser (`getBytes`/`getLines`/`getMessages`), written to the WHATWG spec (empty `data:` fields append `\n`; one trailing `\n` stripped on dispatch). Fully covered by `src/parse.spec.ts`.
- `src/fetch.ts` — the fetch/retry loop. Written for browsers but keeps to `globalThis` with optional-chained `document` access, so it also runs in web workers / extension scripts and under Node test runners. Covered by `src/fetch.spec.ts` (uses stub fetches, no real network).
- Abort/retry invariants to preserve when editing `fetch.ts`:
  1. Skip everything up front if the caller's `AbortSignal` is already aborted.
  2. Each `create()` attempt captures its `currentController` closure-local and the catch checks THAT controller, not the shared `curRequestController` (visibility switching races).
  3. `create()` aborts the previous attempt's controller before opening a new one (no leaked streams on retry).
  4. `onclose` is awaited so async onclose errors reach `onerror`.
  5. `dispose()` also removes the caller's abort listener (`onAbort`) — long-lived shared signals would otherwise accumulate one listener per connection.
  6. Each attempt fetches a fresh `input.clone()` when the input is a `Request`, so retried connections never hit "body already used" and the original body is never consumed.
- Dual output is required: `npm run build` compiles twice (CJS → `lib/cjs` via `tsconfig.json`, ESM → `lib/esm` via `tsconfig.esm.json`). `package.json` points `main`/`module`/`types` at those paths — don't change `outDir` casually. The ESM config excludes `*.spec.ts`; the CJS config compiles them.
- Language target is ES2017 + DOM lib; CI matrix is Node 18.x/20.x (`.github/workflows/node.js.yml`). Don't introduce syntax or deps beyond that baseline.

## Build & test
- Tests run against **compiled JS**, not TS sources: `jasmine.json` sets `spec_dir: "lib"`. `npm test` handles this itself (`pretest` runs the build). Reference output: 26 specs, 0 failures, ~92% line coverage.
```
npm test          # build + nyc jasmine (npm ci first)
npx jasmine --config=jasmine.json   # tests only, requires a prior build
```
- History gotcha: commit a052949 ("depedabot fix") had deleted the `test` script and the `jasmine`/`nyc` devDependencies; they were restored as part of the 2.0.2 fixes. Don't drop them again when hand-editing `package.json` — CI runs plain `npm test`.
- TypeScript is pinned by caret to ^4.2.4, which resolves to 4.9.5; the DOM type in `getBytes` is `ReadableStreamReadResult` (the old `ReadableStreamDefaultReadResult` name broke `tsc` on TS ≥ 4.6 — upstream issue #52).
- No lint, format, or typecheck scripts exist; strict `tsc` compile is the only static check that will catch issues.

## Packaging
- `.npmignore` uses nested globs: `lib/*.map`-style single-star patterns do NOT match `lib/cjs/*.map` (that's how spec bundles and unresolvable maps leaked into published packages). Use `lib/**/*.spec.*` and ship `src/` so the bundled maps resolve.

## Repo infra facts
- `package-lock.json` is lockfileVersion 2 → requires npm 7+; that's why the CI matrix is Node 18.x/20.x (Node 12/14 runners ship npm 6 and fail `npm ci`).
- Actions are pinned to full-length SHAs (PR #108, dependabot.yml updates them weekly). Bump the SHA + keep the version comment when upgrading an action manually.
- Upstream `Azure/fetch-event-source` is archived: pushing is impossible, open PRs land here by applying their diffs (PR refs are fetchable via `git fetch origin '+refs/pull/*/head:refs/remotes/origin/pr/*'`).

## Release conventions (CONTRIBUTING.md)
- Version bumps and `CHANGELOG.md` updates happen inside the PR; publishing waits for review (prereleases use `npm publish --tag prerelease`).
- Release flow: squash-merge the PR (copy description into commit text) → tag the merge commit `v<version>` → push the tag → create a GitHub release with changelog as description. A Microsoft CLA bot will comment on PRs; follow it.

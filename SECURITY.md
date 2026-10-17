# Security Policy

`@coderminer/fetch-event-source` is an independently maintained fork of the archived [`@microsoft/fetch-event-source`](https://github.com/Azure/fetch-event-source) and has no affiliation with Microsoft or MSRC.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

* Preferred: open a [GitHub security advisory](https://github.com/coderminer/fetch-event-source/security/advisories/new) for this repository.
* Alternatively, email [coder_woo@163.com](mailto:coder_woo@163.com) with reproduction steps, the affected published version (3.0.0 and later), and an impact assessment.

You should receive a response within 72 hours. Confirmed vulnerabilities in the published package are coordinated as a private advisory with a patched release before public disclosure.

## Scope

The package is a thin fetch/SSE client. It stores no credentials of its own — everything sensitive it touches (headers, tokens passed to a headers function, request bodies) comes from the caller. The most relevant areas for security review are: header normalization and `last-event-id` propagation, retry/idle scheduling, response validation, and the SSE stream parsing state machine (`src/parse.ts`).

Reports that only affect the archived upstream are out of scope; that repository will not act on them.

# Security Policy

## Reporting a vulnerability

Please **do not open a public issue**. Report privately at
https://github.com/zznorthstar/learn-docker/security/advisories/new

Include steps to reproduce and the impact. You can expect an acknowledgement within a few days.

## Scope

In scope: the Worker/Durable Object relay (`worker/`), lab identity and the secret-handling model, the MCP surface, and the CSP/headers.

Design notes relevant to reports: the lab secret is a 256-bit capability token sent only in the `Authorization` header or the browser socket's first message; the relay stores only its SHA-256 hash; the first browser to present a pair claims the lab. Known gap: there is no rate limiting on the relay yet.

## Supported versions

Only the latest `main` is supported.

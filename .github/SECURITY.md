# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for security problems.

Email me directly at **security@benjaminb.xyz** with:

- A description of the issue.
- Steps to reproduce, or a proof-of-concept.
- Your name / handle if you'd like credit.

You'll get an acknowledgement within 72 hours and, where applicable, a fix on the main branch within two weeks. Disclosure timing is flexible — I'd rather get the fix right than rush a public note.

## Scope

In scope:
- Anything in `functions/` (the Pages Functions runtime).
- The admin SPA in `public/admin.*`.
- The cron Worker in `cron-worker/`.
- The setup scripts (`setup.sh`, `setup.py`, `setup.js`).

Out of scope:
- Issues that require a malicious operator (this is a self-hosted tool — the operator is trusted).
- Cloudflare platform issues (report those to Cloudflare).
- Dependency-only issues already triaged upstream.

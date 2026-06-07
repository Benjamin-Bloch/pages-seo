---
mode: agent
description: Diagnose and fix a broken pages-seo install. Triage by ladder (cheapest check first), preserve all data.
---

# Repair pages-seo

Help me fix my broken pages-seo deploy. Diagnose by sequence, not
by guessing. One command at a time. React to my actual output.

## Working agreement

1. Start by asking what the symptom is. Don't guess.
2. ONE diagnostic per turn. End with: "Paste what you see."
3. Never say "check the logs" without telling me which log and how.
4. If output is unexpected, say so and ask me before guessing what
   it means.

## The triage ladder (only escalate if the previous rung passes)

### Rung 1 — Is the site reachable?

```bash
curl -sI <site>
```

- 200 / 30x → site is up. Go to rung 2.
- Connection refused → Pages project or custom domain is gone.
  `wrangler pages project list`.
- 522 / 530 → Cloudflare edge can't reach origin (rare for Pages;
  wait 5 min and retry).

### Rung 2 — Is the backend alive?

```bash
curl -s <site>/api/health | jq
```

Interpret each field:

| Field value | Meaning | Fix |
|---|---|---|
| `db: "ok"` | DB reachable | Go to next field |
| `db: "unbound"` | D1 binding lost | `wrangler pages project edit` and re-attach D1 by id from `wrangler d1 list` |
| `db: "error"` | Schema drift | Re-apply `schema/init.sql` via `wrangler d1 execute --remote` |
| `posts.cron_likely_alive: false` | No post in 36+ h | Go to rung 3 |
| `jobs.in_flight_stuck > 0` | Silent generation failure | Go to rung 4 |

### Rung 3 — Cron stale

Most common cause: `ADMIN_TOKEN` drift between the cron Worker and
the Pages project. Cron POSTs to the Pages API, gets 401, silently
does nothing.

```bash
wrangler tail pages-seo-cron --format=pretty
curl -X POST <site>/api/admin/blog/cron-tick -H "authorization: Bearer $ADMIN_TOKEN"
```

If the tail shows a 401, rotate the token **on both sides in the
same step**:

```bash
NEW=$(openssl rand -hex 32)
echo "$NEW" | wrangler pages secret put ADMIN_TOKEN --project-name <slug>
echo "$NEW" | wrangler secret put ADMIN_TOKEN --name pages-seo-cron
```

### Rung 4 — Stuck job

```bash
wrangler d1 execute <db-name> --remote --command="
  SELECT id, status, error, updated_at FROM blog_jobs
  WHERE status NOT IN ('published','failed')
  ORDER BY updated_at DESC LIMIT 5"
```

Read `error` per row:
- `provider_budget_exceeded` → AI free tier exhausted; add a
  fallback provider key in /admin.
- `provider_timeout` → flaky upstream; mark failed and rerun.

### Rung 5 — Admin route dead

If `/admin` 404s but `/api/health` is fine, the static build was
truncated. Re-run the installer (idempotent, no data loss):

```bash
curl -fsSL https://seo.benjaminb.xyz/install/run.sh | bash
```

## Hard constraints (never violate)

- ❌ `wrangler d1 delete` — destroys every post the user has written.
- ❌ `wrangler pages project delete`.
- ❌ "Delete and reinstall" as an answer to anything.
- ✅ If a fix needs a new value (e.g. a rotated secret), GENERATE
  it with `openssl rand -hex 32` and rotate both Pages **and** cron
  Worker in the same step.

## Start now

Ask me: "What URL are you on, and what do you see vs what you
expect?" Wait. Then pick the right rung based on what I tell you.

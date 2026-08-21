# EPGS — 内镜重点患者监测系统

Endoscopy Key-Patient Monitoring System for 菏泽市肿瘤中医医院 (Heze Cancer Hospital of
Traditional Chinese Medicine, Endoscopy Center).

This repository currently contains the **engineering skeleton** only (issue #1). No
medical/business logic, patient data, PACS/RIS integration, keyword matching, or real
sync logic is implemented yet — those land in later issues (#2–#14). See
`Doc/PRD.md` for the full product requirements.

## Architecture overview

```
                 ┌─────────────┐         HTTP          ┌─────────────┐
                 │  apps/web   │  ────────────────────▶ │  apps/api   │
                 │ React+Vite  │   GET /health (etc.)   │   NestJS    │
                 └─────────────┘                        └──────┬──────┘
                                                                 │ Prisma (datasource only, #1)
                                                                 ▼
┌─────────────┐    reads config the same way as api      ┌─────────────┐
│ apps/worker │ ─────────────────────────────────────────│  PostgreSQL │
│   NestJS    │   REST/CSV sync and keyword matching       │  (docker)   │
└─────────────┘                                           └─────────────┘

        apps/api, apps/worker, apps/web all depend on packages/shared-types
        for cross-app TypeScript types (e.g. HealthStatus, ApiErrorBody).
```

- **apps/api** — the public-facing NestJS HTTP API. Owns `GET /health`, the unified
  error response shape, correlation-ID propagation, structured logging, env-var
  config validation (fail-fast on missing required vars), (issue #4) the
  `monitor_rule` management API under `/api/rules`, and (issue #7) the read-only
  monitor workbench API under `/api/monitor` (list/filter/summary + detail) — see
  "Rules API" / "Monitor API" below and [`docs/rules-api.md`](docs/rules-api.md) /
  [`docs/api/monitor-api.md`](docs/api/monitor-api.md).
- **apps/worker** — a NestJS background service that periodically reads endoscopy
  reports, runs keyword matching, and idempotently updates the EPGS PostgreSQL read
  model. Production consumes the separately deployed hospital REST gateway; local
  development can read an API-shaped synthetic CSV. This repository never connects
  directly to the hospital source database. See [`docs/pacs-ris-adapter.md`](docs/pacs-ris-adapter.md).
- **apps/web** — a React + Vite frontend implementing the read-only monitor
  workbench (issue #9): filters, attention-level summary cards, the exam list with
  pagination, and a read-only detail drawer that shows the report/diagnosis and hit
  evidence from `apps/api`'s `/api/monitor` endpoints (see "Monitor API" below and
  `docs/product/read-only-display-spec.md`). The 监测规则 button opens the rule
  configuration modal (issue #11).
- **packages/shared-types** — TypeScript types/interfaces shared across api/worker/web
  (e.g. `HealthStatus`, `ApiErrorBody`), proving the workspace linking works end to end.

## Directory structure

```
apps/
  api/       # NestJS HTTP API (main.ts, app.module.ts, health/, rules/, prisma/, common/, config/)
  worker/    # NestJS worker service (main.ts, app.module.ts, sync/, health/, config/)
  web/       # React + Vite frontend (src/App.tsx, src/Workbench.tsx, src/DetailDrawer.tsx)
packages/
  shared-types/   # Shared TS types (HealthStatus, ApiErrorBody)
.github/workflows/ci.yml   # CI: lint, typecheck, test, build on PR + push to main
docker-compose.yml          # Local Postgres for later issues
.env.example                # Root env var reference (see also apps/*/.env.example)
```

## Current product and data contracts

- [`docs/product/read-only-display-spec.md`](docs/product/read-only-display-spec.md) —
  current read-only UI scope, confirmed display fields, filters, summary cards, and removed
  reporting/disposition functionality.
- [`docs/pacs-ris-adapter.md`](docs/pacs-ris-adapter.md) — confirmed InterSystems
  IRIS/Caché source tables and field mapping, plus stable-ID and incremental-sync items that
  must be verified before production use.
- [`docs/api/pacs-ris-data-api.md`](docs/api/pacs-ris-data-api.md) and
  [`docs/api/pacs-ris-data-api.openapi.yaml`](docs/api/pacs-ris-data-api.openapi.yaml) —
  target read-only database-gateway API contract for issue #24.
- [`docs/api/monitor-api.md`](docs/api/monitor-api.md) — issue #7/#8's read-only
  monitor workbench API contract (`/api/monitor/exams`, `/api/monitor/exams/:id`,
  `/api/monitor/summary`): filter semantics, Shanghai-day boundaries, sort contract,
  pagination, error codes, and the detail endpoint's hit evidence (rule provenance +
  matched-field location).
- **Web workbench (issues #9/#10)** — the frontend single-page workbench consuming
  the monitor API: header + user-info placeholder (real identity lands in #13),
  toolbar (last sync time from `/api/system/sync-status`, 立即刷新, 监测规则),
  filters, five attention-level summary cards (clicking one sets the level filter),
  paginated exam list, and a read-only detail drawer that keeps the workbench
  context. The drawer highlights the hit keywords in place inside 报告内容/诊断
  (React `<mark>` nodes — the original text is never rewritten), shows the hits'
  field location + context snippet, and returns keyboard focus to the triggering
  查看详情 button when it closes. Department/exam-item filters are text inputs for
  now (no distinct-values endpoint yet); level is always shown as a text label,
  never color-only.

## Prerequisites

- Node.js **v24** (see `.nvmrc` — run `nvm use`)
- pnpm **>= 9** (developed against `10.33.2`, pinned via `packageManager` in
  `package.json`)
- Docker (optional, only needed if you want a local Postgres via `docker-compose.yml`)

## Setup

```bash
pnpm install
cp .env.example .env                      # optional, for reference
cp apps/api/.env.example apps/api/.env
cp apps/worker/.env.example apps/worker/.env
cp apps/web/.env.example apps/web/.env
docker compose up -d                      # optional: local Postgres on :5432
```

## Local dev — single command

```bash
pnpm dev
```

This builds `packages/shared-types` once, then runs `apps/api`, `apps/worker`, and
`apps/web` concurrently (via `concurrently`), each printing its own color-coded log
prefix. Default ports: api `3000`, worker `3001`, web `5173`.

Run an individual app instead:

```bash
pnpm --filter api run start:dev
pnpm --filter worker run start:dev
pnpm --filter web run dev
```

## Environment variables

All secrets and config **must** come from environment variables — never hardcode
credentials in source. Config is validated at startup with a Joi schema in both
`apps/api` and `apps/worker`; a missing required variable causes the process to
exit immediately with a clear, non-secret-leaking error message (e.g.
`Config validation error: "DATABASE_URL" is required`) rather than starting in a
broken state.

| Variable                  | Used by          | Purpose                                             | Example / default                            |
| ------------------------- | ---------------- | --------------------------------------------------- | -------------------------------------------- |
| `NODE_ENV`                | api, worker      | Runtime environment                                 | `development`                                |
| `PORT`                    | api, worker, web | HTTP port for that app                              | api `3000`, worker `3001`, web `5173`        |
| `TZ`                      | api, worker      | Process timezone                                    | `Asia/Shanghai`                              |
| `LOG_LEVEL`               | api, worker      | Minimum log level (`fatal`..`verbose`)              | `log`                                        |
| `DATABASE_URL`            | api, worker      | PostgreSQL connection string (required, no default) | `postgresql://epgs:epgs@localhost:5432/epgs` |
| `SYNC_INTERVAL_MINUTES`   | worker           | Scheduled source-sync cadence                       | `3`                                          |
| `PACS_ADAPTER_MODE`       | worker           | `csv` for local Mock or `http` for hospital REST    | `csv`                                        |
| `PACS_MOCK_CSV_PATH`      | worker           | API-shaped CSV path; required in `csv` mode         | `../../Doc/moke-data.csv`                    |
| `PACS_HTTP_BASE_URL`      | worker           | Hospital REST gateway; required in `http` mode      | no default                                   |
| `PACS_HTTP_SERVICE_TOKEN` | worker           | Gateway Bearer Token; required in `http` mode       | no default                                   |
| `VITE_API_BASE_URL`       | web              | Base URL web uses to call the API                   | `http://localhost:3000`                      |
| `JWT_SECRET`              | api              | 本地登录 JWT 签名密钥（至少 32 字符，必填）         | 无默认值                                     |
| `JWT_EXPIRES_SECONDS`     | api              | 登录 Cookie 与 JWT 有效期（秒）                     | `28800`                                      |
| `WEB_ORIGIN`              | api              | 允许携带 Cookie 调用 API 的前端来源                 | `http://localhost:5173`                      |

See `.env.example` (root) and `apps/*/.env.example` for the full, commented list.

## Test commands

```bash
pnpm run test              # all workspaces: api (unit+e2e), worker (unit), web (component)
pnpm --filter api run test:unit   # api unit tests only
pnpm --filter api run test:e2e    # api e2e tests only (GET /health, error shape, correlation ID)
pnpm --filter worker run test     # worker unit tests
pnpm --filter web run test        # web component tests (Vitest + React Testing Library)
```

CI does **not** require a running Postgres for these tests — `apps/api`'s e2e suite
supplies a fallback `DATABASE_URL` so config validation passes without a live DB.
Migration/constraint verification against a real Postgres runs as a separate CI job
(see "Database / Prisma" below).

## Build commands

```bash
pnpm run build              # builds shared-types, then api, worker, web
pnpm --filter api run build
pnpm --filter worker run build
pnpm --filter web run build
```

## Lint / format / typecheck

```bash
pnpm run lint
pnpm run format         # writes fixes
pnpm run format:check   # CI-safe check, no writes
pnpm run typecheck
```

TypeScript `strict` mode is enabled across all packages (see `tsconfig.base.json`).
ESLint + Prettier are configured at the root and extended by each app.

## Database / Prisma

`apps/api/prisma/schema.prisma` defines the EPGS monitoring business schema (issue #3,
converged to read-only display data by issue #26): `MonitorRule`, `MonitorRecord`,
`MonitorMatch`, `SyncJobLog` and their enums. The closed-loop reporting model
(`MonitorAction`, `HandlingStatus`/`ActionType`/`ReportStatus` enums, and the
disposition fields on `MonitorRecord`) was removed in the
`remove_closed_loop_readonly` migration — records keep source snapshot + current level

- hit evidence only. This schema is decoupled from PACS/RIS — it does not duplicate
  imaging data and does not implement the keyword-matching algorithm (issue #5) or any
  HTTP API (issue #4/#7/#8). Field meaning, sensitivity classification and retention
  policy are documented in [`docs/data-dictionary.md`](docs/data-dictionary.md).

The initial migration lives at
`apps/api/prisma/migrations/20260821040339_init_monitoring_schema/migration.sql`.
Issue #26 adds
`apps/api/prisma/migrations/20260821073851_remove_closed_loop_readonly/migration.sql`,
which drops the closed-loop model and converges `monitor_record` to the read-only
field set. Both directories ship a companion manual rollback script (`rollback.sql`) —
see each file's header comment for how to apply it (Prisma Migrate has no built-in
"down" concept). The issue #26 migration begins with a PL/pgSQL data gate that aborts
the upgrade unless the closed-loop tables are empty, forcing a backup + data-loss
review before production migrations.

`docker-compose.yml` provides a local Postgres for running/validating migrations:

```bash
docker compose up -d postgres
cp apps/api/.env.example apps/api/.env   # DATABASE_URL points at the compose Postgres
pnpm --filter api exec prisma migrate deploy   # apply migrations
pnpm --filter api exec prisma migrate status   # confirm up to date
pnpm --filter api exec ts-node --transpile-only prisma/scripts/verify-constraints.ts
# (run from apps/api) — exercises idempotency, illegal-enum rejection, FK
# RESTRICT/CASCADE behavior and workbench-filter index usage against a real DB

# manual rollback:
psql "$DATABASE_URL" -f apps/api/prisma/migrations/20260821040339_init_monitoring_schema/rollback.sql
psql "$DATABASE_URL" -c "DELETE FROM \"_prisma_migrations\" WHERE migration_name = '20260821040339_init_monitoring_schema';"
```

CI runs this same sequence against a real `postgres:16-alpine` service container in the
`db-migrations` job (see `.github/workflows/ci.yml`), separate from the DB-free
`build-and-test` job.

## Rules API (issue #4)

`GET/POST/PUT /api/rules` plus `POST /api/rules/import/{validate,confirm}` implement
auditable CRUD + CSV bulk import for `monitor_rule` (the keyword rules that assign
RED/YELLOW/GREEN attention levels — a monitoring-configuration label, not a clinical
diagnosis or medical urgency ranking). Full endpoint reference, request/response
examples, and business-rule details (uniqueness scope, optimistic locking via
`version`, versioned audit trail) live in [`docs/rules-api.md`](docs/rules-api.md).
Auto-generated OpenAPI/Swagger UI is served at `GET /api/docs` once `apps/api` is
running.

Seed the 6 initial RED keywords (癌/肿瘤/肿物/Ca/食管裂孔疝/贲门失弛缓症) against a
migrated database:

```bash
pnpm --filter api exec prisma db seed
```

YELLOW/GREEN keyword lists are intentionally **not** seeded — they require sign-off
from the endoscopy center first (see `docs/rules-api.md`'s "待确认事项").

All business endpoints require a valid local-login Cookie. Issue #31 provides only
the authenticated/not-authenticated boundary; role-based rule permissions remain in
issue #13.

## Local authentication (issue #31)

The web app checks `GET /api/auth/me` before rendering business data. Login uses a
JWT stored only in an HttpOnly, SameSite=Lax Cookie; PostgreSQL stores an Argon2id
password hash and never the plaintext password. See [`docs/auth.md`](docs/auth.md)
for API, deployment and password-reset instructions.

After applying migrations, create the first account interactively on the application
server:

```bash
pnpm --filter @epgs/api auth:create-user --username admin --display-name "系统管理员"
```

If a user forgets the password, reset it from the same server. Password input is
hidden and cannot be supplied as a command-line argument:

```bash
pnpm --filter @epgs/api auth:reset-password --username admin
```

## Monitor API (issue #7, #8)

`GET /api/monitor/exams`, `GET /api/monitor/exams/:id` and
`GET /api/monitor/summary` implement the **read-only** endoscopy workbench: a
filterable/paginated list, the attention-level summary cards, and a detail drawer.
They surface the synced exam snapshot (`monitor_record`) plus its hit evidence
(`monitor_match`) — the product converged to read-only display (issue #26), so there
is deliberately no report/disposition status anywhere in these responses, and the
list **never** returns `reportContent`/`diagnosis` (detail endpoint only). The
detail endpoint (issue #8) also returns, per hit, the exact rule provenance
(`ruleId`/`ruleVersion`) and the report-field location (`matchedField` →
报告内容/诊断, see the mapping table in the API docs).

Key semantics (full contract in [`docs/api/monitor-api.md`](docs/api/monitor-api.md)):

- Combined filters under **AND**: `examDateFrom`/`examDateTo` (Asia/Shanghai natural
  days; `from` inclusive, `to` exclusive of the next day), `department`,
  `patientTypeCode`, `level`, `examItem`, and `q` (fuzzy search over `patientName`
  OR matched keyword only — never report text).
- Default sort `examTime desc`, ties broken RED > YELLOW > GREEN > UNCLASSIFIED
  (via the PG enum order), `id` final tie-break for stable pagination; optional
  `sortBy` whitelist (`examTime`/`currentLevel`/`patientName`/`firstMatchedAt`/
  `lastMatchedAt`) + `sortDir`.
- `patientType` keeps the source code verbatim plus the confirmed Chinese `name`
  (unknown codes → `name: null`, never guessed); no rule hit = `UNCLASSIFIED`
  (never auto-GREEN).
- `summary` computes total/red/yellow/green/unclassified under the **same** filters
  as the list (`total` = sum of the 5 buckets).

## Commit message convention

This repo follows [Conventional Commits](https://www.conventionalcommits.org/):
`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`, etc. PR descriptions should
reference the issue number being closed, e.g. `Closes #1`.

## CI

`.github/workflows/ci.yml` runs on every PR and push to `main`, with two jobs:

**`build-and-test`** (no live database required):

1. Checkout
2. Setup Node v24 + pnpm (with pnpm cache)
3. `pnpm install --frozen-lockfile`
4. `pnpm run lint` — ESLint across all workspaces
5. `pnpm run typecheck` — `tsc --noEmit` across all workspaces
6. `pnpm run test` — unit + e2e tests across all workspaces
7. `pnpm run build` — production build for api, worker, web, shared-types

**`db-migrations`** (issue #3, runs against a real `postgres:16-alpine` service
container):

1. `prisma validate` + `prisma format` (fails if the schema file isn't already
   formatted)
2. Apply migrations to an empty database (`prisma migrate deploy`)
3. Re-apply migrations to confirm idempotency (no pending migrations the second time)
4. `prisma migrate diff` to assert the schema has no drift vs. the migration history
5. `prisma/scripts/verify-constraints.ts` — idempotency (source-key + keyword-hit
   unique constraints), illegal-enum rejection, FK RESTRICT/CASCADE behavior, and
   workbench-filter index usage, all against real inserted rows
6. (issue #4) `apps/api/test/rules.e2e-spec.ts` — full rules API lifecycle, duplicate/
   conflict detection, concurrent-edit (optimistic lock) scenarios, illegal enums, and
   CSV import (full success / partial failure / duplicate rows / encoding error / empty
   file), all against this same real Postgres
7. (issue #7) `apps/api/test/monitor.e2e-spec.ts` — combined filters, cross-day
   Asia/Shanghai boundaries, exact day edges, null rows, stable pagination,
   invalid-param 400s, summary==list consistency, and the read-only detail endpoint.
   It seeds its own 6-rule/12-record fixture in beforeAll and wipes monitor_match →
   monitor_record → monitor_rule in afterAll, so the seed-count check in step 8 still
   sees exactly the 6 seeded RED rules
8. (issue #4) `prisma/seed.ts` run twice — confirms the 6 initial RED keyword rules are
   created once and re-runs are idempotent (no duplicates)
9. Roll back the migration (`rollback.sql`) and confirm all monitor_* tables are gone
10. Re-apply the migration after rollback to confirm the upgrade path still works

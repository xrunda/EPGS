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
│   NestJS    │   scheduled placeholder job ("sync tick") │  (docker)   │
└─────────────┘                                           └─────────────┘

        apps/api, apps/worker, apps/web all depend on packages/shared-types
        for cross-app TypeScript types (e.g. HealthStatus, ApiErrorBody).
```

- **apps/api** — the public-facing NestJS HTTP API. Owns `GET /health`, the unified
  error response shape, correlation-ID propagation, structured logging, env-var
  config validation (fail-fast on missing required vars), and (issue #4) the
  `monitor_rule` management API under `/api/rules` — see "Rules API" below and
  [`docs/rules-api.md`](docs/rules-api.md).
- **apps/worker** — a NestJS-based background service for sync/monitoring jobs. Not
  publicly exposed; runs independently with its own port/health check and its own
  `@nestjs/schedule` cron job (currently a placeholder that logs `"sync tick"`).
  It also owns the read-only PACS/RIS adapter (`src/pacs-adapter/`, issue #2) that
  converts PACS/RIS exam/report tables into stable `PacsReportDto`s; see
  `docs/pacs-ris-adapter.md` for the assumed source schema and what still needs
  production verification. The actual scheduled sync job that calls this adapter
  lands in issue #6.
- **apps/web** — a React + Vite frontend. Currently a placeholder page ("内镜中心")
  that calls `apps/api`'s `/health` endpoint to prove connectivity. Real business
  pages land in issue #9+.
- **packages/shared-types** — TypeScript types/interfaces shared across api/worker/web
  (e.g. `HealthStatus`, `ApiErrorBody`), proving the workspace linking works end to end.

## Directory structure

```
apps/
  api/       # NestJS HTTP API (main.ts, app.module.ts, health/, rules/, prisma/, common/, config/)
  worker/    # NestJS worker service (main.ts, app.module.ts, sync/, health/, config/)
  web/       # React + Vite frontend (src/App.tsx, src/ApiStatus.tsx)
packages/
  shared-types/   # Shared TS types (HealthStatus, ApiErrorBody)
.github/workflows/ci.yml   # CI: lint, typecheck, test, build on PR + push to main
docker-compose.yml          # Local Postgres for later issues
.env.example                # Root env var reference (see also apps/*/.env.example)
```

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

| Variable                        | Used by          | Purpose                                             | Example / default                            |
| ------------------------------- | ---------------- | --------------------------------------------------- | -------------------------------------------- |
| `NODE_ENV`                      | api, worker      | Runtime environment                                 | `development`                                |
| `PORT`                          | api, worker, web | HTTP port for that app                              | api `3000`, worker `3001`, web `5173`        |
| `TZ`                            | api, worker      | Process timezone                                    | `Asia/Shanghai`                              |
| `LOG_LEVEL`                     | api, worker      | Minimum log level (`fatal`..`verbose`)              | `log`                                        |
| `DATABASE_URL`                  | api, worker      | PostgreSQL connection string (required, no default) | `postgresql://epgs:epgs@localhost:5432/epgs` |
| `SYNC_INTERVAL_MINUTES`         | worker           | Cadence for the (placeholder) sync job              | `15`                                         |
| `VITE_API_BASE_URL`             | web              | Base URL web uses to call the API                   | `http://localhost:3000`                      |
| `JWT_SECRET` / `SESSION_SECRET` | api (future)     | Auth placeholders — not wired up until issue #13    | _(unset)_                                    |

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

`apps/api/prisma/schema.prisma` defines the EPGS monitoring business schema (issue #3):
`MonitorRule`, `MonitorRecord`, `MonitorMatch`, `MonitorAction`, `SyncJobLog` and their
enums. This schema is decoupled from PACS/RIS — it does not duplicate imaging data and
does not implement the keyword-matching algorithm (issue #5) or any HTTP API
(issue #4/#7/#8). Field meaning, sensitivity classification and retention policy are
documented in [`docs/data-dictionary.md`](docs/data-dictionary.md).

The initial migration lives at
`apps/api/prisma/migrations/20260821040339_init_monitoring_schema/migration.sql`, with
a companion manual rollback script (`rollback.sql`) in the same directory — see that
file's header comment for how to apply it (Prisma Migrate has no built-in "down"
concept).

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

No real authentication/authorization exists yet for these write endpoints — see the
`JWT_SECRET`/`SESSION_SECRET` row above and `apps/api/src/common/guards/
rules-write.guard.ts` (issue #13 will replace this placeholder guard).

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
5. `prisma/scripts/verify-constraints.ts` — idempotency, illegal-enum rejection, FK
   RESTRICT/CASCADE behavior, append-only `monitor_action` reconstruction, and
   workbench-filter index usage, all against real inserted rows
6. (issue #4) `apps/api/test/rules.e2e-spec.ts` — full rules API lifecycle, duplicate/
   conflict detection, concurrent-edit (optimistic lock) scenarios, illegal enums, and
   CSV import (full success / partial failure / duplicate rows / encoding error / empty
   file), all against this same real Postgres
7. (issue #4) `prisma/seed.ts` run twice — confirms the 6 initial RED keyword rules are
   created once and re-runs are idempotent (no duplicates)
8. Roll back the migration (`rollback.sql`) and confirm all monitor_* tables are gone
9. Re-apply the migration after rollback to confirm the upgrade path still works

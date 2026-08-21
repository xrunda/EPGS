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
  error response shape, correlation-ID propagation, structured logging, and env-var
  config validation (fail-fast on missing required vars).
- **apps/worker** — a NestJS-based background service for sync/monitoring jobs. Not
  publicly exposed; runs independently with its own port/health check and its own
  `@nestjs/schedule` cron job (currently a placeholder that logs `"sync tick"`).
  Real PACS/RIS sync logic lands in issue #6.
- **apps/web** — a React + Vite frontend. Currently a placeholder page ("内镜中心")
  that calls `apps/api`'s `/health` endpoint to prove connectivity. Real business
  pages land in issue #9+.
- **packages/shared-types** — TypeScript types/interfaces shared across api/worker/web
  (e.g. `HealthStatus`, `ApiErrorBody`), proving the workspace linking works end to end.

## Directory structure

```
apps/
  api/       # NestJS HTTP API (main.ts, app.module.ts, health/, common/, config/, prisma/)
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
supplies a fallback `DATABASE_URL` so config validation passes without a live DB, and
Prisma is initialized with a datasource-only schema (no models yet; see below).

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

`apps/api/prisma/schema.prisma` currently defines only the `datasource` and
`generator` blocks — **no models yet**. This keeps issue #1's CI free of any live
Postgres dependency while proving the ORM tooling is wired up. Issue #3 will add the
actual data model (`monitor_rule`, `monitor_record`, etc.) and migrations.

`docker-compose.yml` provides a local Postgres for when later issues need it:

```bash
docker compose up -d
```

## Commit message convention

This repo follows [Conventional Commits](https://www.conventionalcommits.org/):
`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`, etc. PR descriptions should
reference the issue number being closed, e.g. `Closes #1`.

## CI

`.github/workflows/ci.yml` runs on every PR and push to `main`:

1. Checkout
2. Setup Node v24 + pnpm (with pnpm cache)
3. `pnpm install --frozen-lockfile`
4. `pnpm run lint` — ESLint across all workspaces
5. `pnpm run typecheck` — `tsc --noEmit` across all workspaces
6. `pnpm run test` — unit + e2e tests across all workspaces
7. `pnpm run build` — production build for api, worker, web, shared-types

No live database is required for CI to pass.

// Ensures required env vars exist before any module under test is
// imported (ConfigModule's Joi validation runs at import/decoration
// time). Mirrors apps/api/test/setup-env.ts's pattern.
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://user:pass@localhost:5432/epgs';
process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
process.env.PACS_ADAPTER_MODE = process.env.PACS_ADAPTER_MODE ?? 'fixture';

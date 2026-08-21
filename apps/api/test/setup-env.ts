// Ensures required env vars exist before any module under test is
// imported (ConfigModule's Joi validation runs at import/decoration
// time via AppModule's static forRoot() call, not inside a test body).
// This keeps the e2e suite DB-free per issue #1's CI constraints - no
// live Postgres is contacted, this is just a syntactically valid URL
// so validation passes.
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://user:pass@localhost:5432/epgs';
process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';

// Ensures required env vars exist before any module under test is
// imported (ConfigModule's Joi validation runs at import/decoration
// time via AppModule's static forRoot() call, not inside a test body).
// This keeps the e2e suite DB-free per issue #1's CI constraints - no
// live Postgres is contacted, this is just a syntactically valid URL
// so validation passes.
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://user:pass@localhost:5432/epgs';
process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-only-secret-at-least-32-characters';
process.env.NOTIFICATION_SECRET_KEY =
  process.env.NOTIFICATION_SECRET_KEY ?? 'test-only-notification-key-at-least-32-chars';
// Issue #54: optional - test rendering of {{hospitalName}} with a stable value.
process.env.HOSPITAL_NAME = process.env.HOSPITAL_NAME ?? '菏泽市中医医院';

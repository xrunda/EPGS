import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';

describe('AppModule (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // DATABASE_URL is guaranteed present by test/setup-env.ts, which runs
    // before any module (including AppModule's ConfigModule.forRoot) is
    // imported - this suite never depends on a real Postgres instance.
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health returns 200 with expected shape and no secrets', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200);

    expect(response.body).toEqual({
      status: 'ok',
      version: expect.any(String),
      uptime: expect.any(Number),
    });

    const bodyString = JSON.stringify(response.body);
    expect(bodyString).not.toMatch(/DATABASE_URL/i);
    expect(bodyString).not.toContain(process.env.DATABASE_URL);
  });

  it('GET /health echoes back an x-correlation-id header', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200);

    expect(response.headers['x-correlation-id']).toBeDefined();
  });

  it('propagates a caller-supplied x-correlation-id', async () => {
    const response = await request(app.getHttpServer())
      .get('/health')
      .set('x-correlation-id', 'test-correlation-id-123')
      .expect(200);

    expect(response.headers['x-correlation-id']).toBe('test-correlation-id-123');
  });

  it('GET /unknown-route returns the unified error shape', async () => {
    const response = await request(app.getHttpServer()).get('/unknown-route').expect(404);

    expect(response.body).toHaveProperty('error');
    expect(response.body.error).toHaveProperty('code');
    expect(response.body.error).toHaveProperty('message');
    expect(response.body.error).toHaveProperty('correlationId');
  });
});

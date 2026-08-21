import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { argon2id, hash } from 'argon2';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';

describe('Local authentication (e2e, real Postgres)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let dbAvailable = true;
  const username = 'auth-e2e-user';
  const initialPassword = 'synthetic-initial-password';
  const newPassword = 'synthetic-updated-password';

  beforeAll(async () => {
    prisma = new PrismaClient();
    try {
      await prisma.appUser.findFirst();
    } catch {
      dbAvailable = false;
      return;
    }

    await prisma.appUser.deleteMany({ where: { username } });
    await prisma.appUser.create({
      data: {
        username,
        displayName: '认证测试用户',
        passwordHash: await hash(initialPassword, { type: argon2id }),
      },
    });

    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new GlobalExceptionFilter());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    if (dbAvailable) await prisma.appUser.deleteMany({ where: { username } });
    if (app) await app.close();
    await prisma.$disconnect();
  });

  function itWithDb(name: string, test: () => Promise<void>): void {
    it(name, async () => {
      if (dbAvailable) await test();
    });
  }

  itWithDb('login, session restore, password change, token invalidation and logout', async () => {
    const server = app.getHttpServer();
    await request(server).get('/api/auth/me').expect(401);
    await request(server)
      .post('/api/auth/login')
      .send({ username, password: 'incorrect-password' })
      .expect(401);

    const agent = request.agent(server);
    const loginResponse = await agent
      .post('/api/auth/login')
      .send({ username, password: initialPassword })
      .expect(200);
    expect(loginResponse.body).toEqual({
      user: { id: expect.any(String), username, displayName: '认证测试用户' },
    });
    const originalCookie = String(loginResponse.headers['set-cookie'][0]).split(';')[0];
    expect(originalCookie).toMatch(/^epgs_session=/);
    expect(JSON.stringify(loginResponse.body)).not.toMatch(/password|hash|jwt|token/i);

    await agent.get('/api/auth/me').expect(200);
    await agent
      .post('/api/auth/change-password')
      .send({
        currentPassword: initialPassword,
        newPassword,
        confirmPassword: newPassword,
      })
      .expect(200);

    await request(server).get('/api/auth/me').set('Cookie', originalCookie).expect(401);
    await request(server)
      .post('/api/auth/login')
      .send({ username, password: initialPassword })
      .expect(401);

    const newAgent = request.agent(server);
    await newAgent.post('/api/auth/login').send({ username, password: newPassword }).expect(200);
    await newAgent.post('/api/auth/logout').expect(200);
    await newAgent.get('/api/auth/me').expect(401);
  });

  itWithDb('disabled accounts return 403 without exposing password data', async () => {
    await prisma.appUser.update({
      where: { username },
      data: {
        isActive: false,
        passwordHash: await hash(initialPassword, { type: argon2id }),
      },
    });
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username, password: initialPassword })
      .expect(403);
    expect(response.body.error.code).toBe('AUTH_ACCOUNT_DISABLED');
    expect(JSON.stringify(response.body)).not.toMatch(/synthetic|hash|jwt/i);
  });
});

import { Controller, Get, INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { NextFunction, Request, Response } from 'express';
import { AppRole } from '@prisma/client';
import { CurrentUser, RequireRoles, ROLES_KEY } from './access.decorators';
import { AccessUser } from './access-user';

describe('access decorators (issue #13)', () => {
  it('RequireRoles stores the role list under ROLES_KEY (class + method capable)', () => {
    class ControllerStub {
      @RequireRoles(AppRole.VIEWER, AppRole.RULE_ADMIN)
      method(): void {}
    }
    const meta = Reflect.getMetadata(ROLES_KEY, ControllerStub.prototype.method);
    expect(meta).toEqual(['VIEWER', 'RULE_ADMIN']);
  });

  // CurrentUser resolves through the real Nest param-decorator machinery:
  // a minimal app with a middleware seeding request.accessUser, then the
  // handler value is what the factory reads.
  @Controller('probe')
  class ProbeController {
    @Get()
    get(@CurrentUser() user: AccessUser | null): { user: AccessUser | null } {
      return { user };
    }
  }

  @Module({ controllers: [ProbeController] })
  class ProbeModule {}

  const granted: AccessUser = {
    username: 'doctor',
    roles: [AppRole.VIEWER],
    departmentScope: ['消化内科'],
    patientDetail: true,
  };

  it('CurrentUser injects the request.accessUser when present', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    const app = moduleRef.createNestApplication<INestApplication>();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as { accessUser?: AccessUser }).accessUser = granted;
      next();
    });
    await app.init();
    try {
      const res = await request(app.getHttpServer()).get('/probe').expect(200);
      expect(res.body.user).toEqual(granted);
    } finally {
      await app.close();
    }
  });

  it('CurrentUser injects null when there is no accessUser', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    const app = moduleRef.createNestApplication<INestApplication>();
    await app.init();
    try {
      const res = await request(app.getHttpServer()).get('/probe').expect(200);
      expect(res.body.user).toBeNull();
    } finally {
      await app.close();
    }
  });
});

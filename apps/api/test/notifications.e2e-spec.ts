import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { hash, argon2id } from 'argon2';
import { WecomWebhookSender, WecomWebhookError, NotificationRuleExecutor } from '@epgs/notification-push';

/**
 * Full-stack e2e test for issue #54's notification channel/template APIs +
 * WeCom test-send against a REAL Postgres instance with the notification
 * migration applied (mirrors the rules.e2e-spec.ts pattern - see that file's
 * doc comment for why this suite lives in the db-migrations CI job and the
 * no-op-when-unreachable behavior).
 *
 * WecomWebhookSender is overridden with a fake so test-send never touches the
 * real WeCom network; the fake records the payload so the test asserts the
 * rendered markdown/news shape and the DECRYPTED webhook URL (proving the
 * cipher round-trip works end-to-end).
 *
 * Summary determinism: beforeAll wipes monitor_match/monitor_record (prior
 * suites already clean up, this is belt-and-suspenders) and seeds 7 records
 * (RED x2, YELLOW x1, GREEN x3, UNCLASSIFIED x1). afterAll wipes everything
 * this suite created, so the CI seed-count step still sees exactly the 6
 * seeded RED rules.
 */
describe('Notification API (e2e, real Postgres)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let dbAvailable = true;
  let adminAgent: ReturnType<typeof request.agent>;
  let viewerAgent: ReturnType<typeof request.agent>;
  let fakeSender: { send: jest.Mock };

  const adminUsername = 'notif-e2e-admin';
  const viewerUsername = 'notif-e2e-viewer';
  const ruleAdminUsername = 'notif-e2e-ruleadmin';
  const authPassword = 'synthetic-notif-password';

  /** Summary fixture: RED x2, YELLOW x1, GREEN x3, UNCLASSIFIED x1 => total 7. */
  const SUMMARY_LEVELS = ['RED', 'RED', 'YELLOW', 'GREEN', 'GREEN', 'GREEN', 'UNCLASSIFIED'];

  function itWithDb(name: string, fn: () => Promise<void>): void {
    it(name, async () => {
      if (!dbAvailable) return;
      await fn();
    });
  }

  async function createChannel(
    name = '总值班室群',
    webhookUrl = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=e2e-secret-123',
  ): Promise<any> {
    const res = await adminAgent.post('/api/notification-channels').send({ name, webhookUrl }).expect(201);
    return res.body;
  }

  async function createTemplate(body: Record<string, unknown>): Promise<any> {
    const res = await adminAgent.post('/api/notification-templates').send(body).expect(201);
    return res.body;
  }

  beforeAll(async () => {
    prisma = new PrismaClient();
    try {
      await prisma.$queryRaw`SELECT 1`;
      await prisma.notificationChannel.findFirst();
      await prisma.notificationTemplate.findFirst();
      await prisma.monitorRecord.findFirst();
      await prisma.appUser.findFirst();
    } catch (err) {
      dbAvailable = false;
      // eslint-disable-next-line no-console
      console.warn(
        `Skipping notifications e2e suite: no reachable/migrated Postgres at DATABASE_URL (${(err as Error).message}). ` +
          'Run `prisma migrate deploy` against a real Postgres to execute this suite.',
      );
      return;
    }

    // Deterministic summary: start from a clean monitor table, then seed the
    // fixture above. monitor_rule is deliberately NOT touched (the CI seed
    // step after this suite asserts its 6-RED invariant separately).
    await prisma.monitorMatch.deleteMany({});
    await prisma.monitorRecord.deleteMany({});
    for (const [index, level] of SUMMARY_LEVELS.entries()) {
      await prisma.monitorRecord.create({
        data: {
          sourceRecordId: `NOTIF-E2E-${index}`,
          reportId: `NOTIF-E2E-${index}`,
          reportVersion: 1,
          sourceUpdatedAt: new Date('2026-08-23T01:00:00Z'),
          patientName: '测试患者',
          department: '骨科',
          examItem: '电子胃镜检查',
          currentLevel: level as never,
        },
      });
    }

    // Push-rule fixture: 3 records with examTime inside the 2026-08-23
    // Shanghai window [00:00+08, 24:00+08) and 1 just OUTSIDE it (00:00+08 the
    // next day). Summary for that window => RED 1 / YELLOW 1 / GREEN 1 / total
    // 3; the outside record proves the `lt` boundary excludes the next day's
    // first instant. The suite passes an explicit ?windowDate= so it never
    // depends on the real wall clock.
    const RULE_WINDOW_EXAM_TIMES: Array<{ level: string; examTime: Date }> = [
      { level: 'RED', examTime: new Date('2026-08-23T01:00:00Z') }, // 09:00 +08 (in)
      { level: 'YELLOW', examTime: new Date('2026-08-22T16:00:00Z') }, // 00:00 +08, gte (in)
      { level: 'GREEN', examTime: new Date('2026-08-23T15:59:00Z') }, // 23:59 +08 (in)
      { level: 'GREEN', examTime: new Date('2026-08-23T16:00:00Z') }, // 00:00 +08 next day (out)
    ];
    for (const [index, row] of RULE_WINDOW_EXAM_TIMES.entries()) {
      await prisma.monitorRecord.create({
        data: {
          sourceRecordId: `NOTIF-RULE-${index}`,
          reportId: `NOTIF-RULE-${index}`,
          reportVersion: 1,
          sourceUpdatedAt: new Date('2026-08-23T01:00:00Z'),
          patientName: '规则推送患者',
          department: '骨科',
          examItem: '电子胃镜检查',
          currentLevel: row.level as never,
          examTime: row.examTime,
        },
      });
    }

    fakeSender = { send: jest.fn(async () => ({ errcode: 0, errmsg: 'ok' })) };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(WecomWebhookSender)
      .useValue(fakeSender)
      .compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new GlobalExceptionFilter());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    for (const username of [adminUsername, viewerUsername, ruleAdminUsername]) {
      await prisma.appUser.deleteMany({ where: { username } });
      await prisma.appUser.create({
        data: {
          username,
          displayName: '通知接口测试用户',
          passwordHash: await hash(authPassword, { type: argon2id }),
        },
      });
    }
    const grant = (username: string, role: string) =>
      prisma.appUserAccess.upsert({
        where: { username },
        create: { username, roles: [role] as never, departmentScope: [], patientDetail: false },
        update: { roles: [role] as never, departmentScope: [], patientDetail: false },
      });
    await grant(adminUsername, 'SYSTEM_ADMIN');
    await grant(viewerUsername, 'VIEWER');
    await grant(ruleAdminUsername, 'RULE_ADMIN');

    adminAgent = request.agent(app.getHttpServer());
    await adminAgent
      .post('/api/auth/login')
      .send({ username: adminUsername, password: authPassword })
      .expect(200);
    viewerAgent = request.agent(app.getHttpServer());
    await viewerAgent
      .post('/api/auth/login')
      .send({ username: viewerUsername, password: authPassword })
      .expect(200);
  });

  afterAll(async () => {
    if (dbAvailable) {
      await prisma.auditLog.deleteMany({});
      // FK order: push_delivery -> push_log -> rule_channel -> rule, all
      // before channels/templates (rule->template and delivery->channel are
      // Restrict; leaving a rule would block the template delete below).
      await prisma.pushDelivery.deleteMany({});
      await prisma.pushLog.deleteMany({});
      await prisma.notificationRuleChannel.deleteMany({});
      await prisma.notificationRule.deleteMany({});
      await prisma.notificationChannel.deleteMany({});
      await prisma.notificationTemplate.deleteMany({});
      await prisma.monitorMatch.deleteMany({});
      await prisma.monitorRecord.deleteMany({});
      await prisma.appUserAccess.deleteMany({
        where: { username: { in: [adminUsername, viewerUsername, ruleAdminUsername] } },
      });
      await prisma.appUser.deleteMany({
        where: { username: { in: [adminUsername, viewerUsername, ruleAdminUsername] } },
      });
    }
    if (app) await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    if (!dbAvailable) return;
    fakeSender.send.mockClear();
    // Same FK order as afterAll - a rule bound to a channel from a prior test
    // would otherwise block the channel/template delete (Restrict).
    await prisma.pushDelivery.deleteMany({});
    await prisma.pushLog.deleteMany({});
    await prisma.notificationRuleChannel.deleteMany({});
    await prisma.notificationRule.deleteMany({});
    await prisma.notificationChannel.deleteMany({});
    await prisma.notificationTemplate.deleteMany({});
  });

  it('DB availability probe (informational, always runs)', () => {
    if (!dbAvailable) {
      // eslint-disable-next-line no-console
      console.warn(
        'notifications.e2e-spec.ts: all subsequent cases are NO-OPS because no live Postgres was reachable.',
      );
    }
    expect(true).toBe(true);
  });

  itWithDb('channel lifecycle: create -> masked read -> rename without webhookUrl -> replace webhookUrl', async () => {
    const channel = await createChannel();

    // Read contract: webhookUrlMasked only, plaintext never returned.
    expect(channel.webhookUrlMasked).toContain('e2e-****');
    expect(channel.webhookUrlMasked).not.toContain('e2e-secret-123');
    expect(channel.webhookUrl).toBeUndefined();

    const list = await adminAgent.get('/api/notification-channels').expect(200);
    expect(list.body).toMatchObject({ page: 1, pageSize: 20 });
    expect(list.body.total).toBe(1);
    expect(list.body.items[0].webhookUrlMasked).toContain('e2e-****');
    expect(list.body.items[0].webhookUrl).toBeUndefined();

    // PUT without webhookUrl: stored ciphertext preserved -> mask unchanged.
    const renamed = await adminAgent
      .put(`/api/notification-channels/${channel.id}`)
      .send({ name: '新群名' })
      .expect(200);
    expect(renamed.body.name).toBe('新群名');
    expect(renamed.body.webhookUrlMasked).toContain('e2e-****');

    // PUT with webhookUrl: replaced + re-encrypted -> new mask, old never leaks.
    const replaced = await adminAgent
      .put(`/api/notification-channels/${channel.id}`)
      .send({ webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=new-secret-999' })
      .expect(200);
    expect(replaced.body.webhookUrlMasked).toContain('new-****');
    expect(replaced.body.webhookUrlMasked).not.toContain('new-secret-999');

    // Unknown channel -> 404.
    await adminAgent
      .put('/api/notification-channels/00000000-0000-0000-0000-000000000000')
      .send({ name: 'x' })
      .expect(404);
  });

  itWithDb('template lifecycle: TEXT drops title, NEWS requires it, merged validation on update', async () => {
    // TEXT ignores a submitted title.
    const text = await createTemplate({
      name: '文本通知',
      msgType: 'TEXT',
      titleTemplate: '不该存',
      contentTemplate: '内容',
    });
    expect(text.titleTemplate).toBeNull();

    // NEWS without a title is a 400 (service-enforced).
    const newsNoTitle = await adminAgent
      .post('/api/notification-templates')
      .send({ name: '新闻', msgType: 'NEWS', contentTemplate: '内容' })
      .expect(400);
    expect(newsNoTitle.body.error.code).toBe('NOTIFICATION_TEMPLATE_TITLE_REQUIRED');

    const news = await createTemplate({
      name: '新闻',
      msgType: 'NEWS',
      titleTemplate: '  标题  ',
      contentTemplate: '内容',
    });
    expect(news.titleTemplate).toBe('标题');

    // NEWS -> TEXT drops the stored title.
    const toText = await adminAgent
      .put(`/api/notification-templates/${news.id}`)
      .send({ msgType: 'TEXT' })
      .expect(200);
    expect(toText.body.msgType).toBe('TEXT');
    expect(toText.body.titleTemplate).toBeNull();

    // TEXT -> NEWS without a title: merged result violates the contract -> 400.
    const backToNews = await adminAgent
      .put(`/api/notification-templates/${news.id}`)
      .send({ msgType: 'NEWS' })
      .expect(400);
    expect(backToNews.body.error.code).toBe('NOTIFICATION_TEMPLATE_TITLE_REQUIRED');

    // List filter by msgType.
    const list = await adminAgent.get('/api/notification-templates').query({ msgType: 'NEWS' }).expect(200);
    expect(list.body.total).toBe(0);

    // Unknown template -> 404.
    await adminAgent
      .put('/api/notification-templates/00000000-0000-0000-0000-000000000000')
      .send({ name: 'x' })
      .expect(404);
  });

  itWithDb('variables dictionary exposes the 7 fixed placeholders', async () => {
    const res = await adminAgent.get('/api/notification-templates/variables').expect(200);
    expect(res.body).toHaveLength(7);
    expect(res.body.map((v: any) => v.key)).toEqual([
      'reportDate',
      'hospitalName',
      'redCount',
      'yellowCount',
      'greenCount',
      'unclassifiedCount',
      'totalCount',
    ]);
  });

  itWithDb('preset content templates are exposed to any authenticated user', async () => {
    const res = await adminAgent.get('/api/notification-templates/presets').expect(200);
    expect(res.body).toHaveLength(3);
    expect(res.body.map((p: any) => p.id)).toEqual(['red-alert', 'daily-summary', 'quick-alert']);
    for (const preset of res.body) {
      expect(typeof preset.name).toBe('string');
      expect(preset.name.length).toBeGreaterThan(0);
      expect(preset.content).toContain('{{');
    }
  });

  itWithDb('test-send renders LIVE summary counts and pushes the decrypted markdown payload', async () => {
    const channel = await createChannel();
    const template = await createTemplate({
      name: '日报',
      msgType: 'TEXT',
      contentTemplate:
        '{{reportDate}} {{hospitalName}} 红色{{redCount}} 黄{{yellowCount}} 绿{{greenCount}} 未分类{{unclassifiedCount}} 共{{totalCount}}',
    });

    const summary = await adminAgent.get('/api/monitor/summary').expect(200);

    const res = await adminAgent
      .post(`/api/notification-channels/${channel.id}/test-send`)
      .send({ templateId: template.id })
      .expect(200);
    expect(res.body.success).toBe(true);
    // Rendered numbers must match the live summary endpoint (design §4).
    expect(res.body.renderedContent).toContain(`红色${summary.body.red}`);
    expect(res.body.renderedContent).toContain(`黄${summary.body.yellow}`);
    expect(res.body.renderedContent).toContain(`绿${summary.body.green}`);
    expect(res.body.renderedContent).toContain(`未分类${summary.body.unclassified}`);
    expect(res.body.renderedContent).toContain(`共${summary.body.total}`);
    expect(res.body.renderedContent).toContain('菏泽市中医医院');

    // The sender got the DECRYPTED webhook URL and the markdown shape.
    expect(fakeSender.send).toHaveBeenCalledTimes(1);
    const [url, message] = fakeSender.send.mock.calls[0];
    expect(url).toContain('e2e-secret-123');
    expect(message.msgType).toBe('TEXT');
    expect(message.renderedContent).toBe(res.body.renderedContent);

    // Audit hygiene (design §7): the test-send audit row never carries the
    // rendered body.
    const auditRow = await prisma.auditLog.findFirst({
      where: { action: 'NOTIFICATION_TEST_SEND' as never },
      orderBy: { createdAt: 'desc' },
    });
    expect(auditRow).not.toBeNull();
    expect(JSON.stringify((auditRow as any).meta)).not.toContain('红色');
  });

  itWithDb('test-send maps a WeCom rejection to 502 with errcode/errmsg details', async () => {
    const channel = await createChannel();
    const template = await createTemplate({ name: '日报', msgType: 'TEXT', contentTemplate: '内容' });
    fakeSender.send.mockRejectedValueOnce(new WecomWebhookError(93000, 'invalid webhook key'));

    const res = await adminAgent
      .post(`/api/notification-channels/${channel.id}/test-send`)
      .send({ templateId: template.id })
      .expect(502);
    expect(res.body.error.code).toBe('NOTIFICATION_SEND_FAILED');
    expect(res.body.error.details).toEqual({ wecomErrCode: 93000, wecomErrMsg: 'invalid webhook key' });
  });

  itWithDb('test-send rejects disabled channel/template and unknown ids with 4xx and never pushes', async () => {
    const channel = await createChannel();
    const template = await createTemplate({ name: '日报', msgType: 'TEXT', contentTemplate: '内容' });

    await adminAgent.put(`/api/notification-channels/${channel.id}`).send({ isEnabled: false }).expect(200);
    const disabledChannel = await adminAgent
      .post(`/api/notification-channels/${channel.id}/test-send`)
      .send({ templateId: template.id })
      .expect(400);
    expect(disabledChannel.body.error.code).toBe('NOTIFICATION_CHANNEL_DISABLED');

    await adminAgent.put(`/api/notification-channels/${channel.id}`).send({ isEnabled: true }).expect(200);
    await adminAgent.put(`/api/notification-templates/${template.id}`).send({ isEnabled: false }).expect(200);
    const disabledTemplate = await adminAgent
      .post(`/api/notification-channels/${channel.id}/test-send`)
      .send({ templateId: template.id })
      .expect(400);
    expect(disabledTemplate.body.error.code).toBe('NOTIFICATION_TEMPLATE_DISABLED');

    await adminAgent
      .post('/api/notification-channels/00000000-0000-0000-0000-000000000000/test-send')
      .send({ templateId: template.id })
      .expect(404);

    expect(fakeSender.send).not.toHaveBeenCalled();
  });

  itWithDb('viewer and rule_admin are forbidden from writes and test-send (403)', async () => {
    await viewerAgent
      .post('/api/notification-channels')
      .send({ name: 'x', webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x' })
      .expect(403);
    await viewerAgent
      .post('/api/notification-templates')
      .send({ name: 'x', msgType: 'TEXT', contentTemplate: 'x' })
      .expect(403);

    const ruleAdminAgent = request.agent(app.getHttpServer());
    await ruleAdminAgent
      .post('/api/auth/login')
      .send({ username: ruleAdminUsername, password: authPassword })
      .expect(200);
    await ruleAdminAgent
      .post('/api/notification-channels/00000000-0000-0000-0000-000000000000/test-send')
      .send({ templateId: '00000000-0000-0000-0000-000000000000' })
      .expect(403);

    // Reads stay open to any authenticated user.
    await viewerAgent.get('/api/notification-channels').expect(200);
    await viewerAgent.get('/api/notification-templates').expect(200);
    await viewerAgent.get('/api/notification-templates/variables').expect(200);
  });

  // ---- push rules (issue: push rules) -------------------------------------

  const RULE_WINDOW = '2026-08-23';

  async function createRule(body: Record<string, unknown>): Promise<any> {
    const res = await adminAgent.post('/api/notification-rules').send(body).expect(201);
    return res.body;
  }

  itWithDb('rule lifecycle: create -> bindings -> list/get -> update replaces channels, bad cron rejected', async () => {
    const channel = await createChannel();
    const template = await createTemplate({
      name: '日报',
      msgType: 'TEXT',
      contentTemplate: '{{reportDate}} 共{{totalCount}}例',
    });

    const rule = await createRule({
      name: '每日 9 点',
      cron: '0 9 * * *',
      templateId: template.id,
      channelIds: [channel.id],
      isEnabled: true,
    });
    expect(rule).toMatchObject({
      name: '每日 9 点',
      cron: '0 9 * * *',
      templateId: template.id,
      templateName: '日报',
      isEnabled: true,
    });
    expect(rule.channels).toEqual([{ id: expect.any(String), channelId: channel.id, name: '总值班室群' }]);

    const list = await adminAgent.get('/api/notification-rules').expect(200);
    expect(list.body).toMatchObject({ page: 1, pageSize: 20, total: 1 });
    expect(list.body.items[0].channels).toEqual(rule.channels);

    const fetched = await adminAgent.get(`/api/notification-rules/${rule.id}`).expect(200);
    expect(fetched.body.name).toBe('每日 9 点');

    // Channel bindings replace as a whole.
    const channel2 = await createChannel(
      '护理部群',
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=second-secret',
    );
    const updated = await adminAgent
      .put(`/api/notification-rules/${rule.id}`)
      .send({ name: '每日 8 点', channelIds: [channel2.id] })
      .expect(200);
    expect(updated.body.name).toBe('每日 8 点');
    expect(updated.body.channels).toEqual([{ id: expect.any(String), channelId: channel2.id, name: '护理部群' }]);

    // An invalid cron is rejected by the DTO (shared validator) before any write.
    const badCron = await adminAgent
      .post('/api/notification-rules')
      .send({ name: 'x', cron: 'not a cron', templateId: template.id, channelIds: [channel2.id] })
      .expect(400);
    expect(badCron.body.error.code).toBe('BAD_REQUEST');
    expect(badCron.body.error.message).toContain('cron');

    // Empty channel selection is rejected too.
    await adminAgent
      .post('/api/notification-rules')
      .send({ name: 'x', cron: '0 9 * * *', templateId: template.id, channelIds: [] })
      .expect(400);
  });

  itWithDb('manual run pushes the TODAY-NEW-REPORT window summary into a PushLog + delivery and audits it', async () => {
    const channel = await createChannel(
      '总值班室群',
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=e2e-rule-secret',
    );
    const template = await createTemplate({
      name: '日报',
      msgType: 'TEXT',
      contentTemplate: '{{reportDate}} {{hospitalName}} 红{{redCount}} 黄{{yellowCount}} 绿{{greenCount}} 共{{totalCount}}',
    });
    const rule = await createRule({
      name: '每日 9 点',
      cron: '0 9 * * *',
      templateId: template.id,
      channelIds: [channel.id],
    });

    const res = await adminAgent
      .post(`/api/notification-rules/${rule.id}/run`)
      .query({ windowDate: RULE_WINDOW })
      .expect(200);
    expect(res.body).toMatchObject({ alreadyPushed: false, status: 'SUCCESS' });
    expect(res.body.deliveries).toHaveLength(1);
    expect(res.body.deliveries[0]).toMatchObject({
      channelId: channel.id,
      channelName: '总值班室群',
      status: 'SUCCESS',
      wecomErrCode: null,
      wecomErrMsg: null,
    });

    // PushLog is the audit trail for a run.
    const log = await prisma.pushLog.findUnique({ where: { id: res.body.pushLogId } });
    expect(log).toMatchObject({
      ruleId: rule.id,
      windowDate: RULE_WINDOW,
      trigger: 'MANUAL',
      status: 'SUCCESS',
    });
    expect(log?.errorSummary).toBeNull();

    const delivery = await prisma.pushDelivery.findFirst({ where: { pushLogId: res.body.pushLogId } });
    expect(delivery).toMatchObject({ channelId: channel.id, status: 'SUCCESS', wecomErrCode: null, wecomErrMsg: null });
    expect(delivery?.sentAt).not.toBeNull();

    // The sender got the decrypted URL + the window-summary render. The 4th
    // record (examTime 00:00+08 NEXT day) is excluded by the lt boundary.
    expect(fakeSender.send).toHaveBeenCalledTimes(1);
    const [url, message] = fakeSender.send.mock.calls[0];
    expect(url).toContain('e2e-rule-secret');
    expect(message.renderedContent).toBe('2026-08-23 菏泽市中医医院 红1 黄1 绿1 共3');

    // Audit: the manual run records NOTIFICATION_RULE_RUN with the outcome.
    const auditRow = await prisma.auditLog.findFirst({
      where: { action: 'NOTIFICATION_RULE_RUN' as never },
      orderBy: { createdAt: 'desc' },
    });
    expect(auditRow).not.toBeNull();
    expect((auditRow as any).meta).toMatchObject({
      result: 'executed',
      status: 'SUCCESS',
      pushLogId: res.body.pushLogId,
    });
  });

  itWithDb('SCHEDULED executor dedupes a second run of the same window via the partial unique index', async () => {
    const channel = await createChannel();
    const template = await createTemplate({ name: '日报', msgType: 'TEXT', contentTemplate: '{{totalCount}}' });
    const rule = await createRule({
      name: '每日 9 点',
      cron: '0 9 * * *',
      templateId: template.id,
      channelIds: [channel.id],
    });

    const executor = app.get(NotificationRuleExecutor);
    const now = new Date('2026-08-23T01:00:00Z'); // 09:00 Shanghai - the cron minute.
    const first = await executor.execute({ ruleId: rule.id, trigger: 'SCHEDULED', windowDate: RULE_WINDOW, now });
    expect(first).toMatchObject({ alreadyPushed: false, status: 'SUCCESS' });

    const second = await executor.execute({ ruleId: rule.id, trigger: 'SCHEDULED', windowDate: RULE_WINDOW, now });
    expect(second).toMatchObject({ alreadyPushed: true, status: null, deliveries: [] });

    // One PushLog row for the window regardless of how many ticks raced.
    const logCount = await prisma.pushLog.count({ where: { ruleId: rule.id, windowDate: RULE_WINDOW } });
    expect(logCount).toBe(1);
    expect(fakeSender.send).toHaveBeenCalledTimes(1);
  });

  itWithDb('viewer is forbidden from rule writes/runs but can read rules and push logs', async () => {
    const channel = await createChannel();
    const template = await createTemplate({ name: '日报', msgType: 'TEXT', contentTemplate: 'x' });
    const rule = await createRule({
      name: '每日 9 点',
      cron: '0 9 * * *',
      templateId: template.id,
      channelIds: [channel.id],
    });

    await viewerAgent
      .post('/api/notification-rules')
      .send({ name: 'x', cron: '0 9 * * *', templateId: template.id, channelIds: [channel.id] })
      .expect(403);
    await viewerAgent.put(`/api/notification-rules/${rule.id}`).send({ name: 'x' }).expect(403);
    await viewerAgent.post(`/api/notification-rules/${rule.id}/run`).send({}).expect(403);

    await viewerAgent.get('/api/notification-rules').expect(200);
    await viewerAgent.get(`/api/notification-rules/${rule.id}`).expect(200);
    await viewerAgent.get(`/api/notification-rules/${rule.id}/push-logs`).expect(200);
  });
});

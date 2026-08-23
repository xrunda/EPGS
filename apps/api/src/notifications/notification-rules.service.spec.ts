import { NotificationRulesService } from './notification-rules.service';
import { NotificationRuleNotFoundException } from './errors/notification-rule-not-found.exception';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationRuleExecutor, NotificationRuleNotFoundError } from '@epgs/notification-push';

/**
 * Service-layer tests for push rules (issue: push rules). Prisma + the shared
 * executor are mocked; these run DB-free (the e2e suite needs a live Postgres).
 * Coverage: referential integrity (template/channel/no-channels), nested-create
 * of channel bindings, replace-as-a-whole update, pagination, and the manual
 * run delegation + 404 mapping.
 */
describe('NotificationRulesService', () => {
  let prisma: {
    $transaction: jest.Mock;
    notificationRule: Record<string, jest.Mock>;
    notificationChannel: Record<string, jest.Mock>;
    notificationTemplate: Record<string, jest.Mock>;
    pushLog: Record<string, jest.Mock>;
  };
  let executor: { execute: jest.Mock };
  let service: NotificationRulesService;

  function makeRuleRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'rule-1',
      name: '每日 9 点',
      cron: '0 9 * * *',
      templateId: 'template-1',
      isEnabled: true,
      createdAt: new Date('2026-08-23T00:00:00Z'),
      updatedAt: new Date('2026-08-23T00:00:00Z'),
      createdBy: 'zhang.san',
      updatedBy: 'zhang.san',
      template: { id: 'template-1', name: '日报' },
      ruleChannels: [{ id: 'rc-1', channelId: 'channel-1', channel: { id: 'channel-1', name: '总值班室群' } }],
      ...overrides,
    };
  }

  function makePushLogRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'log-1',
      ruleId: 'rule-1',
      windowDate: '2026-08-23',
      trigger: 'MANUAL',
      status: 'SUCCESS',
      errorSummary: null,
      startedAt: new Date('2026-08-23T01:00:00Z'),
      finishedAt: new Date('2026-08-23T01:00:01Z'),
      deliveries: [
        {
          id: 'delivery-1',
          channelId: 'channel-1',
          status: 'SUCCESS',
          wecomErrCode: null,
          wecomErrMsg: null,
          sentAt: new Date('2026-08-23T01:00:01Z'),
          channel: { id: 'channel-1', name: '总值班室群' },
        },
      ],
      // The mapper denormalizes rule/template names for the aggregated view.
      rule: {
        id: 'rule-1',
        name: '每日 9 点',
        template: { id: 'template-1', name: '日报' },
      },
      ...overrides,
    };
  }

  beforeEach(() => {
    prisma = {
      $transaction: jest.fn(async (queries: Promise<unknown>[]) => Promise.all(queries)),
      notificationRule: {
        findMany: jest.fn(async () => [makeRuleRow()]),
        count: jest.fn(async () => 1),
        findUnique: jest.fn(async () => makeRuleRow()),
        create: jest.fn(async () => makeRuleRow()),
        update: jest.fn(async () => makeRuleRow()),
      },
      notificationChannel: {
        findMany: jest.fn(async () => [{ id: 'channel-1' }]),
      },
      notificationTemplate: {
        findUnique: jest.fn(async () => ({ id: 'template-1' })),
      },
      pushLog: {
        findMany: jest.fn(async () => [makePushLogRow()]),
        count: jest.fn(async () => 1),
      },
    };
    executor = {
      execute: jest.fn(async () => ({
        alreadyPushed: false,
        pushLogId: 'log-1',
        status: 'SUCCESS',
        deliveries: [],
      })),
    };
    service = new NotificationRulesService(prisma as unknown as PrismaService, executor as unknown as NotificationRuleExecutor);
  });

  const createBody = (overrides: Record<string, unknown> = {}) => ({
    name: '每日 9 点',
    cron: '0 9 * * *',
    templateId: 'template-1',
    channelIds: ['channel-1'],
    isEnabled: true,
    ...overrides,
  });

  describe('createRule', () => {
    it('rejects a rule bound to no channels', async () => {
      await expect(service.createRule(createBody({ channelIds: [] }), 'zhang.san')).rejects.toMatchObject({
        name: 'BadRequestException',
        message: expect.stringContaining('at least one channel'),
      });
      expect(prisma.notificationRule.create).not.toHaveBeenCalled();
    });

    it('rejects a rule whose template is missing', async () => {
      prisma.notificationTemplate.findUnique.mockResolvedValueOnce(null);

      await expect(service.createRule(createBody(), 'zhang.san')).rejects.toMatchObject({
        name: 'NotFoundException',
        message: expect.stringContaining('template-1'),
      });
      expect(prisma.notificationRule.create).not.toHaveBeenCalled();
    });

    it('rejects a rule referencing an unknown channel', async () => {
      prisma.notificationChannel.findMany.mockResolvedValueOnce([{ id: 'channel-1' }]);

      await expect(
        service.createRule(createBody({ channelIds: ['channel-1', 'channel-missing'] }), 'zhang.san'),
      ).rejects.toMatchObject({
        name: 'NotFoundException',
        message: expect.stringContaining('channel-missing'),
      });
      expect(prisma.notificationRule.create).not.toHaveBeenCalled();
    });

    it('creates the rule with nested channel bindings and returns the DTO', async () => {
      const dto = await service.createRule(createBody(), 'zhang.san');

      expect(prisma.notificationRule.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          name: '每日 9 点',
          cron: '0 9 * * *',
          templateId: 'template-1',
          isEnabled: true,
          createdBy: 'zhang.san',
          updatedBy: 'zhang.san',
          ruleChannels: { create: [{ channelId: 'channel-1' }] },
        }),
        include: { template: true, ruleChannels: { include: { channel: true } } },
      });
      expect(dto).toEqual({
        id: 'rule-1',
        name: '每日 9 点',
        cron: '0 9 * * *',
        templateId: 'template-1',
        templateName: '日报',
        channels: [{ id: 'rc-1', channelId: 'channel-1', name: '总值班室群' }],
        isEnabled: true,
        createdAt: '2026-08-23T00:00:00.000Z',
        updatedAt: '2026-08-23T00:00:00.000Z',
        createdBy: 'zhang.san',
        updatedBy: 'zhang.san',
      });
    });

    it('falls back to the DTO actorId when no username is present', async () => {
      await service.createRule(createBody({ actorId: 'li.si' }), undefined);

      const createCall = prisma.notificationRule.create.mock.calls[0][0];
      expect(createCall.data.createdBy).toBe('li.si');
      expect(createCall.data.updatedBy).toBe('li.si');
    });
  });

  describe('updateRule', () => {
    it('replaces channel bindings as a whole when channelIds is given', async () => {
      prisma.notificationChannel.findMany.mockResolvedValueOnce([{ id: 'channel-2' }]);
      await service.updateRule('rule-1', { channelIds: ['channel-2'] }, 'zhang.san');

      // Referential check uses the stored templateId (incoming one absent).
      expect(prisma.notificationChannel.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['channel-2'] } },
        select: { id: true },
      });
      const updateCall = prisma.notificationRule.update.mock.calls[0][0];
      expect(updateCall.data.ruleChannels).toEqual({
        deleteMany: {},
        create: [{ channelId: 'channel-2' }],
      });
    });

    it('merges an incoming templateId into the referential check for channelIds', async () => {
      prisma.notificationChannel.findMany.mockResolvedValueOnce([{ id: 'channel-2' }]);
      await service.updateRule('rule-1', { templateId: 'template-9', channelIds: ['channel-2'] }, 'zhang.san');

      expect(prisma.notificationTemplate.findUnique).toHaveBeenCalledWith({
        where: { id: 'template-9' },
        select: { id: true },
      });
    });

    it('re-checks only the template when changing templateId without touching channels', async () => {
      await service.updateRule('rule-1', { templateId: 'template-9' }, 'zhang.san');

      expect(prisma.notificationTemplate.findUnique).toHaveBeenCalledWith({
        where: { id: 'template-9' },
        select: { id: true },
      });
      expect(prisma.notificationChannel.findMany).not.toHaveBeenCalled();
    });

    it('is a 404 for a rule that does not exist', async () => {
      prisma.notificationRule.findUnique.mockResolvedValueOnce(null);

      await expect(service.updateRule('missing', { name: 'x' }, 'zhang.san')).rejects.toBeInstanceOf(
        NotificationRuleNotFoundException,
      );
      expect(prisma.notificationRule.update).not.toHaveBeenCalled();
    });
  });

  describe('listRules', () => {
    it('returns a paginated page with the default page size', async () => {
      const page = await service.listRules({});

      expect(prisma.notificationRule.findMany).toHaveBeenCalledWith({
        where: {},
        orderBy: [{ updatedAt: 'desc' }],
        skip: 0,
        take: 20,
        include: { template: true, ruleChannels: { include: { channel: true } } },
      });
      expect(page).toEqual({
        items: [expect.objectContaining({ id: 'rule-1', templateName: '日报' })],
        total: 1,
        page: 1,
        pageSize: 20,
      });
    });

    it('forwards an isEnabled filter and pagination offsets', async () => {
      await service.listRules({ isEnabled: false, page: 2, pageSize: 5 });

      expect(prisma.notificationRule.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { isEnabled: false },
          skip: 5,
          take: 5,
        }),
      );
    });
  });

  describe('listPushLogs', () => {
    it('verifies the rule exists, then returns its logs with channel names', async () => {
      const page = await service.listPushLogs('rule-1', {});

      expect(prisma.notificationRule.findUnique).toHaveBeenCalledWith({
        where: { id: 'rule-1' },
        include: { template: true, ruleChannels: { include: { channel: true } } },
      });
      expect(prisma.pushLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { ruleId: 'rule-1' },
          orderBy: [{ startedAt: 'desc' }],
        }),
      );
      expect(page).toEqual({
        items: [
          {
            id: 'log-1',
            ruleId: 'rule-1',
            ruleName: '每日 9 点',
            templateName: '日报',
            windowDate: '2026-08-23',
            trigger: 'MANUAL',
            status: 'SUCCESS',
            errorSummary: null,
            startedAt: '2026-08-23T01:00:00.000Z',
            finishedAt: '2026-08-23T01:00:01.000Z',
            deliveries: [
              {
                id: 'delivery-1',
                channelId: 'channel-1',
                channelName: '总值班室群',
                status: 'SUCCESS',
                wecomErrCode: null,
                wecomErrMsg: null,
                sentAt: '2026-08-23T01:00:01.000Z',
              },
            ],
          },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
      });
    });

    it('is a 404 for an unknown rule', async () => {
      prisma.notificationRule.findUnique.mockResolvedValueOnce(null);

      await expect(service.listPushLogs('missing', {})).rejects.toBeInstanceOf(NotificationRuleNotFoundException);
      expect(prisma.pushLog.findMany).not.toHaveBeenCalled();
    });
  });

  describe('listAllPushLogs', () => {
    it('returns logs across all rules without a rule existence check', async () => {
      const page = await service.listAllPushLogs({});

      // No findRuleOrThrow up front - the aggregated「日志」tab must not 404
      // when a rule no longer matches; PushLog keeps a Restrict FK to the rule.
      expect(prisma.notificationRule.findUnique).not.toHaveBeenCalled();
      expect(prisma.pushLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {},
          orderBy: [{ startedAt: 'desc' }],
          include: {
            deliveries: { include: { channel: true }, orderBy: { id: 'asc' } },
            rule: { include: { template: true } },
          },
        }),
      );
      expect(page).toEqual({
        items: [
          {
            id: 'log-1',
            ruleId: 'rule-1',
            ruleName: '每日 9 点',
            templateName: '日报',
            windowDate: '2026-08-23',
            trigger: 'MANUAL',
            status: 'SUCCESS',
            errorSummary: null,
            startedAt: '2026-08-23T01:00:00.000Z',
            finishedAt: '2026-08-23T01:00:01.000Z',
            deliveries: [
              {
                id: 'delivery-1',
                channelId: 'channel-1',
                channelName: '总值班室群',
                status: 'SUCCESS',
                wecomErrCode: null,
                wecomErrMsg: null,
                sentAt: '2026-08-23T01:00:01.000Z',
              },
            ],
          },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
      });
    });

    it('honours pagination and passes page/pageSize through', async () => {
      await service.listAllPushLogs({ page: 3, pageSize: 50 });

      expect(prisma.pushLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 100, take: 50 }),
      );
    });
  });

  describe('runRule (manual run now)', () => {
    it('delegates to the shared executor with MANUAL trigger and the caller scope', async () => {
      executor.execute.mockResolvedValueOnce({
        alreadyPushed: false,
        pushLogId: 'log-1',
        status: 'SUCCESS',
        deliveries: [
          {
            id: 'delivery-1',
            channelId: 'channel-1',
            channelName: '总值班室群',
            status: 'SUCCESS',
            wecomErrCode: null,
            wecomErrMsg: null,
            sentAt: '2026-08-23T01:00:01Z',
          },
        ],
      });

      const result = await service.runRule('rule-1', '2026-08-22', ['骨科']);

      expect(executor.execute).toHaveBeenCalledWith({
        ruleId: 'rule-1',
        trigger: 'MANUAL',
        windowDate: '2026-08-22',
        scope: ['骨科'],
      });
      expect(result).toEqual({
        alreadyPushed: false,
        pushLogId: 'log-1',
        status: 'SUCCESS',
        deliveries: [
          {
            id: 'delivery-1',
            channelId: 'channel-1',
            channelName: '总值班室群',
            status: 'SUCCESS',
            wecomErrCode: null,
            wecomErrMsg: null,
            sentAt: '2026-08-23T01:00:01Z',
          },
        ],
      });
    });

    it('omits windowDate when absent (executor defaults it to today Shanghai)', async () => {
      await service.runRule('rule-1');
      expect(executor.execute).toHaveBeenCalledWith({ ruleId: 'rule-1', trigger: 'MANUAL', windowDate: undefined, scope: undefined });
    });

    it('maps the shared NotificationRuleNotFoundError to a Nest 404', async () => {
      executor.execute.mockRejectedValueOnce(new NotificationRuleNotFoundError('rule-1'));

      await expect(service.runRule('rule-1')).rejects.toBeInstanceOf(NotificationRuleNotFoundException);
    });

    it('rethrows unexpected executor failures unchanged', async () => {
      executor.execute.mockRejectedValueOnce(new Error('db exploded'));

      await expect(service.runRule('rule-1')).rejects.toThrow('db exploded');
    });
  });

  it('getRule returns the DTO', async () => {
    const rule = await service.getRule('rule-1');
    expect(rule.id).toBe('rule-1');
    expect(rule.templateName).toBe('日报');
  });
});

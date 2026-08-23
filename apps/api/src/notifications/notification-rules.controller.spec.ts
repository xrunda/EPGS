import { NotificationRulesController } from './notification-rules.controller';
import { NotificationRuleNotFoundException } from './errors/notification-rule-not-found.exception';
import { AuditAction, AppRole } from '@prisma/client';

/**
 * Controller-layer tests for push-rule endpoints (issue: push rules): audit
 * behavior of create/update/run + run's scope/windowDate plumbing. Services are
 * mocked - the role-gating decorators are metadata-only and not exercised here
 * (the notifications e2e suite covers the 403 matrix against real guards).
 */
describe('NotificationRulesController', () => {
  let service: any;
  let audit: any;
  let controller: NotificationRulesController;

  const user: any = {
    username: 'zhang.san',
    roles: [AppRole.SYSTEM_ADMIN],
    departmentScope: ['骨科'],
  };
  const request: any = { ip: '127.0.0.1', correlationId: 'corr-1' };

  const ruleFixture = (overrides: Record<string, unknown> = {}) => ({
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
    ...overrides,
  });

  beforeEach(() => {
    service = {
      listRules: jest.fn(),
      getRule: jest.fn(async (id: string) => ruleFixture({ id })),
      createRule: jest.fn(async () => ruleFixture()),
      updateRule: jest.fn(async (id: string) => ruleFixture({ id })),
      listPushLogs: jest.fn(),
      runRule: jest.fn(async () => ({
        alreadyPushed: false,
        pushLogId: 'log-1',
        windowDate: '2026-08-23',
        status: 'SUCCESS',
        deliveries: [],
      })),
    };
    audit = { record: jest.fn(async () => undefined) };
    controller = new NotificationRulesController(service, audit);
  });

  describe('rule writes', () => {
    it('creates a rule and records CONFIG_CHANGE with config meta, never a webhook/URL', async () => {
      await controller.create(
        {
          name: '每日 9 点',
          cron: '0 9 * * *',
          templateId: 'template-1',
          channelIds: ['channel-1'],
          isEnabled: true,
        } as any,
        user,
        request,
      );

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.CONFIG_CHANGE,
          actorUsername: 'zhang.san',
          resourceType: 'notification_rule',
          resourceId: 'rule-1',
          meta: {
            name: '每日 9 点',
            cron: '0 9 * * *',
            templateId: 'template-1',
            channelIds: ['channel-1'],
            isEnabled: true,
          },
        }),
      );
      const recorded = audit.record.mock.calls[0][0];
      expect(JSON.stringify(recorded.meta)).not.toContain('webhook');
    });

    it('updates a rule and records CONFIG_CHANGE', async () => {
      await controller.update('rule-1', { name: '新规则' } as any, user, request);

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.CONFIG_CHANGE,
          resourceId: 'rule-1',
          actorUsername: 'zhang.san',
        }),
      );
    });
  });

  describe('manual run', () => {
    it('passes the caller department scope and default window, then audits NOTIFICATION_RULE_RUN', async () => {
      await controller.run('rule-1', {}, user, request);

      expect(service.runRule).toHaveBeenCalledWith('rule-1', undefined, ['骨科']);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.NOTIFICATION_RULE_RUN,
          actorUsername: 'zhang.san',
          resourceType: 'notification_rule',
          resourceId: 'rule-1',
          meta: { result: 'executed', status: 'SUCCESS', pushLogId: 'log-1' },
        }),
      );
    });

    it('passes windowDate through for a historical re-push', async () => {
      await controller.run('rule-1', { windowDate: '2026-08-22' }, user, request);
      expect(service.runRule).toHaveBeenCalledWith('rule-1', '2026-08-22', ['骨科']);
    });

    it('audits already_pushed when the executor deduped the run', async () => {
      service.runRule.mockResolvedValueOnce({
        alreadyPushed: true,
        pushLogId: null,
        windowDate: '2026-08-23',
        status: null,
        deliveries: [],
      });

      await controller.run('rule-1', {}, user, request);

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          meta: { result: 'already_pushed', status: null, pushLogId: null },
        }),
      );
    });

    it('does NOT audit a 404 run (rule missing) - no execution happened', async () => {
      service.runRule.mockRejectedValueOnce(new NotificationRuleNotFoundException('missing'));

      await expect(controller.run('missing', {}, user, request)).rejects.toBeInstanceOf(
        NotificationRuleNotFoundException,
      );
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('reads', () => {
    it('list / get / push-logs forward without auditing', async () => {
      await controller.list({} as any);
      await controller.get('rule-1');
      await controller.listPushLogs('rule-1', {} as any);

      expect(service.listRules).toHaveBeenCalledTimes(1);
      expect(service.getRule).toHaveBeenCalledTimes(1);
      expect(service.listPushLogs).toHaveBeenCalledTimes(1);
      expect(audit.record).not.toHaveBeenCalled();
    });
  });
});

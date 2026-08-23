import { NotificationChannelsController } from './notification-channels.controller';
import { NotificationTemplatesController } from './notification-templates.controller';
import { NotificationSendException } from './errors/notification-send.exception';
import { NotificationChannelNotFoundException } from './errors/notification-channel-not-found.exception';
import { AuditAction, AppRole } from '@prisma/client';

/**
 * Controller-layer tests: audit-trail behavior for the notification write +
 * test-send endpoints (issue #54, design §7). Services are mocked - the
 * role-gating decorators are metadata-only and not exercised here (the
 * security e2e suite covers the 403 matrix against real guards).
 */
describe('Notification controllers', () => {
  let service: any;
  let testSend: any;
  let audit: any;
  let channelsController: NotificationChannelsController;
  let templatesController: NotificationTemplatesController;

  const user: any = {
    username: 'zhang.san',
    roles: [AppRole.SYSTEM_ADMIN],
    departmentScope: ['骨科'],
  };
  const request: any = { ip: '127.0.0.1', correlationId: 'corr-1' };

  beforeEach(() => {
    service = {
      listChannels: jest.fn(),
      createChannel: jest.fn(async (dto: any) => ({
        id: 'channel-1',
        name: dto.name,
        webhookUrlMasked: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=8d24****',
        isEnabled: true,
        createdAt: '2026-08-23T00:00:00.000Z',
        updatedAt: '2026-08-23T00:00:00.000Z',
        createdBy: 'zhang.san',
        updatedBy: 'zhang.san',
      })),
      updateChannel: jest.fn(async (id: string, dto: any) => ({
        id,
        name: dto.name ?? '总值班室群',
        webhookUrlMasked: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=8d24****',
        isEnabled: dto.isEnabled ?? true,
        createdAt: '2026-08-23T00:00:00.000Z',
        updatedAt: '2026-08-23T00:00:00.000Z',
        createdBy: 'zhang.san',
        updatedBy: 'zhang.san',
      })),
      listTemplates: jest.fn(),
      createTemplate: jest.fn(async (dto: any) => ({
        id: 'template-1',
        name: dto.name,
        msgType: dto.msgType,
        titleTemplate: dto.titleTemplate ?? null,
        contentTemplate: dto.contentTemplate,
        coverImageUrl: null,
        linkUrl: null,
        isEnabled: true,
        createdAt: '2026-08-23T00:00:00.000Z',
        updatedAt: '2026-08-23T00:00:00.000Z',
        createdBy: 'zhang.san',
        updatedBy: 'zhang.san',
      })),
      updateTemplate: jest.fn(async (id: string, dto: any) => ({
        id,
        name: dto.name ?? '红色预警通知',
        msgType: dto.msgType ?? 'TEXT',
        titleTemplate: dto.titleTemplate ?? null,
        contentTemplate: dto.contentTemplate ?? '内容',
        coverImageUrl: null,
        linkUrl: null,
        isEnabled: true,
        createdAt: '2026-08-23T00:00:00.000Z',
        updatedAt: '2026-08-23T00:00:00.000Z',
        createdBy: 'zhang.san',
        updatedBy: 'zhang.san',
      })),
    };
    testSend = {
      send: jest.fn(async () => ({
        success: true,
        renderedTitle: '',
        renderedContent: '2026-08-23 红色关注 3 例',
        sentAt: '2026-08-23T02:00:00.000Z',
      })),
    };
    audit = { record: jest.fn(async () => undefined) };

    channelsController = new NotificationChannelsController(service, testSend, audit);
    templatesController = new NotificationTemplatesController(service, audit);
  });

  describe('channel writes', () => {
    it('creates a channel and records CONFIG_CHANGE with meta that excludes any webhook value', async () => {
      await channelsController.create(
        { name: '总值班室群', webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret-123' } as any,
        user,
        request,
      );

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.CONFIG_CHANGE,
          actorUsername: 'zhang.san',
          resourceType: 'notification_channel',
          meta: { name: '总值班室群', isEnabled: true },
        }),
      );
      const recorded = audit.record.mock.calls[0][0];
      expect(JSON.stringify(recorded.meta)).not.toContain('secret-123');
      expect(JSON.stringify(recorded.meta)).not.toContain('webhook');
    });

    it('updates a channel and records CONFIG_CHANGE', async () => {
      await channelsController.update('channel-1', { name: '新群名' } as any, user, request);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.CONFIG_CHANGE,
          resourceId: 'channel-1',
          meta: { name: '新群名', isEnabled: true },
        }),
      );
    });
  });

  describe('test-send audit', () => {
    it('records a success audit row and returns the render result', async () => {
      const result = await channelsController.testSend('channel-1', { templateId: 'template-1' } as any, user, request);

      expect(result).toEqual(
        expect.objectContaining({ success: true, renderedContent: expect.stringContaining('红色关注') }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.NOTIFICATION_TEST_SEND,
          resourceId: 'channel-1',
          meta: { channelId: 'channel-1', templateId: 'template-1', result: 'success', httpStatus: 200 },
        }),
      );
      const recorded = audit.record.mock.calls[0][0];
      expect(JSON.stringify(recorded.meta)).not.toContain('红色关注');
    });

    it('records a failure audit row with the WeCom reason, then rethrows the 502', async () => {
      testSend.send.mockRejectedValueOnce(new NotificationSendException(93000, 'invalid webhook key'));

      await expect(
        channelsController.testSend('channel-1', { templateId: 'template-1' } as any, user, request),
      ).rejects.toBeInstanceOf(NotificationSendException);

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.NOTIFICATION_TEST_SEND,
          meta: expect.objectContaining({
            channelId: 'channel-1',
            templateId: 'template-1',
            result: 'failure',
            httpStatus: 502,
            wecomErrCode: 93000,
            wecomErrMsg: 'invalid webhook key',
          }),
        }),
      );
    });

    it('does NOT audit a 404 (channel not found) - no send was attempted', async () => {
      testSend.send.mockRejectedValueOnce(new NotificationChannelNotFoundException('missing'));

      await expect(
        channelsController.testSend('missing', { templateId: 'template-1' } as any, user, request),
      ).rejects.toBeInstanceOf(NotificationChannelNotFoundException);

      expect(audit.record).not.toHaveBeenCalled();
    });

    it('passes the caller department scope so a scoped admin renders their own scope', async () => {
      await channelsController.testSend('channel-1', { templateId: 'template-1' } as any, user, request);
      expect(testSend.send).toHaveBeenCalledWith('channel-1', 'template-1', ['骨科']);
    });
  });

  describe('template writes', () => {
    it('creates a template and records CONFIG_CHANGE with msgType', async () => {
      await templatesController.create(
        { name: '红色预警通知', msgType: 'TEXT', contentTemplate: '内容' } as any,
        user,
        request,
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.CONFIG_CHANGE,
          resourceType: 'notification_template',
          meta: { name: '红色预警通知', msgType: 'TEXT', isEnabled: true },
        }),
      );
    });

    it('updates a template and records CONFIG_CHANGE', async () => {
      await templatesController.update('template-1', { name: '新名称' } as any, user, request);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.CONFIG_CHANGE, resourceId: 'template-1' }),
      );
    });
  });

  describe('template reads', () => {
    it('forwards presets from the service, read-only with no audit row', async () => {
      const preset = { id: 'red-alert', name: '红色关注提醒', content: '{{hospitalName}} {{reportDate}} 红色关注 {{redCount}} 例' };
      service.getPresets = jest.fn(() => [preset]);

      expect(templatesController.presets()).toEqual([preset]);
      expect(service.getPresets).toHaveBeenCalledTimes(1);
      expect(audit.record).not.toHaveBeenCalled();
    });
  });
});

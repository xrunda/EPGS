import { NotificationsService } from './notifications.service';
import { NotificationChannelNotFoundException } from './errors/notification-channel-not-found.exception';
import { NotificationTemplateNotFoundException } from './errors/notification-template-not-found.exception';

/**
 * Unit tests against a mocked PrismaService + NotificationSecretCipher - no
 * real database or crypto. Business logic (encrypt-at-rest, write-only
 * webhookUrl, masked reads, NEWS-title-required, corrupted-ciphertext
 * resilience) in isolation; apps/api/test/notifications.e2e-spec.ts covers
 * the same scenarios against real Postgres per issue #54's verification
 * requirements.
 */
describe('NotificationsService', () => {
  let prisma: any;
  let cipher: any;
  let service: NotificationsService;
  let channelStore: Map<string, any>;
  let templateStore: Map<string, any>;

  function makeChannel(overrides: Record<string, any> = {}): any {
    const id = overrides.id ?? `channel-${Math.random().toString(36).slice(2)}`;
    const channel = {
      id,
      name: '总值班室群',
      webhookUrlCiphertext: 'enc:https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=8d24abcd-ef01',
      isEnabled: true,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      createdBy: 'tester',
      updatedBy: 'tester',
      ...overrides,
    };
    channelStore.set(id, channel);
    return channel;
  }

  function makeTemplate(overrides: Record<string, any> = {}): any {
    const id = overrides.id ?? `template-${Math.random().toString(36).slice(2)}`;
    const template = {
      id,
      name: '红色预警通知',
      msgType: 'TEXT',
      titleTemplate: null,
      contentTemplate: '{{reportDate}} 红色关注 {{redCount}} 例。',
      coverImageUrl: null,
      linkUrl: null,
      isEnabled: true,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      createdBy: 'tester',
      updatedBy: 'tester',
      ...overrides,
    };
    templateStore.set(id, template);
    return template;
  }

  beforeEach(() => {
    channelStore = new Map();
    templateStore = new Map();

    const notificationChannel = {
      findUnique: jest.fn(async ({ where: { id } }: any) => channelStore.get(id) ?? null),
      findMany: jest.fn(async ({ where, orderBy, skip, take }: any) => {
        let rows = Array.from(channelStore.values());
        if (where?.isEnabled !== undefined) rows = rows.filter((r) => r.isEnabled === where.isEnabled);
        if (orderBy?.[0]?.updatedAt === 'desc') rows = rows.sort((a, b) => b.updatedAt - a.updatedAt);
        return rows.slice(skip ?? 0, (skip ?? 0) + (take ?? rows.length));
      }),
      count: jest.fn(async ({ where }: any) => {
        let rows = Array.from(channelStore.values());
        if (where?.isEnabled !== undefined) rows = rows.filter((r) => r.isEnabled === where.isEnabled);
        return rows.length;
      }),
      create: jest.fn(async ({ data }: any) => {
        const channel = { id: `channel-${Math.random().toString(36).slice(2)}`, createdAt: new Date(), updatedAt: new Date(), ...data };
        channelStore.set(channel.id, channel);
        return channel;
      }),
      update: jest.fn(async ({ where: { id }, data }: any) => {
        const updated = { ...channelStore.get(id), ...data, updatedAt: new Date() };
        channelStore.set(id, updated);
        return updated;
      }),
    };

    const notificationTemplate = {
      findUnique: jest.fn(async ({ where: { id } }: any) => templateStore.get(id) ?? null),
      findMany: jest.fn(async ({ where, orderBy, skip, take }: any) => {
        let rows = Array.from(templateStore.values());
        if (where?.msgType) rows = rows.filter((r) => r.msgType === where.msgType);
        if (where?.isEnabled !== undefined) rows = rows.filter((r) => r.isEnabled === where.isEnabled);
        if (orderBy?.[0]?.updatedAt === 'desc') rows = rows.sort((a, b) => b.updatedAt - a.updatedAt);
        return rows.slice(skip ?? 0, (skip ?? 0) + (take ?? rows.length));
      }),
      count: jest.fn(async ({ where }: any) => {
        let rows = Array.from(templateStore.values());
        if (where?.msgType) rows = rows.filter((r) => r.msgType === where.msgType);
        if (where?.isEnabled !== undefined) rows = rows.filter((r) => r.isEnabled === where.isEnabled);
        return rows.length;
      }),
      create: jest.fn(async ({ data }: any) => {
        const template = { id: `template-${Math.random().toString(36).slice(2)}`, createdAt: new Date(), updatedAt: new Date(), ...data };
        templateStore.set(template.id, template);
        return template;
      }),
      update: jest.fn(async ({ where: { id }, data }: any) => {
        const updated = { ...templateStore.get(id), ...data, updatedAt: new Date() };
        templateStore.set(id, updated);
        return updated;
      }),
    };

    prisma = {
      notificationChannel,
      notificationTemplate,
      $transaction: jest.fn(async (arg: any) => {
        if (Array.isArray(arg)) return Promise.all(arg);
        return arg(prisma);
      }),
    };

    cipher = {
      encrypt: jest.fn((plaintext: string) => `enc:${plaintext}`),
      decrypt: jest.fn((payload: string) => {
        if (payload === 'corrupted') throw new Error('bad ciphertext');
        return payload.replace('enc:', '');
      }),
    };

    service = new NotificationsService(prisma, cipher);
  });

  describe('channels', () => {
    it('createChannel encrypts the webhookUrl at rest and returns a masked DTO', async () => {
      const created = await service.createChannel(
        { name: ' 总值班室群 ', webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret-123', isEnabled: true } as any,
        'zhang.san',
      );

      expect(cipher.encrypt).toHaveBeenCalledWith('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret-123');
      expect(created.name).toBe('总值班室群');
      expect(created.createdBy).toBe('zhang.san');
      expect(created.webhookUrlMasked).toContain('key=secr****');
      expect(created.webhookUrlMasked).not.toContain('secret-123');
    });

    it('updateChannel throws 404 for an unknown channel', async () => {
      await expect(
        service.updateChannel('nope', { name: 'x' } as any, 'zhang.san'),
      ).rejects.toBeInstanceOf(NotificationChannelNotFoundException);
    });

    it('updateChannel without webhookUrl preserves the stored ciphertext', async () => {
      const channel = makeChannel();
      const updated = await service.updateChannel(channel.id, { name: '新群名' } as any, 'zhang.san');

      expect(updated.name).toBe('新群名');
      expect(channelStore.get(channel.id).webhookUrlCiphertext).toBe(channel.webhookUrlCiphertext);
      expect(cipher.encrypt).not.toHaveBeenCalled();
      expect(updated.webhookUrlMasked).toContain('key=8d24****');
    });

    it('updateChannel with webhookUrl re-encrypts and replaces the stored value', async () => {
      const channel = makeChannel();
      const updated = await service.updateChannel(
        channel.id,
        { webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=new-secret' } as any,
        'zhang.san',
      );

      expect(cipher.encrypt).toHaveBeenCalledWith('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=new-secret');
      expect(channelStore.get(channel.id).webhookUrlCiphertext).toBe('enc:https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=new-secret');
      expect(updated.webhookUrlMasked).toContain('key=new-****');
    });

    it('listChannels returns the pagination envelope with masked webhookUrls', async () => {
      makeChannel();
      makeChannel({ id: 'channel-2', isEnabled: false });

      const result = await service.listChannels({ page: 1, pageSize: 10 } as any);
      expect(result.total).toBe(2);
      expect(result.items).toHaveLength(2);
      expect(result.items[0].webhookUrlMasked).toContain('key=8d24****');
      expect(result.items[0].webhookUrlMasked).not.toContain('8d24abcd-ef01');
    });

    it('listChannels survives a corrupted ciphertext with <unavailable> instead of 500ing', async () => {
      makeChannel({ id: 'channel-bad', webhookUrlCiphertext: 'corrupted' });
      makeChannel();

      const result = await service.listChannels({} as any);
      expect(result.total).toBe(2);
      const bad = result.items.find((i: any) => i.id === 'channel-bad')!;
      expect(bad.webhookUrlMasked).toBe('<unavailable>');
      // The healthy row still decrypts/masks fine.
      expect(result.items.find((i: any) => i.id !== 'channel-bad')?.webhookUrlMasked).toContain('key=8d24****');
    });
  });

  describe('templates', () => {
    it('createTemplate stores a TEXT template and drops any submitted title', async () => {
      const created = await service.createTemplate(
        { name: '红色预警通知', msgType: 'TEXT', titleTemplate: '不该存', contentTemplate: '内容' } as any,
        'zhang.san',
      );
      expect(created.msgType).toBe('TEXT');
      expect(created.titleTemplate).toBeNull();
      expect(created.contentTemplate).toBe('内容');
    });

    it('createTemplate requires a title for NEWS (NOTIFICATION_TEMPLATE_TITLE_REQUIRED)', async () => {
      await expect(
        service.createTemplate({ name: '新闻', msgType: 'NEWS', contentTemplate: '内容' } as any, 'zhang.san'),
      ).rejects.toMatchObject({ response: { code: 'NOTIFICATION_TEMPLATE_TITLE_REQUIRED' } });
    });

    it('createTemplate trims the NEWS title', async () => {
      const created = await service.createTemplate(
        { name: '新闻', msgType: 'NEWS', titleTemplate: '  标题  ', contentTemplate: '内容' } as any,
        'zhang.san',
      );
      expect(created.titleTemplate).toBe('标题');
    });

    it('updateTemplate throws 404 for an unknown template', async () => {
      await expect(
        service.updateTemplate('nope', { name: 'x' } as any, 'zhang.san'),
      ).rejects.toBeInstanceOf(NotificationTemplateNotFoundException);
    });

    it('updateTemplate switching a TEXT template to NEWS without a title is rejected', async () => {
      const template = makeTemplate();
      await expect(
        service.updateTemplate(template.id, { msgType: 'NEWS' } as any, 'zhang.san'),
      ).rejects.toMatchObject({ response: { code: 'NOTIFICATION_TEMPLATE_TITLE_REQUIRED' } });
    });

    it('updateTemplate keeps an existing NEWS title when the title is untouched', async () => {
      const template = makeTemplate({ msgType: 'NEWS', titleTemplate: '现有标题' });
      const updated = await service.updateTemplate(template.id, { contentTemplate: '新内容' } as any, 'zhang.san');
      expect(updated.titleTemplate).toBe('现有标题');
      expect(updated.contentTemplate).toBe('新内容');
    });

    it('updateTemplate switching a NEWS template to TEXT drops the title', async () => {
      const template = makeTemplate({ msgType: 'NEWS', titleTemplate: '现有标题' });
      const updated = await service.updateTemplate(template.id, { msgType: 'TEXT' } as any, 'zhang.san');
      expect(updated.msgType).toBe('TEXT');
      expect(updated.titleTemplate).toBeNull();
    });

    it('listTemplates filters by msgType and returns the envelope', async () => {
      makeTemplate();
      makeTemplate({ id: 'template-2', msgType: 'NEWS', titleTemplate: '新闻' });
      makeTemplate({ id: 'template-3', msgType: 'NEWS', titleTemplate: '新闻2' });

      const result = await service.listTemplates({ msgType: 'NEWS', page: 1, pageSize: 10 } as any);
      expect(result.total).toBe(2);
      expect(result.items.every((t: any) => t.msgType === 'NEWS')).toBe(true);
    });
  });

  describe('variables', () => {
    it('returns the 9 fixed placeholder entries', () => {
      const variables = service.getVariables();
      expect(variables).toHaveLength(9);
      expect(variables.map((v) => v.key)).toEqual([
        'reportDate',
        'hospitalName',
        'redCount',
        'yellowCount',
        'greenCount',
        'unclassifiedCount',
        'totalCount',
        'redKeywords',
        'yellowKeywords',
      ]);
    });
  });

  describe('presets', () => {
    it('returns the 3 preset content skeletons in stable order', () => {
      const presets = service.getPresets();
      expect(presets).toHaveLength(3);
      expect(presets.map((p) => p.id)).toEqual(['red-alert', 'daily-summary', 'quick-alert']);
      for (const preset of presets) {
        expect(preset.name).toBeTruthy();
        // Every preset is built only from {{placeholder}} tokens of the fixed dictionary.
        expect(preset.content).toMatch(/\{\{[a-zA-Z]+\}\}/);
      }
    });
  });
});

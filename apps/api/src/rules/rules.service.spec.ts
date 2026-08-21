import { RulesService } from './rules.service';
import { RuleConflictException } from './errors/rule-conflict.exception';
import { RuleNotFoundException } from './errors/rule-not-found.exception';
import { RuleVersionConflictException } from './errors/rule-version-conflict.exception';

/**
 * Unit tests against a mocked PrismaService - no real database. These
 * cover the business logic (conflict detection, optimistic locking,
 * versioning decision) in isolation; apps/api/test/rules.e2e-spec.ts
 * covers the same scenarios against a real Postgres instance per issue
 * #4's verification requirements.
 */
describe('RulesService', () => {
  let prisma: any;
  let service: RulesService;
  let store: Map<string, any>;

  function makeRule(overrides: Partial<any> = {}): any {
    const id = overrides.id ?? `rule-${Math.random().toString(36).slice(2)}`;
    const rule = {
      id,
      keyword: 'keyword',
      level: 'RED',
      matchField: 'REPORT_TEXT',
      matchMode: 'CONTAINS',
      category: null,
      isEnabled: true,
      version: 1,
      ruleGroupId: id,
      notes: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      createdBy: 'tester',
      updatedBy: 'tester',
      ...overrides,
    };
    store.set(id, rule);
    return rule;
  }

  beforeEach(() => {
    store = new Map();

    const monitorRule = {
      findUnique: jest.fn(async ({ where: { id } }: any) => store.get(id) ?? null),
      findUniqueOrThrow: jest.fn(async ({ where: { id } }: any) => {
        const found = store.get(id);
        if (!found) throw new Error('not found');
        return found;
      }),
      findFirst: jest.fn(async ({ where, orderBy }: any) => {
        let candidates = Array.from(store.values()).filter((rule: any) => {
          if (where.isEnabled !== undefined && rule.isEnabled !== where.isEnabled) return false;
          if (where.level && rule.level !== where.level) return false;
          if (where.matchField && rule.matchField !== where.matchField) return false;
          if (where.matchMode && rule.matchMode !== where.matchMode) return false;
          if (
            where.keyword?.equals !== undefined &&
            rule.keyword.toLowerCase() !== where.keyword.equals.toLowerCase()
          )
            return false;
          if (where.ruleGroupId?.not !== undefined && rule.ruleGroupId === where.ruleGroupId.not)
            return false;
          if (typeof where.ruleGroupId === 'string' && rule.ruleGroupId !== where.ruleGroupId)
            return false;
          return true;
        });

        if (orderBy?.version === 'desc') {
          candidates = candidates.sort((a: any, b: any) => b.version - a.version);
        }

        return candidates[0] ?? null;
      }),
      findMany: jest.fn(async () => Array.from(store.values())),
      count: jest.fn(async () => store.size),
      create: jest.fn(async ({ data }: any) => {
        const id = `rule-${Math.random().toString(36).slice(2)}`;
        const rule = { id, createdAt: new Date(), updatedAt: new Date(), ...data };
        store.set(id, rule);
        return rule;
      }),
      update: jest.fn(async ({ where: { id }, data }: any) => {
        const existing = store.get(id);
        const updated = { ...existing, ...data, updatedAt: new Date() };
        store.set(id, updated);
        return updated;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const existing = store.get(where.id);
        if (!existing || (where.version !== undefined && existing.version !== where.version)) {
          return { count: 0 };
        }
        store.set(where.id, { ...existing, ...data, updatedAt: new Date() });
        return { count: 1 };
      }),
    };

    prisma = {
      monitorRule,
      $transaction: jest.fn(async (arg: any) => {
        if (Array.isArray(arg)) {
          return Promise.all(arg);
        }
        return arg(prisma);
      }),
    };

    service = new RulesService(prisma);
  });

  describe('create', () => {
    it('creates a rule and sets ruleGroupId to its own id', async () => {
      const dto: any = {
        keyword: '肿瘤',
        level: 'RED',
        matchField: 'REPORT_TEXT',
        actorId: 'tester',
      };
      const created = await service.create(dto);

      expect(created.keyword).toBe('肿瘤');
      expect(created.ruleGroupId).toBe(created.id);
      expect(created.matchMode).toBe('CONTAINS');
      expect(created.version).toBe(1);
    });

    it('trims whitespace from the keyword', async () => {
      const dto: any = {
        keyword: '  肿瘤  ',
        level: 'RED',
        matchField: 'REPORT_TEXT',
        actorId: 'tester',
      };
      const created = await service.create(dto);
      expect(created.keyword).toBe('肿瘤');
    });

    it('rejects a duplicate enabled rule with the same keyword/level/matchField/matchMode', async () => {
      makeRule({
        keyword: '肿瘤',
        level: 'RED',
        matchField: 'REPORT_TEXT',
        matchMode: 'CONTAINS',
        isEnabled: true,
      });

      const dto: any = {
        keyword: '肿瘤',
        level: 'RED',
        matchField: 'REPORT_TEXT',
        actorId: 'tester',
      };
      await expect(service.create(dto)).rejects.toBeInstanceOf(RuleConflictException);
    });

    it('keyword conflict check is case-insensitive (e.g. "Ca" vs "ca")', async () => {
      makeRule({
        keyword: 'Ca',
        level: 'RED',
        matchField: 'REPORT_TEXT',
        matchMode: 'CONTAINS',
        isEnabled: true,
      });

      const dto: any = {
        keyword: 'ca',
        level: 'RED',
        matchField: 'REPORT_TEXT',
        actorId: 'tester',
      };
      await expect(service.create(dto)).rejects.toBeInstanceOf(RuleConflictException);
    });

    it('does not conflict with a disabled rule of the same tuple', async () => {
      makeRule({
        keyword: '肿瘤',
        level: 'RED',
        matchField: 'REPORT_TEXT',
        matchMode: 'CONTAINS',
        isEnabled: false,
      });

      const dto: any = {
        keyword: '肿瘤',
        level: 'RED',
        matchField: 'REPORT_TEXT',
        actorId: 'tester',
      };
      await expect(service.create(dto)).resolves.toBeDefined();
    });

    it('allows creating a disabled rule that would otherwise conflict', async () => {
      makeRule({
        keyword: '肿瘤',
        level: 'RED',
        matchField: 'REPORT_TEXT',
        matchMode: 'CONTAINS',
        isEnabled: true,
      });

      const dto: any = {
        keyword: '肿瘤',
        level: 'RED',
        matchField: 'REPORT_TEXT',
        actorId: 'tester',
        isEnabled: false,
      };
      await expect(service.create(dto)).resolves.toBeDefined();
    });
  });

  describe('update', () => {
    it('updates in place (same id, incremented version) when no semantic field changes', async () => {
      const rule = makeRule({ version: 3, notes: 'old' });

      const updated = await service.update(rule.id, {
        version: 3,
        notes: 'new',
        actorId: 'editor',
      } as any);

      // Same row (id unchanged - no new version row for a non-semantic
      // edit), but version still increments so optimistic locking can
      // detect a second concurrent in-place edit (see RuleVersionConflict
      // tests below).
      expect(updated.id).toBe(rule.id);
      expect(updated.version).toBe(4);
      expect(updated.notes).toBe('new');
    });

    it('rejects a second concurrent in-place edit that read the same stale version', async () => {
      const rule = makeRule({ version: 1, notes: 'old' });

      await service.update(rule.id, {
        version: 1,
        notes: 'editor-a wins',
        actorId: 'editor-a',
      } as any);

      // editor-b read version 1 before editor-a's write landed.
      await expect(
        service.update(rule.id, {
          version: 1,
          notes: 'editor-b, stale',
          actorId: 'editor-b',
        } as any),
      ).rejects.toBeInstanceOf(RuleVersionConflictException);
    });

    it('creates a new versioned row when a semantic field changes, and disables the old row', async () => {
      const rule = makeRule({ version: 1, keyword: 'old-keyword' });

      const updated = await service.update(rule.id, {
        version: 1,
        keyword: 'new-keyword',
        actorId: 'editor',
      } as any);

      expect(updated.id).not.toBe(rule.id);
      expect(updated.version).toBe(2);
      expect(updated.ruleGroupId).toBe(rule.id);
      expect(updated.keyword).toBe('new-keyword');

      const oldRow = store.get(rule.id);
      expect(oldRow.isEnabled).toBe(false);
    });

    it('rejects with RuleVersionConflictException when version does not match', async () => {
      const rule = makeRule({ version: 5 });

      await expect(
        service.update(rule.id, { version: 2, notes: 'x', actorId: 'editor' } as any),
      ).rejects.toBeInstanceOf(RuleVersionConflictException);
    });

    it('rejects with RuleNotFoundException for an unknown id', async () => {
      await expect(
        service.update('missing-id', { version: 1, actorId: 'editor' } as any),
      ).rejects.toBeInstanceOf(RuleNotFoundException);
    });

    it('does not conflict with its own prior version when re-enabling/versioning', async () => {
      const rule = makeRule({
        version: 1,
        keyword: '肿瘤',
        level: 'RED',
        matchField: 'REPORT_TEXT',
        matchMode: 'CONTAINS',
      });

      // Editing category only (no semantic change) should not conflict with itself.
      await expect(
        service.update(rule.id, { version: 1, category: 'demo', actorId: 'editor' } as any),
      ).resolves.toBeDefined();
    });

    it('rejects a semantic edit that would conflict with a different enabled rule', async () => {
      makeRule({
        keyword: 'existing',
        level: 'RED',
        matchField: 'REPORT_TEXT',
        matchMode: 'CONTAINS',
        isEnabled: true,
      });
      const rule = makeRule({
        keyword: 'other',
        level: 'RED',
        matchField: 'REPORT_TEXT',
        matchMode: 'CONTAINS',
        isEnabled: true,
        version: 1,
      });

      await expect(
        service.update(rule.id, { version: 1, keyword: 'existing', actorId: 'editor' } as any),
      ).rejects.toBeInstanceOf(RuleConflictException);
    });

    it('supports disabling a rule in place (stop)', async () => {
      const rule = makeRule({ version: 1, isEnabled: true });

      const updated = await service.update(rule.id, {
        version: 1,
        isEnabled: false,
        actorId: 'editor',
      } as any);

      expect(updated.isEnabled).toBe(false);
      expect(updated.version).toBe(2);
      expect(updated.id).toBe(rule.id);
    });
  });

  describe('getById', () => {
    it('throws RuleNotFoundException for an unknown id', async () => {
      await expect(service.getById('missing')).rejects.toBeInstanceOf(RuleNotFoundException);
    });

    it('returns the mapped DTO for a known id', async () => {
      const rule = makeRule();
      const dto = await service.getById(rule.id);
      expect(dto.id).toBe(rule.id);
      expect(dto.createdAt).toBe(rule.createdAt.toISOString());
    });
  });

  describe('list', () => {
    it('returns paginated results with defaults', async () => {
      makeRule();
      makeRule();

      const result = await service.list({} as any);
      expect(result.items).toHaveLength(2);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(20);
      expect(result.total).toBe(2);
    });
  });
});

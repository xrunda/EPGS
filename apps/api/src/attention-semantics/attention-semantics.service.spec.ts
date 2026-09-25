import { AttentionSemanticsService } from './attention-semantics.service';
import { AttentionSemanticConflictException } from './errors/attention-semantic-conflict.exception';
import { AttentionSemanticNotFoundException } from './errors/attention-semantic-not-found.exception';
import { AttentionSemanticVersionConflictException } from './errors/attention-semantic-version-conflict.exception';
import { DEFAULT_ATTENTION_SEMANTICS } from './defaults';

/**
 * Unit tests against a mocked PrismaService - no real database. They cover the
 * business logic (name conflict detection, optimistic locking, the
 * version-vs-edit-in-place decision, and the idempotency of the preset import).
 *
 * WHAT THEY DO NOT COVER, deliberately: whether the classifier draws the right
 * conclusion from a description. That is not a property of this service, and no
 * test here asserts anything medical.
 */
describe('AttentionSemanticsService', () => {
  let prisma: any;
  let service: AttentionSemanticsService;
  let store: Map<string, any>;

  function makeSemantic(overrides: Partial<any> = {}): any {
    const id = overrides.id ?? `sem-${Math.random().toString(36).slice(2)}`;
    const semantic = {
      id,
      semanticGroupId: id,
      name: '高度疑似恶性病变',
      description: '本次发现明确或高度疑似的重要恶性、占位或浸润性病变。',
      attentionLevel: 'RED',
      isEnabled: true,
      version: 1,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      createdBy: 'tester',
      updatedBy: 'tester',
      ...overrides,
    };
    store.set(id, semantic);
    return semantic;
  }

  beforeEach(() => {
    store = new Map();

    const attentionSemantic = {
      findUnique: jest.fn(async ({ where: { id } }: any) => store.get(id) ?? null),
      findUniqueOrThrow: jest.fn(async ({ where: { id } }: any) => {
        const found = store.get(id);
        if (!found) throw new Error('not found');
        return found;
      }),
      findFirst: jest.fn(async ({ where, orderBy }: any) => {
        let candidates = Array.from(store.values()).filter((row: any) => {
          if (where.isEnabled !== undefined && row.isEnabled !== where.isEnabled) return false;
          if (where.attentionLevel && row.attentionLevel !== where.attentionLevel) return false;
          if (
            where.name?.equals !== undefined &&
            row.name.trim().toLowerCase() !== where.name.equals.trim().toLowerCase()
          )
            return false;
          if (
            where.semanticGroupId?.not !== undefined &&
            row.semanticGroupId === where.semanticGroupId.not
          )
            return false;
          if (
            typeof where.semanticGroupId === 'string' &&
            row.semanticGroupId !== where.semanticGroupId
          )
            return false;
          return true;
        });

        if (orderBy?.version === 'desc') {
          candidates = candidates.sort((a: any, b: any) => b.version - a.version);
        }

        return candidates[0] ?? null;
      }),
      findMany: jest.fn(async ({ orderBy }: any = {}) => {
        const rows = Array.from(store.values());
        // Only the ordering the service actually asks for is honoured - a mock
        // that sorted on anything would let a wrong orderBy in the service pass.
        const order = Array.isArray(orderBy) ? orderBy[0] : orderBy;
        if (order?.updatedAt === 'desc') {
          return rows.sort(
            (a: any, b: any) => b.updatedAt.getTime() - a.updatedAt.getTime(),
          );
        }
        return rows;
      }),
      count: jest.fn(async () => store.size),
      create: jest.fn(async ({ data }: any) => {
        const id = `sem-${Math.random().toString(36).slice(2)}`;
        const row = { id, createdAt: new Date(), updatedAt: new Date(), ...data };
        store.set(id, row);
        return row;
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
      attentionSemantic,
      $transaction: jest.fn(async (arg: any) => {
        if (Array.isArray(arg)) {
          return Promise.all(arg);
        }
        return arg(prisma);
      }),
    };

    service = new AttentionSemanticsService(prisma);
  });

  describe('create', () => {
    it('creates a semantic at version 1, anchored to its own id as its group', async () => {
      const created = await service.create({
        name: '活动性出血',
        description: '报告中出现正在出血或新近出血的表现。',
        attentionLevel: 'RED',
        actorId: 'tester',
      } as any);

      expect(created.name).toBe('活动性出血');
      expect(created.semanticGroupId).toBe(created.id);
      expect(created.version).toBe(1);
      expect(created.isEnabled).toBe(true);
    });

    it('trims name and description', async () => {
      const created = await service.create({
        name: '  活动性出血  ',
        description: '  报告中出现正在出血的表现。  ',
        attentionLevel: 'RED',
        actorId: 'tester',
      } as any);

      expect(created.name).toBe('活动性出血');
      expect(created.description).toBe('报告中出现正在出血的表现。');
    });

    it('rejects a second enabled semantic with the same name, case-insensitively', async () => {
      makeSemantic({ name: '活动性出血', isEnabled: true });

      await expect(
        service.create({
          name: ' 活动性出血 ',
          description: '换个说法的同一条语义。',
          attentionLevel: 'YELLOW',
          actorId: 'tester',
        } as any),
      ).rejects.toBeInstanceOf(AttentionSemanticConflictException);
    });

    it('allows a disabled semantic to share a name - it is not in force', async () => {
      makeSemantic({ name: '活动性出血', isEnabled: false });

      const created = await service.create({
        name: '活动性出血',
        description: '重新启用后使用的新说法。',
        attentionLevel: 'RED',
        actorId: 'tester',
      } as any);

      expect(created.name).toBe('活动性出血');
    });
  });

  describe('update', () => {
    it('versions the row when the description changes, disabling the old one', async () => {
      const original = makeSemantic({ version: 1 });

      const updated = await service.update(
        original.id,
        {
          description: '修改后的说明。',
          version: 1,
          actorId: 'tester',
        } as any,
      );

      // A new row, same logical semantic - so a past AI finding keeps pointing
      // at the wording in force when it judged.
      expect(updated.id).not.toBe(original.id);
      expect(updated.semanticGroupId).toBe(original.semanticGroupId);
      expect(updated.version).toBe(2);
      expect(store.get(original.id).isEnabled).toBe(false);
      expect(store.get(original.id).description).toBe('本次发现明确或高度疑似的重要恶性、占位或浸润性病变。');
    });

    it('versions the row when the attention level changes - the colour is not editable in place', async () => {
      const original = makeSemantic({ version: 1, attentionLevel: 'YELLOW' });

      const updated = await service.update(
        original.id,
        { attentionLevel: 'RED', version: 1, actorId: 'tester' } as any,
      );

      expect(updated.version).toBe(2);
      expect(updated.attentionLevel).toBe('RED');
      // The old row keeps YELLOW: a finding judged under it still reads YELLOW.
      expect(store.get(original.id).attentionLevel).toBe('YELLOW');
    });

    it('edits in place when only isEnabled changes', async () => {
      const original = makeSemantic({ version: 1 });

      const updated = await service.update(
        original.id,
        { isEnabled: false, version: 1, actorId: 'tester' } as any,
      );

      expect(updated.id).toBe(original.id);
      expect(updated.isEnabled).toBe(false);
      // The counter still moves, so two operators disabling from a stale read
      // cannot both succeed.
      expect(updated.version).toBe(2);
    });

    it('rejects a stale version with a version conflict', async () => {
      const original = makeSemantic({ version: 3 });

      await expect(
        service.update(original.id, { isEnabled: false, version: 2, actorId: 'tester' } as any),
      ).rejects.toBeInstanceOf(AttentionSemanticVersionConflictException);
    });

    it('rejects editing a row that a newer version has superseded', async () => {
      const original = makeSemantic({ version: 1 });
      const newer = makeSemantic({
        version: 2,
        semanticGroupId: original.semanticGroupId,
        isEnabled: true,
      });

      // The client holds a reference to v1 and (correctly) its version number -
      // the version check alone would pass, which is exactly why the group-head
      // check runs first.
      await expect(
        service.update(original.id, { isEnabled: true, version: 1, actorId: 'tester' } as any),
      ).rejects.toBeInstanceOf(AttentionSemanticVersionConflictException);
      expect(store.get(newer.id).isEnabled).toBe(true);
    });

    it('throws a not-found for an unknown id', async () => {
      await expect(
        service.update('missing', { isEnabled: false, version: 1, actorId: 'tester' } as any),
      ).rejects.toBeInstanceOf(AttentionSemanticNotFoundException);
    });

    it('rejects renaming onto another enabled semantic name', async () => {
      const other = makeSemantic({ name: '活动性出血' });
      const target = makeSemantic({ name: '性质待定病变' });

      await expect(
        service.update(target.id, { name: '活动性出血', version: 1, actorId: 'tester' } as any),
      ).rejects.toBeInstanceOf(AttentionSemanticConflictException);
      expect(store.get(other.id).name).toBe('活动性出血');
    });
  });

  describe('importDefaults', () => {
    it('creates every preset when the hospital has none', async () => {
      const result = await service.importDefaults({ actorId: 'tester' } as any);

      expect(result.createdCount).toBe(DEFAULT_ATTENTION_SEMANTICS.length);
      expect(result.skippedCount).toBe(0);
      expect(result.updatedCount).toBe(0);
      expect(result.semanticIds).toHaveLength(DEFAULT_ATTENTION_SEMANTICS.length);
      // Every row is a version-1 anchor of its own group.
      for (const id of result.semanticIds) {
        expect(store.get(id).version).toBe(1);
        expect(store.get(id).semanticGroupId).toBe(id);
        expect(store.get(id).isEnabled).toBe(true);
      }
    });

    it('is idempotent: a second load changes nothing', async () => {
      await service.importDefaults({ actorId: 'tester' } as any);
      const sizeAfterFirst = store.size;

      const second = await service.importDefaults({ actorId: 'tester' } as any);

      expect(second.createdCount).toBe(0);
      expect(second.updatedCount).toBe(0);
      expect(second.skippedCount).toBe(DEFAULT_ATTENTION_SEMANTICS.length);
      expect(store.size).toBe(sizeAfterFirst);
    });

    it('leaves a hospital-edited entry alone unless overwriteExisting is set', async () => {
      const preset = DEFAULT_ATTENTION_SEMANTICS[0];
      const edited = makeSemantic({
        name: preset.name,
        description: '本院自己改过的说明。',
        attentionLevel: 'GREEN',
      });

      const result = await service.importDefaults({ actorId: 'tester' } as any);

      expect(result.skippedCount).toBeGreaterThan(0);
      // The hospital's colour choice is never overwritten by a button press.
      expect(store.get(edited.id).attentionLevel).toBe('GREEN');
      expect(store.get(edited.id).description).toBe('本院自己改过的说明。');
      expect(store.get(edited.id).version).toBe(1);
    });

    it('re-versions an edited entry only when overwriteExisting is set, keeping the old row', async () => {
      const preset = DEFAULT_ATTENTION_SEMANTICS[0];
      const edited = makeSemantic({
        name: preset.name,
        description: '本院自己改过的说明。',
        attentionLevel: 'GREEN',
      });

      const result = await service.importDefaults({
        overwriteExisting: true,
        actorId: 'tester',
      } as any);

      expect(result.updatedCount).toBe(1);
      // Superseded, not deleted: findings judged under the old wording stay
      // traceable.
      expect(store.get(edited.id).isEnabled).toBe(false);
      expect(store.get(edited.id).description).toBe('本院自己改过的说明。');

      const replacement = Array.from(store.values()).find(
        (row: any) => row.semanticGroupId === edited.semanticGroupId && row.version === 2,
      );
      expect(replacement.description).toBe(preset.description);
      expect(replacement.attentionLevel).toBe(preset.attentionLevel);
    });

    it('matches an existing entry by name regardless of case and padding', async () => {
      const preset = DEFAULT_ATTENTION_SEMANTICS[0];
      makeSemantic({
        name: `  ${preset.name.toUpperCase()}  `,
        description: preset.description,
        attentionLevel: preset.attentionLevel,
      });

      const result = await service.importDefaults({ actorId: 'tester' } as any);

      expect(result.createdCount).toBe(DEFAULT_ATTENTION_SEMANTICS.length - 1);
    });
  });

  describe('list', () => {
    it('returns every version, newest-edited first, with pagination metadata', async () => {
      const original = makeSemantic({ version: 1, isEnabled: false });
      makeSemantic({
        version: 2,
        semanticGroupId: original.semanticGroupId,
        updatedAt: new Date('2026-02-01T00:00:00Z'),
      });

      const page = await service.list({ page: 1, pageSize: 20 } as any);

      // Both rows are listed: a superseded version shows as a disabled row
      // rather than vanishing, matching /api/rules.
      expect(page.total).toBe(2);
      expect(page.items).toHaveLength(2);
      expect(page.items[0].version).toBe(2);
      expect(page.page).toBe(1);
      expect(page.pageSize).toBe(20);
    });
  });

  describe('getById', () => {
    it('throws a not-found for an unknown id', async () => {
      await expect(service.getById('missing')).rejects.toBeInstanceOf(
        AttentionSemanticNotFoundException,
      );
    });
  });

  it('never writes report text or patient identifiers into a semantic row', async () => {
    // The DTO shape makes this structural - there is no field to put them in -
    // but the assertion documents the intent for the next person adding one.
    const created = await service.create({
      name: '活动性出血',
      description: '报告中出现正在出血的表现。',
      attentionLevel: 'RED',
      actorId: 'tester',
    } as any);

    expect(Object.keys(created).sort()).toEqual(
      [
        'attentionLevel',
        'createdAt',
        'createdBy',
        'description',
        'id',
        'isEnabled',
        'name',
        'semanticGroupId',
        'updatedAt',
        'updatedBy',
        'version',
      ].sort(),
    );
  });
});

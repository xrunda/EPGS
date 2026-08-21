import { BadRequestException } from '@nestjs/common';
import { RulesImportService } from './rules-import.service';
import { ImportStagingStore } from './import-staging.store';

describe('RulesImportService', () => {
  let prisma: any;
  let store: ImportStagingStore;
  let service: RulesImportService;
  let ruleStore: Map<string, any>;

  beforeEach(() => {
    ruleStore = new Map();

    const monitorRule = {
      findFirst: jest.fn(async ({ where }: any) => {
        for (const rule of ruleStore.values()) {
          if (where.isEnabled !== undefined && rule.isEnabled !== where.isEnabled) continue;
          if (where.level && rule.level !== where.level) continue;
          if (where.matchField && rule.matchField !== where.matchField) continue;
          if (where.matchMode && rule.matchMode !== where.matchMode) continue;
          if (
            where.keyword?.equals !== undefined &&
            rule.keyword.toLowerCase() !== where.keyword.equals.toLowerCase()
          )
            continue;
          return rule;
        }
        return null;
      }),
      create: jest.fn(async ({ data }: any) => {
        const id = `rule-${Math.random().toString(36).slice(2)}`;
        const rule = { id, ...data };
        ruleStore.set(id, rule);
        return rule;
      }),
      update: jest.fn(async ({ where: { id }, data }: any) => {
        const updated = { ...ruleStore.get(id), ...data };
        ruleStore.set(id, updated);
        return updated;
      }),
    };

    prisma = {
      monitorRule,
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };

    store = new ImportStagingStore();
    service = new RulesImportService(prisma, store);
  });

  function csv(rows: string): Buffer {
    return Buffer.from(`keyword,level,matchField,matchMode,category,notes\n${rows}`, 'utf8');
  }

  describe('validate', () => {
    it('reports full success for a well-formed file', () => {
      const result = service.validate(
        csv('癌,RED,REPORT_TEXT,CONTAINS,,\n肿瘤,RED,REPORT_TEXT,CONTAINS,,\n'),
      );

      expect(result.totalRows).toBe(2);
      expect(result.validRows).toBe(2);
      expect(result.errors).toHaveLength(0);
      expect(result.importToken).toBeDefined();
    });

    it('reports per-row errors for partial failure (invalid enum, blank keyword)', () => {
      const result = service.validate(
        csv(',RED,REPORT_TEXT,,,\n肿瘤,NOT_A_LEVEL,REPORT_TEXT,,,\n癌,RED,REPORT_TEXT,,,\n'),
      );

      expect(result.totalRows).toBe(3);
      expect(result.validRows).toBe(1);
      expect(result.errors).toHaveLength(2);
      expect(result.errors[0].line).toBe(2);
      expect(result.errors[0].message).toMatch(/blank/);
      expect(result.errors[1].line).toBe(3);
      expect(result.errors[1].message).toMatch(/not a valid MonitorLevel/);
    });

    it('flags duplicate rows within the same file', () => {
      const result = service.validate(
        csv('癌,RED,REPORT_TEXT,CONTAINS,,\n癌,RED,REPORT_TEXT,CONTAINS,,\n'),
      );

      expect(result.validRows).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toMatch(/duplicate row/);
    });

    it('treats keyword case-insensitively for in-file duplicate detection', () => {
      const result = service.validate(
        csv('Ca,RED,REPORT_TEXT,CONTAINS,,\nca,RED,REPORT_TEXT,CONTAINS,,\n'),
      );
      expect(result.validRows).toBe(1);
      expect(result.errors).toHaveLength(1);
    });

    it('throws BadRequestException for an empty file', () => {
      expect(() => service.validate(Buffer.from('', 'utf8'))).toThrow(BadRequestException);
    });

    it('throws BadRequestException for an encoding error', () => {
      const invalid = Buffer.from([0x6b, 0xff, 0xfe, 0x00]);
      expect(() => service.validate(invalid)).toThrow(BadRequestException);
    });
  });

  describe('confirm', () => {
    it('writes all valid rows from a validated batch and returns created ids', async () => {
      const { importToken } = service.validate(
        csv('癌,RED,REPORT_TEXT,CONTAINS,,\n肿瘤,RED,REPORT_TEXT,CONTAINS,,\n'),
      );

      const result = await service.confirm(importToken, 'tester');

      expect(result.createdCount).toBe(2);
      expect(result.createdRuleIds).toHaveLength(2);
      expect(ruleStore.size).toBe(2);
    });

    it('throws for an unknown/expired import token', async () => {
      await expect(service.confirm('does-not-exist', 'tester')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('cannot be confirmed twice with the same token (token is consumed)', async () => {
      const { importToken } = service.validate(csv('癌,RED,REPORT_TEXT,CONTAINS,,\n'));
      await service.confirm(importToken, 'tester');

      await expect(service.confirm(importToken, 'tester')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects the whole confirm if a row now conflicts with an existing enabled rule (real Postgres rolls the transaction back; see rules.e2e-spec.ts)', async () => {
      const { importToken } = service.validate(
        csv('癌,RED,REPORT_TEXT,CONTAINS,,\n肿瘤,RED,REPORT_TEXT,CONTAINS,,\n'),
      );

      // Simulate a rule created concurrently between validate and confirm.
      ruleStore.set('existing-1', {
        id: 'existing-1',
        keyword: '癌',
        level: 'RED',
        matchField: 'REPORT_TEXT',
        matchMode: 'CONTAINS',
        isEnabled: true,
      });

      // Note: this unit test's $transaction mock is a plain pass-through
      // (see beforeEach) and does not simulate rollback-on-throw the way
      // real Postgres does, so it cannot assert "nothing was written" -
      // that atomicity guarantee is verified against a real database in
      // apps/api/test/rules.e2e-spec.ts. This test only asserts the
      // service surfaces the conflict as a rejection.
      await expect(service.confirm(importToken, 'tester')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });
});

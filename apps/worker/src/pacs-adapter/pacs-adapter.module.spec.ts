import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PacsAdapterModule } from './pacs-adapter.module';
import { PACS_RIS_ADAPTER } from './pacs-ris-adapter.interface';
import { FixturePacsRisAdapter } from './fixture-pacs-ris-adapter';
import { SqlPacsRisAdapter } from './sql-pacs-ris-adapter';

async function buildModule(env: Record<string, string>) {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [() => ({ pacsAdapterMode: env.PACS_ADAPTER_MODE ?? 'fixture' })],
      }),
      PacsAdapterModule,
    ],
  }).compile();

  return moduleRef;
}

describe('PacsAdapterModule', () => {
  it('provides FixturePacsRisAdapter by default / when PACS_ADAPTER_MODE=fixture', async () => {
    const moduleRef = await buildModule({ PACS_ADAPTER_MODE: 'fixture' });
    const adapter = moduleRef.get(PACS_RIS_ADAPTER);

    expect(adapter).toBeInstanceOf(FixturePacsRisAdapter);
  });

  it('provides SqlPacsRisAdapter when PACS_ADAPTER_MODE=sql', async () => {
    const moduleRef = await buildModule({ PACS_ADAPTER_MODE: 'sql' });
    const adapter = moduleRef.get(PACS_RIS_ADAPTER);

    expect(adapter).toBeInstanceOf(SqlPacsRisAdapter);
  });

  it('the fixture adapter obtained through DI can run a full fetchReports call end to end', async () => {
    const moduleRef = await buildModule({ PACS_ADAPTER_MODE: 'fixture' });
    const adapter = moduleRef.get(PACS_RIS_ADAPTER);

    const result = await adapter.fetchReports({
      since: new Date('2026-08-01T00:00:00.000Z'),
      until: new Date('2026-08-02T00:00:00.000Z'),
      pageSize: 50,
    });

    expect(result.items.length).toBeGreaterThan(0);
  });
});

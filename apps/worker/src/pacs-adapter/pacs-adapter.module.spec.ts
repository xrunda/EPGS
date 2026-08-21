import { join } from 'node:path';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { CsvPacsRisAdapter } from './csv-pacs-ris-adapter';
import { HttpPacsRisAdapter } from './http-pacs-ris-adapter';
import { PacsAdapterModule } from './pacs-adapter.module';
import { PACS_RIS_ADAPTER } from './pacs-ris-adapter.interface';

const FIXTURE_PATH = join(__dirname, 'fixtures', 'reports.fixture.csv');

async function buildModule(config: Record<string, unknown>) {
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [() => config],
      }),
      PacsAdapterModule,
    ],
  }).compile();
}

describe('PacsAdapterModule', () => {
  it('provides CsvPacsRisAdapter for local CSV mode', async () => {
    const moduleRef = await buildModule({
      pacsAdapterMode: 'csv',
      pacsMockCsvPath: FIXTURE_PATH,
    });

    expect(moduleRef.get(PACS_RIS_ADAPTER)).toBeInstanceOf(CsvPacsRisAdapter);
  });

  it('provides HttpPacsRisAdapter for the production REST mode', async () => {
    const moduleRef = await buildModule({
      pacsAdapterMode: 'http',
      pacsHttpBaseUrl: 'https://gateway.example.invalid/api/v1/endoscopy',
      pacsHttpServiceToken: 'synthetic-test-token',
      pacsHttpTimeoutMs: 1000,
    });

    expect(moduleRef.get(PACS_RIS_ADAPTER)).toBeInstanceOf(HttpPacsRisAdapter);
  });

  it('does not expose a SQL adapter mode', async () => {
    await expect(buildModule({ pacsAdapterMode: 'sql' })).rejects.toThrow(
      /PACS_ADAPTER_MODE must be csv or http/i,
    );
  });
});

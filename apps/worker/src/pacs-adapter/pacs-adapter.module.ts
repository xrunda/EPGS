import { Module, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PACS_RIS_ADAPTER } from './pacs-ris-adapter.interface';
import { CsvPacsRisAdapter } from './csv-pacs-ris-adapter';
import { HttpPacsRisAdapter } from './http-pacs-ris-adapter';

/**
 * Selects either local API-shaped CSV data or the hospital REST gateway.
 * Database connectivity belongs to the separately deployed gateway and
 * is intentionally unavailable from this repository.
 *
 * 'http' mode requires PACS_HTTP_BASE_URL and PACS_HTTP_SERVICE_TOKEN -
 * see env.validation.ts. Neither value is ever logged or hardcoded.
 */
const pacsRisAdapterProvider: Provider = {
  provide: PACS_RIS_ADAPTER,
  useFactory: (config: ConfigService) => {
    const mode = config.get<string>('pacsAdapterMode', 'csv');
    if (mode === 'http') {
      const baseUrl = config.get<string>('pacsHttpBaseUrl');
      const serviceToken = config.get<string>('pacsHttpServiceToken');
      const timeoutMs = config.get<number>('pacsHttpTimeoutMs');
      if (!baseUrl || !serviceToken) {
        throw new Error(
          'PACS_ADAPTER_MODE=http requires PACS_HTTP_BASE_URL and PACS_HTTP_SERVICE_TOKEN to be set.',
        );
      }
      return new HttpPacsRisAdapter({ baseUrl, serviceToken, timeoutMs });
    }
    if (mode === 'csv') {
      const filePath = config.get<string>('pacsMockCsvPath');
      if (!filePath) {
        throw new Error('PACS_ADAPTER_MODE=csv requires PACS_MOCK_CSV_PATH to be set.');
      }
      return new CsvPacsRisAdapter({ filePath });
    }
    throw new Error('PACS_ADAPTER_MODE must be csv or http.');
  },
  inject: [ConfigService],
};

@Module({
  providers: [pacsRisAdapterProvider],
  exports: [PACS_RIS_ADAPTER],
})
export class PacsAdapterModule {}

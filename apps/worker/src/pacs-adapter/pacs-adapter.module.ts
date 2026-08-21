import { Module, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PACS_RIS_ADAPTER } from './pacs-ris-adapter.interface';
import { FixturePacsRisAdapter } from './fixture-pacs-ris-adapter';
import { SqlPacsRisAdapter } from './sql-pacs-ris-adapter';
import { HttpPacsRisAdapter } from './http-pacs-ris-adapter';

/**
 * Selects the active PacsRisAdapter implementation based on
 * PACS_ADAPTER_MODE ('fixture' | 'sql' | 'http'). Defaults to 'fixture'
 * when unset so local dev and CI never require a real PACS/RIS
 * connection.
 *
 * `PACS_SQL_EXECUTOR` (the parameterized query driver SqlPacsRisAdapter
 * depends on) is intentionally NOT wired here - issue #2 only delivered
 * the adapter skeleton and its SQL template/tests, and no later issue
 * has wired a concrete driver. It is a still-unfinished implementation
 * path, distinct from 'http' (issue #6), which is fully wired against
 * the issue #20 contract below.
 *
 * 'http' mode requires PACS_HTTP_BASE_URL and PACS_HTTP_SERVICE_TOKEN -
 * see env.validation.ts. Neither value is ever logged or hardcoded.
 */
const pacsRisAdapterProvider: Provider = {
  provide: PACS_RIS_ADAPTER,
  useFactory: (config: ConfigService) => {
    const mode = config.get<string>('pacsAdapterMode', 'fixture');
    if (mode === 'sql') {
      return new SqlPacsRisAdapter();
    }
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
    return new FixturePacsRisAdapter();
  },
  inject: [ConfigService],
};

@Module({
  providers: [pacsRisAdapterProvider],
  exports: [PACS_RIS_ADAPTER],
})
export class PacsAdapterModule {}

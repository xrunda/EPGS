import { Module, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PACS_RIS_ADAPTER } from './pacs-ris-adapter.interface';
import { CsvPacsRisAdapter } from './csv-pacs-ris-adapter';
import { HttpPacsRisAdapter } from './http-pacs-ris-adapter';
import { SoapPacsRisAdapter } from './soap-pacs-ris-adapter';

/**
 * Selects local API-shaped CSV data, the #24 REST gateway, or the DHC/
 * Ensemble SOAP gateway. Database connectivity belongs to the separately
 * deployed gateway and is intentionally unavailable from this repository.
 *
 * 'http' mode requires PACS_HTTP_BASE_URL and PACS_HTTP_SERVICE_TOKEN.
 * 'soap' mode requires PACS_SOAP_BASE_URL, PACS_SOAP_USERNAME,
 * PACS_SOAP_PASSWORD and PACS_SOAP_KEY_NAME - see env.validation.ts.
 * None of these values are ever logged or hardcoded.
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
    if (mode === 'soap') {
      const baseUrl = config.get<string>('pacsSoapBaseUrl');
      const username = config.get<string>('pacsSoapUsername');
      const password = config.get<string>('pacsSoapPassword');
      const keyName = config.get<string>('pacsSoapKeyName');
      const timeoutMs = config.get<number>('pacsSoapTimeoutMs');
      const tlsInsecure = config.get<boolean>('pacsSoapTlsInsecure');
      if (!baseUrl || !username || !password || !keyName) {
        throw new Error(
          'PACS_ADAPTER_MODE=soap requires PACS_SOAP_BASE_URL, PACS_SOAP_USERNAME, PACS_SOAP_PASSWORD and PACS_SOAP_KEY_NAME to be set.',
        );
      }
      return new SoapPacsRisAdapter({ baseUrl, username, password, keyName, timeoutMs, tlsInsecure });
    }
    if (mode === 'csv') {
      const filePath = config.get<string>('pacsMockCsvPath');
      if (!filePath) {
        throw new Error('PACS_ADAPTER_MODE=csv requires PACS_MOCK_CSV_PATH to be set.');
      }
      return new CsvPacsRisAdapter({ filePath });
    }
    throw new Error('PACS_ADAPTER_MODE must be csv, http or soap.');
  },
  inject: [ConfigService],
};

@Module({
  providers: [pacsRisAdapterProvider],
  exports: [PACS_RIS_ADAPTER],
})
export class PacsAdapterModule {}

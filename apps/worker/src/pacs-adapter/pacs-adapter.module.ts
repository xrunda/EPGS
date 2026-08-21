import { Module, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PACS_RIS_ADAPTER } from './pacs-ris-adapter.interface';
import { FixturePacsRisAdapter } from './fixture-pacs-ris-adapter';
import { SqlPacsRisAdapter } from './sql-pacs-ris-adapter';

/**
 * Selects the active PacsRisAdapter implementation based on
 * PACS_ADAPTER_MODE ('fixture' | 'sql'). Defaults to 'fixture' when
 * unset so local dev and CI never require a real PACS/RIS connection.
 *
 * `PACS_SQL_EXECUTOR` (the parameterized query driver SqlPacsRisAdapter
 * depends on) is intentionally NOT wired here - this issue only
 * delivers the adapter skeleton and its SQL template/tests. A follow-up
 * (issue #6 or later) provides a concrete `ParameterizedQueryExecutor`
 * (e.g. backed by `mssql`) and binds it via PACS_SQL_EXECUTOR before
 * PACS_ADAPTER_MODE=sql is used outside of tests.
 */
const pacsRisAdapterProvider: Provider = {
  provide: PACS_RIS_ADAPTER,
  useFactory: (config: ConfigService) => {
    const mode = config.get<string>('pacsAdapterMode', 'fixture');
    if (mode === 'sql') {
      return new SqlPacsRisAdapter();
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

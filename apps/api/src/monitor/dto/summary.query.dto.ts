import { MonitorFiltersDto } from './monitor-filters.query.dto';

/**
 * Query params for `GET /api/monitor/summary` - accepts exactly the same
 * filter set as the list endpoint (the summary counts are computed under
 * the same `where`), with no pagination/sorting (it is a 5-bucket count).
 */
export class SummaryQueryDto extends MonitorFiltersDto {}

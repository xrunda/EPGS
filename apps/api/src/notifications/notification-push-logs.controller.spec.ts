import { NotificationPushLogsController } from './notification-push-logs.controller';
import { NotificationRulesService } from './notification-rules.service';

/**
 * Controller-layer tests for the aggregated push-log listing. Services are
 * mocked - the route is a pure passthrough to NotificationRulesService, and
 * read-only (no audit, no role decorators to exercise at this layer).
 */
describe('NotificationPushLogsController', () => {
  let service: Pick<NotificationRulesService, 'listAllPushLogs'>;
  let controller: NotificationPushLogsController;

  beforeEach(() => {
    service = {
      listAllPushLogs: jest.fn(async () => ({
        items: [],
        total: 0,
        page: 1,
        pageSize: 20,
      })),
    };
    controller = new NotificationPushLogsController(service as NotificationRulesService);
  });

  it('forwards the query to listAllPushLogs with no rule filter', async () => {
    await controller.listAllPushLogs({ page: 2, pageSize: 50 });

    expect(service.listAllPushLogs).toHaveBeenCalledTimes(1);
    expect(service.listAllPushLogs).toHaveBeenCalledWith({ page: 2, pageSize: 50 });
  });
});

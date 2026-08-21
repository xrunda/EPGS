import { Test, TestingModule } from '@nestjs/testing';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('returns status ok with a version and non-negative uptime', () => {
    const result = controller.check();

    expect(result.status).toBe('ok');
    expect(typeof result.version).toBe('string');
    expect(result.uptime).toBeGreaterThanOrEqual(0);
  });

  it('does not leak any config/secret-looking fields', () => {
    const result = controller.check();
    const keys = Object.keys(result);

    expect(keys.sort()).toEqual(['status', 'uptime', 'version']);
  });
});

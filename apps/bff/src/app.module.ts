import { Controller, Get, Module } from '@nestjs/common';
import { CORE_API_URL, CoreApi, FETCH } from './core/coreApi.ts';
import { EstimateController } from './estimate/estimate.controller.ts';
import { EstimateService } from './estimate/estimate.service.ts';
import { ExploreController } from './explore/explore.controller.ts';
import { MetaService } from './explore/meta.service.ts';

@Controller('bff')
class HealthController {
  @Get('health')
  health() {
    return { ok: true };
  }
}

@Module({
  controllers: [HealthController, EstimateController, ExploreController],
  providers: [
    { provide: CORE_API_URL, useFactory: () => process.env.CORE_API_URL ?? 'http://localhost:8080' },
    { provide: FETCH, useValue: (...args: Parameters<typeof fetch>) => fetch(...args) },
    CoreApi,
    MetaService,
    EstimateService,
  ],
})
export class AppModule {}

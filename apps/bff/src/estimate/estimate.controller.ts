import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import type { FeaturedView, ShareResult, TrainStopsView, TripEstimate } from '../contract.ts';
import { EstimateService } from './estimate.service.ts';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EVA = /^0?\d{7}$/;

@Controller('bff')
export class EstimateController {
  constructor(@Inject(EstimateService) private readonly estimates: EstimateService) {}

  /** What the Estimate screen shows before anything is searched. Wrapped so "none" is a JSON body. */
  @Get('featured')
  async featured(): Promise<{ featured: FeaturedView | null }> {
    return { featured: await this.estimates.featured() };
  }

  @Get('trains/:train')
  trainStops(@Param('train') train: string, @Query('date') date = ''): Promise<TrainStopsView> {
    if (!DATE.test(date)) throw new BadRequestException('date must be YYYY-MM-DD');
    return this.estimates.trainStops(train, date);
  }

  @Get('estimate')
  estimate(
    @Query('train') train = '',
    @Query('date') date = '',
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<TripEstimate> {
    if (!DATE.test(date)) throw new BadRequestException('date must be YYYY-MM-DD');
    if ((from && !EVA.test(from)) || (to && !EVA.test(to))) throw new BadRequestException('from/to must be EVA numbers');
    return this.estimates.byTrain(train, date, from || undefined, to || undefined);
  }

  /** Payload of a DB Navigator "Reise teilen" share (from the PWA share target or pasted text). */
  @Post('share')
  @HttpCode(200)
  share(@Body() body: { text?: unknown; title?: unknown; url?: unknown } | undefined): Promise<ShareResult> {
    const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined);
    const payload = { text: str(body?.text, 5000), title: str(body?.title, 500), url: str(body?.url, 2000) };
    if (!payload.text && !payload.url && !payload.title) throw new BadRequestException('nothing was shared');
    return this.estimates.fromShare(payload);
  }
}

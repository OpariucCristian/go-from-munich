import { BadRequestException, Controller, Get, Inject, Query } from '@nestjs/common';
import type { AccuracyView, ConnectionsView, DeparturesView, MetaView, PatternsView, StationOption } from '../contract.ts';
import { CoreApi } from '../core/coreApi.ts';
import type { CoreAccuracy, CoreConnections, CoreDepartures, CorePatterns } from '../core/types.ts';
import { accuracyView } from '../view/accuracy.ts';
import { connectionsView, departuresView, patternsView } from '../view/explore.ts';
import { MetaService } from './meta.service.ts';

const GROUPS = ['all', 'long', 'regional'];
const SOURCES = ['all', 'live', 'replay', 'near'];
const EVA = /^0?\d{7}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function check(ok: boolean, message: string) {
  if (!ok) throw new BadRequestException(message);
}

@Controller('bff')
export class ExploreController {
  constructor(
    @Inject(CoreApi) private readonly core: CoreApi,
    @Inject(MetaService) private readonly meta: MetaService,
  ) {}

  @Get('meta')
  getMeta(): Promise<MetaView> {
    return this.meta.get();
  }

  @Get('stations')
  async stations(@Query('q') q = ''): Promise<StationOption[]> {
    if (q.trim().length < 2) return [];
    const rows = await this.core.get<{ eva: string; name: string }[]>('/stations', { q: q.trim() });
    return rows.map(({ eva, name }) => ({ eva, name }));
  }

  @Get('departures')
  async departures(
    @Query('station') station = '8000261',
    @Query('group') group = 'all',
    @Query('minutes') minutes = '60',
  ): Promise<DeparturesView> {
    check(EVA.test(station), 'station must be an EVA number');
    check(GROUPS.includes(group), 'group must be all, long or regional');
    return departuresView(await this.core.get<CoreDepartures>(`/departures/${station}`, { group, minutes }));
  }

  @Get('connections')
  async connections(
    @Query('from') from = '',
    @Query('to') to = '',
    @Query('date') date = '',
    @Query('after') after?: string,
  ): Promise<ConnectionsView> {
    check(EVA.test(from) && EVA.test(to), 'from and to must be EVA numbers');
    check(DATE.test(date), 'date must be YYYY-MM-DD');
    check(!after || /^\d{2}:\d{2}$/.test(after), 'after must be HH:MM');
    return connectionsView(await this.core.get<CoreConnections>('/connections', { from, to, date, after }));
  }

  @Get('patterns')
  async patterns(@Query('group') group = 'all', @Query('days') days = '90'): Promise<PatternsView> {
    check(GROUPS.includes(group), 'group must be all, long or regional');
    return patternsView(await this.core.get<CorePatterns>('/patterns', { group, days }));
  }

  @Get('accuracy')
  async accuracy(@Query('days') days = '30', @Query('source') source = 'all'): Promise<AccuracyView> {
    check(/^\d{1,3}$/.test(days) && Number(days) >= 1 && Number(days) <= 365, 'days must be 1–365');
    check(SOURCES.includes(source), 'source must be all, live or replay');
    return accuracyView(await this.core.get<CoreAccuracy>('/accuracy', { days, source }));
  }
}

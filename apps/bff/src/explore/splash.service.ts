/** The start screen's data: one departures call per hub plus a week of accuracy, cached briefly. */
import { Inject, Injectable } from '@nestjs/common';
import type { SplashView } from '../contract.ts';
import { CoreApi } from '../core/coreApi.ts';
import type { CoreAccuracy, CoreDepartures } from '../core/types.ts';
import { splashView } from '../view/splash.ts';
import { MetaService } from './meta.service.ts';

const TTL_MS = 60_000;

@Injectable()
export class SplashService {
  private cached: { at: number; value: Promise<SplashView> } | null = null;

  constructor(
    @Inject(CoreApi) private readonly core: CoreApi,
    @Inject(MetaService) private readonly meta: MetaService,
  ) {}

  get(): Promise<SplashView> {
    if (!this.cached || Date.now() - this.cached.at > TTL_MS) {
      const value = this.load();
      value.catch(() => (this.cached = null));
      this.cached = { at: Date.now(), value };
    }
    return this.cached.value;
  }

  private async load(): Promise<SplashView> {
    const { hubs } = await this.meta.get();
    const [boards, accuracy] = await Promise.all([
      Promise.all(hubs.map((h) => this.core.get<CoreDepartures>(`/departures/${h.eva}`, { minutes: 60, group: 'all' }))),
      // The accuracy line is a nicety: the start screen still works without it.
      this.core.get<CoreAccuracy>('/accuracy', { days: 7, source: 'all' }).catch(() => null),
    ]);
    return splashView(boards, accuracy);
  }
}

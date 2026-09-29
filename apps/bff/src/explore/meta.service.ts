/** Header metadata (model, data freshness, attribution), cached briefly: every screen needs it. */
import { Inject, Injectable } from '@nestjs/common';
import type { MetaView } from '../contract.ts';
import { CoreApi } from '../core/coreApi.ts';
import type { CoreMeta } from '../core/types.ts';
import { metaView } from '../view/explore.ts';

const TTL_MS = 60_000;

@Injectable()
export class MetaService {
  private cached: { at: number; value: Promise<MetaView> } | null = null;

  constructor(@Inject(CoreApi) private readonly core: CoreApi) {}

  get(): Promise<MetaView> {
    if (!this.cached || Date.now() - this.cached.at > TTL_MS) {
      const value = this.core.get<CoreMeta>('/meta').then(metaView);
      value.catch(() => (this.cached = null));
      this.cached = { at: Date.now(), value };
    }
    return this.cached.value;
  }
}

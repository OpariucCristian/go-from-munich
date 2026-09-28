import { irisPlanSlot } from '@gfm/core';
import { RateLimiter } from './rateLimiter.ts';

const BASE = 'https://apis.deutschebahn.com/db-api-marketplace/apis/timetables/v1';

export interface IrisClientOptions {
  clientId: string;
  apiKey: string;
  perMinute?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class IrisHttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    body: string,
  ) {
    super(`IRIS ${status} for ${url}: ${body.slice(0, 200)}`);
  }
}

export class IrisClient {
  readonly limiter: RateLimiter;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  calls = 0;

  constructor(private readonly opts: IrisClientOptions) {
    this.limiter = new RateLimiter(opts.perMinute ?? 50);
    this.base = opts.baseUrl ?? BASE;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  static fromEnv(): IrisClient {
    const clientId = process.env.DB_CLIENT_ID;
    const apiKey = process.env.DB_API_KEY;
    if (!clientId || !apiKey) throw new Error('DB_CLIENT_ID and DB_API_KEY must be set');
    return new IrisClient({ clientId, apiKey });
  }

  /** GET with rate limiting and retries on 429/5xx. Returns null for 404/410 (no data for slot). */
  private async get(path: string, attempt = 0): Promise<string | null> {
    await this.limiter.acquire();
    this.calls++;
    const url = `${this.base}${path}`;
    const res = await this.fetchImpl(url, {
      headers: {
        'DB-Client-Id': this.opts.clientId,
        'DB-Api-Key': this.opts.apiKey,
        accept: 'application/xml',
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) return res.text();
    if (res.status === 404 || res.status === 410) return null;
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      return this.get(path, attempt + 1);
    }
    throw new IrisHttpError(res.status, url, await res.text());
  }

  /** Planned stops at `eva` for the hour containing `at` (Berlin local). */
  plan(eva: string, at: Date): Promise<string | null> {
    const slot = irisPlanSlot(at);
    return this.get(`/plan/${eva}/${slot.date}/${slot.hour}`);
  }

  /** All known changes for `eva`. */
  fullChanges(eva: string): Promise<string | null> {
    return this.get(`/fchg/${eva}`);
  }

  /** Changes of the last ~2 minutes for `eva`. */
  recentChanges(eva: string): Promise<string | null> {
    return this.get(`/rchg/${eva}`);
  }

  station(pattern: string): Promise<string | null> {
    return this.get(`/station/${encodeURIComponent(pattern)}`);
  }
}

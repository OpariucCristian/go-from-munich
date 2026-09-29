/** Thin HTTP client for the core prediction API; maps its errors onto Nest HTTP exceptions. */
import { BadGatewayException, BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';

export const CORE_API_URL = Symbol('CORE_API_URL');
export const FETCH = Symbol('FETCH');

type Query = Record<string, string | number | undefined>;

@Injectable()
export class CoreApi {
  constructor(
    @Inject(CORE_API_URL) private readonly baseUrl: string,
    @Inject(FETCH) private readonly fetchImpl: typeof fetch,
  ) {}

  get<T>(path: string, query: Query = {}): Promise<T> {
    const qs = new URLSearchParams(
      Object.entries(query).filter((e): e is [string, string | number] => e[1] !== undefined && e[1] !== '').map(([k, v]) => [k, String(v)]),
    ).toString();
    return this.request<T>(qs ? `${path}?${qs}` : path, { method: 'GET' });
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(new URL(path, this.baseUrl), { ...init, signal: AbortSignal.timeout(15_000) });
    } catch (err) {
      throw new BadGatewayException(`prediction API unreachable: ${(err as Error).message}`);
    }
    if (res.ok) return (await res.json()) as T;
    const detail = await res.json().catch(() => ({}) as { message?: string; error?: string });
    const message = detail.message ?? detail.error ?? res.statusText;
    if (res.status === 404) throw new NotFoundException(message);
    if (res.status === 400) throw new BadRequestException(message);
    throw new BadGatewayException(`prediction API ${res.status}: ${message}`);
  }
}

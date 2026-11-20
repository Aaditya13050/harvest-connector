import { isLoopbackHost, type AppEnv } from '../env.ts';

export interface HarvestEndpoints {
  /** REST API v2 base, e.g. https://api.harvestapp.com/v2 */
  apiBase: string;
  /** Harvest ID base, e.g. https://id.getharvest.com (account discovery) */
  idBase: string;
}

export const PRODUCTION_ENDPOINTS: HarvestEndpoints = {
  apiBase: 'https://api.harvestapp.com/v2',
  idBase: 'https://id.getharvest.com',
};

/**
 * Production endpoints, unless this Worker is being served from localhost and test overrides
 * are set (see AppEnv). Decided per request from the URL it arrived on.
 */
export function harvestEndpoints(env: AppEnv, request: Request): HarvestEndpoints {
  if (!isLoopbackHost(new URL(request.url).hostname)) return PRODUCTION_ENDPOINTS;
  return {
    apiBase: (env.HARVEST_API_BASE || PRODUCTION_ENDPOINTS.apiBase).replace(/\/+$/, ''),
    idBase: (env.HARVEST_ID_BASE || PRODUCTION_ENDPOINTS.idBase).replace(/\/+$/, ''),
  };
}

export function userAgent(env: Pick<AppEnv, 'SUPPORT_EMAIL'>): string {
  const contact = env.SUPPORT_EMAIL?.trim() || 'support@example.com';
  return `Harvest connector for AI assistants (${contact})`;
}

/** A non-2xx answer from Harvest, or a failure to reach it (status 0). */
export class HarvestApiError extends Error {
  override readonly name = 'HarvestApiError';
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | undefined | null>;
type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface HarvestClientOptions {
  token: string;
  /** Omit for Harvest ID calls, which aren't account-scoped. */
  accountId?: string;
  endpoints: HarvestEndpoints;
  userAgent: string;
  fetch?: FetchLike;
  /** Per-attempt timeout. */
  timeoutMs?: number;
  /** Extra attempts after a 429, a 5xx on a read, or a network failure on a read. */
  maxRetries?: number;
  /** Longest Retry-After we'll wait for inside one tool call. */
  maxRetryWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Harvest's paginated list envelope. The collection key varies (time_entries, clients, …). */
interface Page {
  next_page?: number | null;
  total_entries?: number;
  links?: { next?: string | null };
  [key: string]: unknown;
}

export interface ListResult<T> {
  items: T[];
  /** More matching records exist beyond `items`. */
  truncated: boolean;
  /** Total matching records, when Harvest reports it. */
  total?: number;
}

export class HarvestClient {
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: HarvestClientOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>('GET', this.apiUrl(path, query));
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', this.apiUrl(path), body);
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', this.apiUrl(path), body);
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', this.apiUrl(path));
  }

  /** GET on Harvest ID (account discovery). */
  getId<T>(path: string): Promise<T> {
    return this.request<T>('GET', `${this.options.endpoints.idBase}${path}`, undefined, { accountScoped: false });
  }

  /**
   * Fetch every page of a list endpoint, up to `maxItems`. Follows `links.next` only when it
   * points back at the Harvest API, otherwise `next_page`.
   */
  async list<T>(path: string, key: string, query: Query = {}, maxItems = 2000): Promise<ListResult<T>> {
    const perPage = Math.max(1, Math.min(2000, maxItems));
    const items: T[] = [];
    let url = this.apiUrl(path, { ...query, per_page: perPage });
    let total: number | undefined;
    for (let pageCount = 0; pageCount < 50; pageCount++) {
      const page = await this.request<Page>('GET', url);
      const batch = Array.isArray(page[key]) ? (page[key] as T[]) : [];
      if (typeof page.total_entries === 'number') total = page.total_entries;
      items.push(...batch);
      if (items.length >= maxItems) {
        return { items: items.slice(0, maxItems), truncated: items.length > maxItems || hasNext(page), total };
      }
      const next = this.nextUrl(page, path, query, perPage);
      if (!next || batch.length === 0) return { items, truncated: false, total };
      url = next;
    }
    return { items, truncated: true, total };
  }

  private nextUrl(page: Page, path: string, query: Query, perPage: number): string | undefined {
    const link = page.links?.next;
    if (link && link.startsWith(`${this.options.endpoints.apiBase}/`)) return link;
    if (typeof page.next_page === 'number') return this.apiUrl(path, { ...query, per_page: perPage, page: page.next_page });
    return undefined;
  }

  private apiUrl(path: string, query?: Query): string {
    const url = new URL(`${this.options.endpoints.apiBase}${path}`);
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, String(value));
    }
    return url.toString();
  }

  private async request<T>(
    method: string,
    url: string,
    body?: unknown,
    { accountScoped = true }: { accountScoped?: boolean } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.token}`,
      'User-Agent': this.options.userAgent,
      Accept: 'application/json',
    };
    if (accountScoped) {
      if (!this.options.accountId) throw new Error('Harvest account ID is required for this call');
      headers['Harvest-Account-Id'] = this.options.accountId;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const maxRetries = this.options.maxRetries ?? 2;
    const isRead = method === 'GET';
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
        });
      } catch (error) {
        // A write may have reached Harvest before the connection dropped: never repeat it.
        if (isRead && attempt < maxRetries) {
          await this.sleep(400 * 2 ** attempt);
          continue;
        }
        const timedOut = error instanceof Error && error.name === 'TimeoutError';
        throw new HarvestApiError(0, timedOut ? 'Harvest did not respond in time.' : 'Could not reach Harvest.');
      }

      if (response.ok) {
        const text = await response.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }

      const retryAfter = parseRetryAfter(response.headers.get('Retry-After'));
      // 429 means the request was not processed, so retrying is safe for writes too.
      if (response.status === 429 && attempt < maxRetries) {
        const waitMs = (retryAfter ?? 1) * 1000;
        if (waitMs <= (this.options.maxRetryWaitMs ?? 8_000)) {
          await this.sleep(waitMs);
          continue;
        }
      }
      if (response.status >= 500 && isRead && attempt < maxRetries) {
        await this.sleep(400 * 2 ** attempt);
        continue;
      }
      throw new HarvestApiError(response.status, await errorMessage(response), retryAfter);
    }
  }
}

function hasNext(page: Page): boolean {
  return Boolean(page.links?.next) || typeof page.next_page === 'number';
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

/** Harvest's error bodies vary ({message}, {error, error_description}, plain text). */
async function errorMessage(response: Response): Promise<string> {
  const text = (await response.text().catch(() => '')).trim();
  if (text) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const message = [parsed['message'], parsed['error_description'], parsed['error']].find(
        (value): value is string => typeof value === 'string' && value.length > 0,
      );
      if (message) return message.slice(0, 500);
    } catch {
      if (!text.startsWith('<')) return text.slice(0, 300);
    }
  }
  return `HTTP ${response.status}`;
}

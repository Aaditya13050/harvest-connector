import { beforeEach, describe, expect, it } from 'vitest';
import { HarvestApiError, HarvestClient } from '../../src/harvest/client.ts';
import { FAKE_ACCOUNT_ID, FAKE_TOKEN, FakeHarvest } from '../fake-harvest.ts';

const endpoints = { apiBase: 'http://fake.local/v2', idBase: 'http://fake.local' };

describe('HarvestClient', () => {
  let fake: FakeHarvest;
  let waits: number[];
  let client: HarvestClient;

  beforeEach(() => {
    fake = new FakeHarvest({ today: '2026-11-20' });
    waits = [];
    client = new HarvestClient({
      token: FAKE_TOKEN,
      accountId: String(FAKE_ACCOUNT_ID),
      endpoints,
      userAgent: 'Test agent (test@example.com)',
      fetch: fake.fetch,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
  });

  it('sends the headers Harvest requires', async () => {
    await client.get('/users/me');
    expect(fake.requests[0]!.headers).toEqual({
      authorization: `Bearer ${FAKE_TOKEN}`,
      account: String(FAKE_ACCOUNT_ID),
      userAgent: 'Test agent (test@example.com)',
    });
  });

  it('follows pagination links until done', async () => {
    fake.maxPerPage = 2;
    const result = await client.list('/time_entries', 'time_entries');
    expect(result.items).toHaveLength(6);
    expect(result.truncated).toBe(false);
    expect(fake.requests).toHaveLength(3);
  });

  it('stops at maxItems and reports truncation', async () => {
    fake.maxPerPage = 2;
    const result = await client.list('/time_entries', 'time_entries', {}, 3);
    expect(result.items).toHaveLength(3);
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(6);
  });

  it('never follows a pagination link to another host', async () => {
    const seen: string[] = [];
    const evilFetch = async (url: string) => {
      seen.push(url);
      const page = seen.length;
      return Response.json({
        things: [{ id: page }],
        next_page: page < 2 ? 2 : null,
        links: { next: page < 2 ? 'https://evil.example/v2/things?page=2' : null },
      });
    };
    const c = new HarvestClient({ token: 't', accountId: '1', endpoints, userAgent: 'x', fetch: evilFetch });
    const result = await c.list('/things', 'things');
    expect(result.items).toHaveLength(2);
    expect(seen.every((u) => u.startsWith('http://fake.local/v2/things'))).toBe(true);
  });

  it('waits out a short 429 and retries', async () => {
    fake.failNext = { status: 429, count: 1, retryAfter: 2 };
    const me = await client.get<{ id: number }>('/users/me');
    expect(me.id).toBe(1001);
    expect(waits).toEqual([2000]);
  });

  it('gives up on a long 429 and reports when to retry', async () => {
    fake.failNext = { status: 429, count: 1, retryAfter: 60 };
    const error = await client.get('/users/me').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HarvestApiError);
    expect((error as HarvestApiError).status).toBe(429);
    expect((error as HarvestApiError).retryAfterSeconds).toBe(60);
    expect(waits).toEqual([]);
  });

  it('retries server errors on reads but never repeats a write', async () => {
    fake.failNext = { status: 503, count: 1 };
    await expect(client.get('/users/me')).resolves.toBeTruthy();

    fake.requests = [];
    fake.failNext = { status: 500, count: 1, method: 'POST' };
    const error = await client
      .post('/time_entries', { project_id: 601, task_id: 702, spent_date: '2026-11-20', hours: 1 })
      .catch((e: unknown) => e);
    expect((error as HarvestApiError).status).toBe(500);
    expect(fake.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
  });

  it('surfaces Harvest error messages', async () => {
    const error = await client.post('/time_entries', { project_id: 601, task_id: 704, spent_date: '2026-11-20', hours: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HarvestApiError);
    expect((error as HarvestApiError).status).toBe(422);
    expect((error as HarvestApiError).message).toBe('Task is not assigned to the project');
  });

  it('maps an invalid token to 401', async () => {
    fake.validToken = 'something-else';
    const error = await client.get('/users/me').catch((e: unknown) => e);
    expect((error as HarvestApiError).status).toBe(401);
  });
});

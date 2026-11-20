import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMcpApiHandler } from '../../src/core/mcp.ts';
import type { AppEnv } from '../../src/env.ts';
import { buildHarvestServer, READ_TOOLS, WRITE_TOOLS } from '../../src/harvest/server.ts';
import type { HarvestProps } from '../../src/harvest/session.ts';
import { FAKE_ACCOUNT_ID, FAKE_TOKEN, FakeHarvest } from '../fake-harvest.ts';

// Friday 2026-11-20, 12:00 in Chennai (the fake user's Harvest time zone).
const NOW = new Date('2026-11-20T06:30:00Z');
const BASE = 'http://localhost:8787';

const env = {
  SUPPORT_EMAIL: 'test@example.com',
  HARVEST_API_BASE: 'http://fake.local/v2',
  HARVEST_ID_BASE: 'http://fake.local',
} as AppEnv;

let fake: FakeHarvest;
let clients: Client[] = [];

async function connect(options: { scopes?: string[]; roles?: string[] } = {}) {
  const props: HarvestProps = {
    token: FAKE_TOKEN,
    accountId: String(FAKE_ACCOUNT_ID),
    accountName: 'Acme Studio',
    userId: 1001,
    userName: 'Asha Rao',
    timezone: 'Chennai',
    accessRoles: options.roles ?? ['administrator'],
  };
  const api = createMcpApiHandler<HarvestProps>((state) => buildHarvestServer(state, { fetch: fake.fetch, now: () => NOW }));
  const ctx = {
    props,
    auth: { token: 'access-token', audience: `${BASE}/mcp`, scope: options.scopes ?? ['harvest:read', 'harvest:write'], clientId: 'test-client' },
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    fetch: (url, init) => api.fetch(new Request(url, init), env, ctx),
  });
  const client = new Client({ name: 'unit-test', version: '1.0.0' });
  await client.connect(transport);
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const content = (result.content ?? []) as { type: string; text?: string }[];
  return {
    text: content.map((c) => c.text ?? '').join('\n'),
    isError: result.isError === true,
    data: result.structuredContent as Record<string, any> | undefined,
    meta: result._meta as Record<string, unknown> | undefined,
  };
}

beforeEach(() => {
  fake = new FakeHarvest({ today: '2026-11-20', now: () => NOW });
});

afterEach(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => {})));
  clients = [];
});

describe('tool catalogue', () => {
  it('lists every tool with a title and explicit safety annotations', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS, ...WRITE_TOOLS].map((t) => t.name).sort());
    expect(tools).toHaveLength(13);
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]{2,63}$/);
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.description!.length, tool.name).toBeGreaterThan(40);
      expect(typeof tool.annotations?.readOnlyHint, tool.name).toBe('boolean');
      expect(typeof tool.annotations?.destructiveHint, tool.name).toBe('boolean');
      expect(typeof tool.annotations?.openWorldHint, tool.name).toBe('boolean');
      // Anthropic's review: every tool is either read-only or declares destructiveness explicitly.
      expect(tool.annotations?.readOnlyHint || tool.annotations?.destructiveHint !== undefined).toBe(true);
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(byName['list_time_entries']?.readOnlyHint).toBe(true);
    expect(byName['log_time']).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(byName['delete_time_entry']).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(byName['update_time_entry']).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it('only offers read tools on a read-only connection', async () => {
    const client = await connect({ scopes: ['harvest:read'] });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(READ_TOOLS.map((t) => t.name).sort());
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });

  it('gives the client usage instructions', async () => {
    const client = await connect();
    expect(client.getInstructions()).toMatch(/only creates drafts/);
  });
});

describe('reading', () => {
  it('describes the profile with the local date', async () => {
    const r = await call(await connect(), 'get_harvest_profile');
    expect(r.isError).toBe(false);
    expect(r.text).toContain('Acme Studio');
    expect(r.text).toContain('Today there is 2026-11-20 (Friday)');
    expect(r.text).toContain('Asia/Kolkata');
    expect(r.data).toMatchObject({ today: '2026-11-20', time_entry_mode: 'durations', can_write: true, week_start: 'Monday' });
  });

  it('lists projects with their tasks and IDs', async () => {
    const r = await call(await connect(), 'list_projects', { search: 'northwind' });
    expect(r.text).toContain('Northwind Traders (client ID 501)');
    expect(r.text).toContain('Website Redesign [WEB] — project ID 601');
    expect(r.text).toContain('Development (ID 702)');
    expect(r.text).not.toContain('Brand Refresh');
    expect(r.data!['projects']).toHaveLength(2);
  });

  it("lists this week's entries for me by default, with totals", async () => {
    const r = await call(await connect(), 'list_time_entries');
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ from: '2026-11-16', to: '2026-11-22', totals: { hours: 7.25, billable_hours: 7.25 } });
    expect(r.data!['entries']).toHaveLength(3);
    expect(r.text).toContain('3 time entries for you from 2026-11-16 to 2026-11-22: 7h 15m total');
    expect(r.text).not.toContain('API integration');
  });

  it("includes teammates' time and filters by project code", async () => {
    const r = await call(await connect(), 'list_time_entries', { everyone: true, project: 'web' });
    expect(r.data!['entries']).toHaveLength(3);
    expect(r.text).toContain('Ben Ortiz');
    expect(r.text).toContain('on Northwind Traders / Website Redesign');
  });

  it('filters by task name and by period', async () => {
    const r = await call(await connect(), 'list_time_entries', { period: 'this_month', task: 'design' });
    expect(r.data!['entries']).toHaveLength(1);
    expect(r.data!['entries'][0]).toMatchObject({ task: 'Design', hours: 1.75 });
  });

  it('reports time by client with billable amounts', async () => {
    const r = await call(await connect(), 'get_time_report', { group_by: 'client' });
    expect(r.isError).toBe(false);
    const rows = r.data!['rows'] as { name: string; total_hours: number; billable_amount: number }[];
    expect(rows[0]).toMatchObject({ name: 'Northwind Traders', total_hours: 12.25, billable_amount: 1867.5 });
    expect(r.text).toContain('$1,867.50');
    const report = fake.requests.find((q) => q.path === '/v2/reports/time/clients')!;
    expect(report.query).toMatchObject({ from: '20261101', to: '20261130' });
  });

  it('shows uninvoiced work per project', async () => {
    const r = await call(await connect(), 'get_uninvoiced_report', { client: 'Northwind' });
    expect(r.text).toContain('Uninvoiced work for Northwind Traders');
    expect(r.text).toContain('Website Redesign (project ID 601): 9h 15m → $1,387.50');
    expect(r.data!['totals']).toEqual({ hours: 12.25, amount: { USD: 1867.5 } });
  });

  it('shows the running timer, or that none is running', async () => {
    const client = await connect();
    expect((await call(client, 'get_running_timer')).text).toBe('No timer is running.');
  });
});

describe('logging time', () => {
  it('logs time by project and task name with a typed duration', async () => {
    const r = await call(await connect(), 'log_time', { project: 'Website Redesign', task: 'dev', hours: '1:30', notes: 'Code review' });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('Logged 1h 30m on 2026-11-20 to Northwind Traders / Website Redesign / Development');
    const post = fake.requests.find((q) => q.method === 'POST')!;
    expect(post.body).toEqual({ project_id: 601, task_id: 702, spent_date: '2026-11-20', hours: 1.5, notes: 'Code review' });
  });

  it('infers the task when the project has only one', async () => {
    const r = await call(await connect(), 'log_time', { project: 'Brand Refresh', hours: 2 });
    expect(r.isError).toBe(false);
    expect(r.data!['entry']).toMatchObject({ task: 'Design', hours: 2 });
  });

  it('asks for a task when the project has several', async () => {
    const r = await call(await connect(), 'log_time', { project: 'Mobile App', hours: 1 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('has several tasks; say which one: Development (ID 702); Project Management (ID 703)');
  });

  it('explains unknown and ambiguous projects', async () => {
    const client = await connect();
    const unknown = await call(client, 'log_time', { project: 'Zebra', hours: 1 });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('No project matches "Zebra". Available: Northwind Traders / Website Redesign (ID 601)');
    const ambiguous = await call(client, 'log_time', { project: 'a', hours: 1 });
    expect(ambiguous.text).toMatch(/matches more than one project/);
    expect(fake.requests.some((q) => q.method === 'POST')).toBe(false);
  });

  it('turns start and end times into hours on duration accounts', async () => {
    const r = await call(await connect(), 'log_time', { project: 'WEB', task: 'Design', start_time: '9:00am', end_time: '10:45am' });
    expect(r.isError).toBe(false);
    expect(fake.requests.find((q) => q.method === 'POST')!.body).toMatchObject({ hours: 1.75 });
  });

  it('uses start and end times on accounts that track them', async () => {
    fake.wantsTimestampTimers = true;
    const client = await connect();
    const withHours = await call(client, 'log_time', { project: 'WEB', task: 'Design', hours: 2 });
    expect(withHours.isError).toBe(true);
    expect(withHours.text).toContain('records start and end times');

    const r = await call(client, 'log_time', { project: 'WEB', task: 'Design', start_time: '9am', end_time: '10:45' });
    expect(r.isError).toBe(false);
    expect(fake.requests.find((q) => q.method === 'POST')!.body).toMatchObject({ started_time: '9:00am', ended_time: '10:45am' });
    expect(r.data!['entry']).toMatchObject({ hours: 1.75 });
  });

  it('rejects impossible input before calling Harvest', async () => {
    const client = await connect();
    expect((await call(client, 'log_time', { project: 'WEB', task: 'Design', hours: 30 })).text).toContain('at most 24 hours');
    expect((await call(client, 'log_time', { project: 'WEB', task: 'Design', hours: 1, start_time: '9am', end_time: '10am' })).text).toContain(
      'not both',
    );
    expect((await call(client, 'log_time', { project: 'WEB', task: 'Design', start_time: '11am', end_time: '10am' })).text).toContain('later');
    expect((await call(client, 'log_time', { project: 'WEB', task: 'Design' })).text).toContain('Give hours');
    expect(fake.requests.some((q) => q.method === 'POST')).toBe(false);
  });
});

describe('timers', () => {
  it('starts, switches, shows and stops timers', async () => {
    const client = await connect();
    const first = await call(client, 'start_timer', { project: 'WEB', task: 'Development', notes: 'Live work' });
    expect(first.text).toContain('Timer started on Northwind Traders / Website Redesign / Development');

    const second = await call(client, 'start_timer', { project: 'Mobile App', task: 'Development' });
    expect(second.text).toContain('Stopped the timer that was running on Northwind Traders / Website Redesign / Development');
    expect(fake.entries.filter((e) => e.isRunning)).toHaveLength(1);

    const running = await call(client, 'get_running_timer');
    expect(running.text).toContain('Mobile App');

    const stopped = await call(client, 'stop_timer');
    expect(stopped.text).toContain('Stopped the timer');
    expect(fake.entries.some((e) => e.isRunning)).toBe(false);

    const again = await call(client, 'stop_timer');
    expect(again.isError).toBe(false);
    expect(again.text).toContain('No timer is running');
  });
});

describe('changing entries', () => {
  it('updates fields and shows before and after', async () => {
    const entry = fake.entries.find((e) => e.notes === 'Homepage hero section')!;
    const r = await call(await connect(), 'update_time_entry', { time_entry_id: entry.id, hours: 3, notes: 'Homepage hero + nav' });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/Before: .*2h 30m.*\nAfter: .*3h/);
    expect(fake.requests.find((q) => q.method === 'PATCH')!.body).toEqual({ hours: 3, notes: 'Homepage hero + nav' });
  });

  it('moves an entry to another project, keeping the task when it exists there', async () => {
    const entry = fake.entries.find((e) => e.notes === 'Homepage hero section')!;
    const r = await call(await connect(), 'update_time_entry', { time_entry_id: entry.id, project: 'Mobile App' });
    expect(r.isError).toBe(false);
    expect(fake.requests.find((q) => q.method === 'PATCH')!.body).toEqual({ project_id: 602, task_id: 702 });
  });

  it('refuses to change locked entries', async () => {
    const entry = fake.entries.find((e) => e.notes === 'Wireframes')!;
    entry.isLocked = true;
    const r = await call(await connect(), 'update_time_entry', { time_entry_id: entry.id, notes: 'x' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('is locked');
  });

  it('previews a delete, then deletes only when confirmed', async () => {
    const client = await connect();
    const entry = fake.entries.find((e) => e.notes === 'Wireframes')!;
    const preview = await call(client, 'delete_time_entry', { time_entry_id: entry.id });
    expect(preview.isError).toBe(false);
    expect(preview.text).toContain('Preview only, nothing was deleted');
    expect(fake.entries).toContain(entry);

    const done = await call(client, 'delete_time_entry', { time_entry_id: entry.id, confirm: true });
    expect(done.text).toContain('Deleted:');
    expect(fake.entries).not.toContain(entry);
  });

  it('will not delete invoiced time', async () => {
    const billed = fake.entries.find((e) => e.isBilled)!;
    const r = await call(await connect(), 'delete_time_entry', { time_entry_id: billed.id, confirm: true });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('already on an invoice');
    expect(fake.entries).toContain(billed);
  });
});

describe('invoices', () => {
  it('creates a draft from uninvoiced time, then refuses an empty one', async () => {
    const client = await connect();
    const r = await call(client, 'create_invoice_draft', { client: 'northwind', subject: 'November work' });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('Created DRAFT invoice #1002 for Northwind Traders: $1,867.50');
    expect(r.text).toContain('It has not been sent');
    expect(r.text).toMatch(/https:\/\/acmestudio\.harvestapp\.com\/invoices\/\d+/);
    const post = fake.requests.find((q) => q.method === 'POST' && q.path === '/v2/invoices')!;
    expect(post.body).toEqual({
      client_id: 501,
      subject: 'November work',
      line_items_import: { project_ids: [601, 602], time: { summary_type: 'task' } },
    });

    const again = await call(client, 'create_invoice_draft', { client: 'northwind' });
    expect(again.isError).toBe(true);
    expect(again.text).toContain('no uninvoiced time');
    expect(fake.invoices.filter((i) => i.state === 'draft')).toHaveLength(1);

    const list = await call(client, 'list_invoices');
    expect(list.text).toContain('#1002 · Northwind Traders · draft');
    expect(list.text).toContain('#1001 · Globex Corporation · paid');
  });

  it('limits an invoice to chosen projects and dates', async () => {
    const r = await call(await connect(), 'create_invoice_draft', {
      client: 'Northwind Traders',
      projects: ['APP'],
      from: '2026-11-17',
      to: '2026-11-17',
      group_lines_by: 'project',
    });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('$480.00');
    expect(fake.requests.find((q) => q.method === 'POST')!.body).toMatchObject({
      line_items_import: { project_ids: [602], time: { summary_type: 'project', from: '2026-11-17', to: '2026-11-17' } },
    });
  });
});

describe('permissions and failures', () => {
  it('explains what a Member cannot see', async () => {
    fake.role = 'member';
    const client = await connect({ roles: ['member'] });
    const profile = await call(client, 'get_harvest_profile');
    expect(profile.text).toContain('Company settings are only visible to Harvest Administrators');

    const uninvoiced = await call(client, 'get_uninvoiced_report');
    expect(uninvoiced.isError).toBe(true);
    expect(uninvoiced.text).toContain("your role doesn't allow this");

    const report = await call(client, 'get_time_report');
    expect(report.isError).toBe(false);
    expect(report.text).toContain('Only your own time is included');
  });

  it('asks to reconnect when Harvest rejects the saved token', async () => {
    fake.validToken = 'rotated-token';
    const r = await call(await connect(), 'list_projects');
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Reconnect the Harvest connector');
    expect(JSON.stringify(r.meta)).toContain('invalid_token');
    expect(r.text).not.toContain(FAKE_TOKEN);
  });

  it('reports rate limits with a wait time', async () => {
    fake.failNext = { status: 429, count: 5, retryAfter: 45 };
    const r = await call(await connect(), 'list_projects');
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Try again in about 45 seconds');
  });

  it('blocks writes on a read-only connection even if called directly', async () => {
    const client = await connect({ scopes: ['harvest:read'] });
    const result = await client.callTool({ name: 'log_time', arguments: { project: 'WEB', hours: 1 } }).catch((e: unknown) => e);
    const failed = result instanceof Error || (result as { isError?: boolean }).isError === true;
    expect(failed).toBe(true);
    expect(fake.requests.some((q) => q.method === 'POST')).toBe(false);
  });
});

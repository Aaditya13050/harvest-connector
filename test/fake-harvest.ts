/**
 * An in-memory stand-in for the parts of the Harvest API v2 (and Harvest ID) this connector
 * uses, built from Harvest's public API docs. Used by the unit tests (as a fetch function)
 * and by the end-to-end test (behind a local HTTP server).
 *
 * Written as plain, type-strippable TypeScript so Node can run it directly.
 */

export const FAKE_TOKEN = 'fake-harvest-token-0123456789';
export const FAKE_ACCOUNT_ID = 424242;

interface Named {
  id: number;
  name: string;
}

interface FakeProject {
  id: number;
  name: string;
  code: string;
  clientId: number;
  rate: number;
  billable: boolean;
  taskIds: number[];
  active: boolean;
}

export interface FakeEntry {
  id: number;
  userId: number;
  projectId: number;
  taskId: number;
  spentDate: string;
  hours: number;
  notes: string | null;
  isRunning: boolean;
  timerStartedAt: string | null;
  startedTime: string | null;
  endedTime: string | null;
  isBilled: boolean;
  isLocked: boolean;
  invoiceId: number | null;
}

interface FakeInvoice {
  id: number;
  number: string;
  clientId: number;
  state: string;
  amount: number;
  dueAmount: number;
  issueDate: string;
  dueDate: string | null;
  subject: string | null;
  notes: string | null;
  paymentTerm: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  lineItems: { id: number; kind: string; description: string; quantity: number; unit_price: number; amount: number; project: Named | null }[];
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  headers: { authorization: string | null; account: string | null; userAgent: string | null };
}

export interface FakeHarvestOptions {
  /** "Today" for seeding entries, YYYY-MM-DD. */
  today: string;
  now?: () => Date;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

/** Accepts YYYY-MM-DD or YYYYMMDD (Harvest's report examples use the latter). */
function normalizeDate(value: string | null): string | null {
  if (!value) return null;
  if (/^\d{8}$/.test(value)) return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return 'invalid';
}

/** "9:00am" / "14:30" → minutes after midnight. */
function clockToMinutes(value: string): number | null {
  const m = value.trim().toLowerCase().match(/^(\d{1,2}):(\d{2})(am|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  if (m[3]) {
    if (h === 12) h = 0;
    if (m[3] === 'pm') h += 12;
  }
  return h * 60 + Number(m[2]);
}

export class FakeHarvest {
  today: string;
  now: () => Date;
  role: 'administrator' | 'manager' | 'member' = 'administrator';
  wantsTimestampTimers = false;
  /** Harvest ID returns a second Harvest account when true (multi-account tokens). */
  secondHarvestAccount = false;
  /** Cap per_page to exercise pagination. */
  maxPerPage = 2000;
  /** The token currently accepted; change it to simulate a revoked token. */
  validToken = FAKE_TOKEN;
  /** Fail the next N matching requests with this status (e.g. 429 with Retry-After). */
  failNext: { status: number; count: number; retryAfter?: number; method?: string } | null = null;
  requests: RecordedRequest[] = [];

  me = { id: 1001, first_name: 'Asha', last_name: 'Rao', email: 'asha@example.com', timezone: 'Chennai' };
  teammate = { id: 1002, first_name: 'Ben', last_name: 'Ortiz' };
  clients: (Named & { active: boolean; currency: string })[] = [
    { id: 501, name: 'Northwind Traders', active: true, currency: 'USD' },
    { id: 502, name: 'Globex Corporation', active: true, currency: 'USD' },
    { id: 503, name: 'Initech', active: false, currency: 'USD' },
  ];
  tasks: (Named & { billable: boolean })[] = [
    { id: 701, name: 'Design', billable: true },
    { id: 702, name: 'Development', billable: true },
    { id: 703, name: 'Project Management', billable: false },
    { id: 704, name: 'Research', billable: true },
  ];
  projects: FakeProject[] = [
    { id: 601, name: 'Website Redesign', code: 'WEB', clientId: 501, rate: 150, billable: true, taskIds: [701, 702, 703], active: true },
    { id: 602, name: 'Mobile App', code: 'APP', clientId: 501, rate: 160, billable: true, taskIds: [702, 703], active: true },
    { id: 603, name: 'Brand Refresh', code: 'BR', clientId: 502, rate: 120, billable: true, taskIds: [701], active: true },
    { id: 604, name: 'Internal Ops', code: 'OPS', clientId: 502, rate: 0, billable: false, taskIds: [703, 704], active: true },
  ];
  entries: FakeEntry[] = [];
  invoices: FakeInvoice[] = [];
  private nextId = 50_000;
  private nextInvoiceNumber = 1002;

  constructor(options: FakeHarvestOptions) {
    this.today = options.today;
    this.now = options.now ?? (() => new Date());
    const t = this.today;
    this.seedEntry({ userId: 1001, projectId: 601, taskId: 702, spentDate: addDays(t, -1), hours: 2.5, notes: 'Homepage hero section' });
    this.seedEntry({ userId: 1001, projectId: 601, taskId: 701, spentDate: addDays(t, -2), hours: 1.75, notes: 'Wireframes' });
    this.seedEntry({ userId: 1001, projectId: 602, taskId: 702, spentDate: addDays(t, -3), hours: 3, notes: 'Login flow' });
    this.seedEntry({ userId: 1002, projectId: 601, taskId: 702, spentDate: addDays(t, -1), hours: 5, notes: 'API integration' });
    this.seedEntry({ userId: 1001, projectId: 604, taskId: 703, spentDate: addDays(t, -10), hours: 1, notes: 'Weekly planning' });
    const billed = this.seedEntry({ userId: 1001, projectId: 603, taskId: 701, spentDate: addDays(t, -40), hours: 4, notes: 'Logo concepts' });
    billed.isBilled = true;
    billed.invoiceId = 9001;
    this.invoices.push({
      id: 9001,
      number: '1001',
      clientId: 502,
      state: 'paid',
      amount: 480,
      dueAmount: 0,
      issueDate: addDays(t, -35),
      dueDate: addDays(t, -5),
      subject: 'Brand Refresh, phase 1',
      notes: null,
      paymentTerm: 'net 30',
      periodStart: null,
      periodEnd: null,
      lineItems: [{ id: 1, kind: 'Service', description: 'Brand Refresh: Design', quantity: 4, unit_price: 120, amount: 480, project: { id: 603, name: 'Brand Refresh' } }],
    });
  }

  seedEntry(fields: { userId: number; projectId: number; taskId: number; spentDate: string; hours: number; notes: string | null }): FakeEntry {
    const entry: FakeEntry = {
      id: this.nextId++,
      ...fields,
      isRunning: false,
      timerStartedAt: null,
      startedTime: null,
      endedTime: null,
      isBilled: false,
      isLocked: false,
      invoiceId: null,
    };
    this.entries.push(entry);
    return entry;
  }

  /** Use as a fetch implementation: `fetch: fake.fetch`. */
  fetch = (input: string, init?: RequestInit): Promise<Response> => this.handle(new Request(input, init));

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const text = request.method === 'GET' || request.method === 'DELETE' ? '' : await request.text();
    let body: unknown = undefined;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        return json(400, { message: 'Malformed JSON' });
      }
    }
    this.requests.push({
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
      headers: {
        authorization: request.headers.get('authorization'),
        account: request.headers.get('harvest-account-id'),
        userAgent: request.headers.get('user-agent'),
      },
    });

    if (this.failNext && this.failNext.count > 0 && (!this.failNext.method || this.failNext.method === request.method)) {
      this.failNext.count--;
      const headers: Record<string, string> = {};
      if (this.failNext.retryAfter !== undefined) headers['Retry-After'] = String(this.failNext.retryAfter);
      return json(this.failNext.status, { message: `Simulated ${this.failNext.status}` }, headers);
    }

    if (!request.headers.get('user-agent')) return json(400, { message: 'A User-Agent header is required' });
    if (request.headers.get('authorization') !== `Bearer ${this.validToken}`) {
      return json(401, {
        error: 'invalid_token',
        error_description: 'The access token provided is expired, revoked, malformed or invalid for other reasons.',
      });
    }

    if (url.pathname === '/api/v2/accounts' && request.method === 'GET') return this.accounts();
    if (!url.pathname.startsWith('/v2/')) return json(404, { status: 404, error: 'Not Found' });
    if (request.headers.get('harvest-account-id') !== String(FAKE_ACCOUNT_ID)) {
      return json(403, { message: 'You do not have access to this account' });
    }
    return this.route(request.method, url.pathname.slice(3), url, body);
  }

  private accounts(): Response {
    const accounts = [
      { id: FAKE_ACCOUNT_ID, name: 'Acme Studio', product: 'harvest' },
      { id: 777, name: 'Acme Forecast', product: 'forecast' },
    ];
    if (this.secondHarvestAccount) accounts.push({ id: 888, name: 'Side Projects', product: 'harvest' });
    return json(200, { user: { id: this.me.id, first_name: this.me.first_name, last_name: this.me.last_name, email: this.me.email }, accounts });
  }

  private get isAdmin(): boolean {
    return this.role === 'administrator';
  }

  private route(method: string, path: string, url: URL, body: unknown): Response {
    const q = url.searchParams;
    let m: RegExpMatchArray | null;

    if (method === 'GET' && path === '/users/me') {
      return json(200, { ...this.me, is_active: true, is_contractor: false, weekly_capacity: 144000, access_roles: [this.role] });
    }
    if (method === 'GET' && path === '/company') {
      if (!this.isAdmin) return json(403, { message: 'Only administrators can view company settings' });
      return json(200, {
        name: 'Acme Studio',
        base_uri: 'https://acmestudio.harvestapp.com',
        full_domain: 'acmestudio.harvestapp.com',
        is_active: true,
        week_start_day: 'Monday',
        wants_timestamp_timers: this.wantsTimestampTimers,
        time_format: 'hours_minutes',
        clock: '12h',
        currency_code_display: 'USD',
        plan_type: 'simple-v4',
        invoice_feature: true,
      });
    }
    if (method === 'GET' && path === '/users/me/project_assignments') {
      const items = this.projects.map((p) => ({
        id: p.id + 10_000,
        is_active: p.active,
        is_project_manager: false,
        project: { id: p.id, name: p.name, code: p.code },
        client: this.clientRef(p.clientId),
        task_assignments: p.taskIds.map((taskId) => ({
          id: taskId + 20_000,
          is_active: true,
          billable: p.billable && this.task(taskId).billable,
          task: { id: taskId, name: this.task(taskId).name },
        })),
      }));
      return this.page(url, 'project_assignments', items);
    }
    if (method === 'GET' && path === '/clients') {
      if (this.role === 'member') return json(403, { message: 'Not allowed' });
      const active = q.get('is_active');
      const items = this.clients
        .filter((c) => active === null || String(c.active) === active)
        .map((c) => ({ id: c.id, name: c.name, is_active: c.active, currency: c.currency }));
      return this.page(url, 'clients', items);
    }
    if (method === 'GET' && path === '/projects') {
      if (this.role === 'member') return json(403, { message: 'Not allowed' });
      const clientId = q.get('client_id');
      const active = q.get('is_active');
      const items = this.projects
        .filter((p) => (clientId === null || p.clientId === Number(clientId)) && (active === null || String(p.active) === active))
        .map((p) => ({ id: p.id, name: p.name, code: p.code, is_active: p.active, is_billable: p.billable, client: { ...this.clientRef(p.clientId), currency: 'USD' } }));
      return this.page(url, 'projects', items);
    }
    if (method === 'GET' && path === '/time_entries') return this.listEntries(url);
    if (method === 'POST' && path === '/time_entries') return this.createEntry(body as Record<string, unknown>);
    if ((m = path.match(/^\/time_entries\/(\d+)$/))) {
      const entry = this.entries.find((e) => e.id === Number(m![1]));
      if (!entry || (!this.isAdmin && entry.userId !== this.me.id)) return json(404, { status: 404, error: 'Not Found' });
      if (method === 'GET') return json(200, this.entryJson(entry));
      if (method === 'PATCH') return this.updateEntry(entry, body as Record<string, unknown>);
      if (method === 'DELETE') {
        if (entry.isBilled) return json(422, { message: 'Time entries that have been invoiced can not be deleted' });
        this.entries = this.entries.filter((e) => e !== entry);
        return new Response(null, { status: 200 });
      }
    }
    if (method === 'PATCH' && (m = path.match(/^\/time_entries\/(\d+)\/(stop|restart)$/))) {
      const entry = this.entries.find((e) => e.id === Number(m![1]));
      if (!entry) return json(404, { status: 404, error: 'Not Found' });
      if (m[2] === 'stop') {
        if (!entry.isRunning) return json(422, { message: 'Time entry is not running' });
        this.stop(entry);
      } else {
        if (entry.isRunning) return json(422, { message: 'Time entry is already running' });
        this.stopRunningFor(entry.userId);
        entry.isRunning = true;
        entry.timerStartedAt = this.now().toISOString();
      }
      return json(200, this.entryJson(entry));
    }
    if (method === 'GET' && (m = path.match(/^\/reports\/time\/(clients|projects|tasks|team)$/))) return this.timeReport(url, m[1]!);
    if (method === 'GET' && path === '/reports/uninvoiced') return this.uninvoicedReport(url);
    if (method === 'GET' && path === '/invoices') return this.listInvoices(url);
    if (method === 'POST' && path === '/invoices') return this.createInvoice(body as Record<string, unknown>);
    return json(404, { status: 404, error: 'Not Found' });
  }

  private task(id: number) {
    return this.tasks.find((t) => t.id === id)!;
  }

  private project(id: number) {
    return this.projects.find((p) => p.id === id);
  }

  private clientRef(id: number): Named {
    const c = this.clients.find((x) => x.id === id)!;
    return { id: c.id, name: c.name };
  }

  private userName(id: number): string {
    return id === this.me.id ? `${this.me.first_name} ${this.me.last_name}` : `${this.teammate.first_name} ${this.teammate.last_name}`;
  }

  private liveHours(entry: FakeEntry): number {
    if (!entry.isRunning || !entry.timerStartedAt) return entry.hours;
    return round2(entry.hours + (this.now().getTime() - Date.parse(entry.timerStartedAt)) / 3_600_000);
  }

  private stop(entry: FakeEntry): void {
    entry.hours = Math.max(0.01, this.liveHours(entry));
    entry.isRunning = false;
    entry.timerStartedAt = null;
  }

  private stopRunningFor(userId: number): void {
    for (const e of this.entries) if (e.userId === userId && e.isRunning) this.stop(e);
  }

  entryJson(entry: FakeEntry) {
    const project = this.project(entry.projectId)!;
    const invoice = entry.invoiceId ? this.invoices.find((i) => i.id === entry.invoiceId) : undefined;
    const hours = this.liveHours(entry);
    return {
      id: entry.id,
      spent_date: entry.spentDate,
      hours,
      rounded_hours: hours,
      notes: entry.notes,
      is_locked: entry.isLocked,
      locked_reason: entry.isLocked ? 'Item Invoiced and Approved' : null,
      is_running: entry.isRunning,
      is_billed: entry.isBilled,
      billable: project.billable && this.task(entry.taskId).billable,
      timer_started_at: entry.timerStartedAt,
      started_time: entry.startedTime,
      ended_time: entry.endedTime,
      user: { id: entry.userId, name: this.userName(entry.userId) },
      client: this.clientRef(project.clientId),
      project: { id: project.id, name: project.name },
      task: { id: entry.taskId, name: this.task(entry.taskId).name },
      invoice: invoice ? { id: invoice.id, number: invoice.number } : null,
    };
  }

  private page(url: URL, key: string, items: unknown[], defaultPerPage = 2000): Response {
    const requested = Number(url.searchParams.get('per_page') ?? defaultPerPage);
    if (!Number.isInteger(requested) || requested < 1 || requested > 2000) return json(422, { message: 'Invalid per_page parameter' });
    const perPage = Math.min(requested, this.maxPerPage);
    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
    const totalPages = Math.max(1, Math.ceil(items.length / perPage));
    const link = (p: number) => {
      const u = new URL(url);
      u.searchParams.set('page', String(p));
      u.searchParams.set('per_page', String(perPage));
      return u.toString();
    };
    return json(200, {
      [key]: items.slice((page - 1) * perPage, page * perPage),
      per_page: perPage,
      total_pages: totalPages,
      total_entries: items.length,
      next_page: page < totalPages ? page + 1 : null,
      previous_page: page > 1 ? page - 1 : null,
      page,
      links: { first: link(1), next: page < totalPages ? link(page + 1) : null, previous: page > 1 ? link(page - 1) : null, last: link(totalPages) },
    });
  }

  private visibleEntries(): FakeEntry[] {
    return this.isAdmin ? this.entries : this.entries.filter((e) => e.userId === this.me.id);
  }

  private listEntries(url: URL): Response {
    const q = url.searchParams;
    const from = normalizeDate(q.get('from'));
    const to = normalizeDate(q.get('to'));
    if (from === 'invalid' || to === 'invalid') return json(422, { message: 'Invalid date' });
    const items = this.visibleEntries()
      .filter((e) => {
        const project = this.project(e.projectId)!;
        if (q.get('user_id') && e.userId !== Number(q.get('user_id'))) return false;
        if (q.get('project_id') && e.projectId !== Number(q.get('project_id'))) return false;
        if (q.get('client_id') && project.clientId !== Number(q.get('client_id'))) return false;
        if (q.get('task_id') && e.taskId !== Number(q.get('task_id'))) return false;
        if (q.get('is_billed') !== null && String(e.isBilled) !== q.get('is_billed')) return false;
        if (q.get('is_running') !== null && String(e.isRunning) !== q.get('is_running')) return false;
        if (from && e.spentDate < from) return false;
        if (to && e.spentDate > to) return false;
        return true;
      })
      .sort((a, b) => b.spentDate.localeCompare(a.spentDate) || b.id - a.id)
      .map((e) => this.entryJson(e));
    return this.page(url, 'time_entries', items);
  }

  private createEntry(body: Record<string, unknown>): Response {
    const projectId = Number(body['project_id']);
    const taskId = Number(body['task_id']);
    const spentDate = body['spent_date'];
    if (!projectId) return json(422, { message: "Project can't be blank" });
    if (!taskId) return json(422, { message: "Task can't be blank" });
    if (typeof spentDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(spentDate)) return json(422, { message: 'Spent date is invalid' });
    const project = this.project(projectId);
    if (!project || !project.taskIds.includes(taskId)) return json(422, { message: 'Task is not assigned to the project' });

    let hours = 0;
    let running = false;
    let startedTime: string | null = null;
    let endedTime: string | null = null;
    if (this.wantsTimestampTimers) {
      if (body['hours'] !== undefined) return json(422, { message: 'Hours can not be set when the account tracks time via start and end times' });
      startedTime = typeof body['started_time'] === 'string' ? body['started_time'] : '9:00am';
      endedTime = typeof body['ended_time'] === 'string' ? body['ended_time'] : null;
      if (endedTime) {
        const start = clockToMinutes(startedTime);
        const end = clockToMinutes(endedTime);
        if (start === null || end === null || end <= start) return json(422, { message: 'Started time and ended time are invalid' });
        hours = round2((end - start) / 60);
      } else {
        running = true;
      }
    } else {
      if (body['started_time'] !== undefined || body['ended_time'] !== undefined) {
        return json(422, { message: 'This account tracks time via duration' });
      }
      if (body['hours'] !== undefined) {
        hours = Number(body['hours']);
        if (!Number.isFinite(hours) || hours < 0 || hours > 24) return json(422, { message: 'Hours must be between 0 and 24' });
      } else {
        running = true;
      }
    }
    if (running) this.stopRunningFor(this.me.id);
    const entry = this.seedEntry({
      userId: this.me.id,
      projectId,
      taskId,
      spentDate,
      hours,
      notes: typeof body['notes'] === 'string' ? body['notes'] : null,
    });
    entry.isRunning = running;
    entry.timerStartedAt = running ? this.now().toISOString() : null;
    entry.startedTime = startedTime;
    entry.endedTime = endedTime;
    return json(201, this.entryJson(entry));
  }

  private updateEntry(entry: FakeEntry, body: Record<string, unknown>): Response {
    if (entry.isLocked) return json(422, { message: 'This time entry is locked' });
    const projectId = body['project_id'] !== undefined ? Number(body['project_id']) : entry.projectId;
    const taskId = body['task_id'] !== undefined ? Number(body['task_id']) : entry.taskId;
    const project = this.project(projectId);
    if (!project || !project.taskIds.includes(taskId)) return json(422, { message: 'Task is not assigned to the project' });
    entry.projectId = projectId;
    entry.taskId = taskId;
    if (typeof body['spent_date'] === 'string') entry.spentDate = body['spent_date'];
    if (body['hours'] !== undefined) {
      if (this.wantsTimestampTimers) return json(422, { message: 'Hours can not be set when the account tracks time via start and end times' });
      entry.hours = Number(body['hours']);
    }
    if (typeof body['started_time'] === 'string') entry.startedTime = body['started_time'];
    if (typeof body['ended_time'] === 'string') entry.endedTime = body['ended_time'];
    if (entry.startedTime && entry.endedTime && (body['started_time'] !== undefined || body['ended_time'] !== undefined)) {
      const start = clockToMinutes(entry.startedTime);
      const end = clockToMinutes(entry.endedTime);
      if (start !== null && end !== null && end > start) entry.hours = round2((end - start) / 60);
    }
    if (body['notes'] !== undefined) entry.notes = body['notes'] === '' ? null : String(body['notes']);
    return json(200, this.entryJson(entry));
  }

  private reportRange(url: URL): { from: string; to: string } | Response {
    const from = normalizeDate(url.searchParams.get('from'));
    const to = normalizeDate(url.searchParams.get('to'));
    if (!from || !to) return json(422, { message: 'from and to are required' });
    if (from === 'invalid' || to === 'invalid') return json(422, { message: 'Invalid date' });
    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
    if (days > 366) return json(422, { message: 'The timeframe can not exceed 1 year' });
    return { from, to };
  }

  private timeReport(url: URL, kind: string): Response {
    const range = this.reportRange(url);
    if (range instanceof Response) return range;
    if (kind === 'team' && this.role === 'member') return json(403, { message: 'Not allowed' });
    const rows = new Map<string, Record<string, unknown> & { total_hours: number; billable_hours: number; billable_amount: number }>();
    for (const e of this.visibleEntries()) {
      if (e.spentDate < range.from || e.spentDate > range.to) continue;
      const project = this.project(e.projectId)!;
      const client = this.clientRef(project.clientId);
      const billable = project.billable && this.task(e.taskId).billable;
      const hours = this.liveHours(e);
      let key: string;
      let base: Record<string, unknown>;
      if (kind === 'clients') {
        key = `c${client.id}`;
        base = { client_id: client.id, client_name: client.name };
      } else if (kind === 'projects') {
        key = `p${project.id}`;
        base = { project_id: project.id, project_name: project.name, client_id: client.id, client_name: client.name };
      } else if (kind === 'tasks') {
        key = `t${e.taskId}`;
        base = { task_id: e.taskId, task_name: this.task(e.taskId).name };
      } else {
        key = `u${e.userId}`;
        base = { user_id: e.userId, user_name: this.userName(e.userId), is_contractor: false, weekly_capacity: 144000 };
      }
      const row = rows.get(key) ?? { ...base, total_hours: 0, billable_hours: 0, billable_amount: 0, currency: 'USD' };
      row.total_hours = round2(row.total_hours + hours);
      if (billable) {
        row.billable_hours = round2(row.billable_hours + hours);
        row.billable_amount = round2(row.billable_amount + hours * project.rate);
      }
      rows.set(key, row);
    }
    const results = [...rows.values()].map((row) => {
      if (this.role === 'member') {
        const { billable_amount: _amount, currency: _currency, ...rest } = row;
        return rest;
      }
      return row;
    });
    return this.page(url, 'results', results);
  }

  private uninvoicedReport(url: URL): Response {
    if (this.role === 'member') return json(403, { message: 'Not allowed' });
    const range = this.reportRange(url);
    if (range instanceof Response) return range;
    const rows = new Map<number, { client_id: number; client_name: string; project_id: number; project_name: string; currency: string; total_hours: number; uninvoiced_hours: number; uninvoiced_expenses: number; uninvoiced_amount: number }>();
    for (const e of this.entries) {
      if (e.spentDate < range.from || e.spentDate > range.to) continue;
      const project = this.project(e.projectId)!;
      if (!project.billable) continue;
      const client = this.clientRef(project.clientId);
      const row = rows.get(project.id) ?? {
        client_id: client.id,
        client_name: client.name,
        project_id: project.id,
        project_name: project.name,
        currency: 'USD',
        total_hours: 0,
        uninvoiced_hours: 0,
        uninvoiced_expenses: 0,
        uninvoiced_amount: 0,
      };
      const hours = this.liveHours(e);
      row.total_hours = round2(row.total_hours + hours);
      if (!e.isBilled && !e.isRunning && this.task(e.taskId).billable) {
        row.uninvoiced_hours = round2(row.uninvoiced_hours + hours);
        row.uninvoiced_amount = round2(row.uninvoiced_amount + hours * project.rate);
      }
      rows.set(project.id, row);
    }
    return this.page(url, 'results', [...rows.values()]);
  }

  private invoiceJson(inv: FakeInvoice) {
    return {
      id: inv.id,
      client: this.clientRef(inv.clientId),
      number: inv.number,
      state: inv.state,
      amount: inv.amount,
      due_amount: inv.dueAmount,
      currency: 'USD',
      issue_date: inv.issueDate,
      due_date: inv.dueDate,
      subject: inv.subject,
      notes: inv.notes,
      payment_term: inv.paymentTerm,
      period_start: inv.periodStart,
      period_end: inv.periodEnd,
      line_items: inv.lineItems,
    };
  }

  private listInvoices(url: URL): Response {
    if (this.role === 'member') return json(403, { message: 'Not allowed' });
    const q = url.searchParams;
    const items = this.invoices
      .filter((inv) => (!q.get('state') || inv.state === q.get('state')) && (!q.get('client_id') || inv.clientId === Number(q.get('client_id'))))
      .filter((inv) => (!q.get('from') || inv.issueDate >= q.get('from')!) && (!q.get('to') || inv.issueDate <= q.get('to')!))
      .sort((a, b) => b.issueDate.localeCompare(a.issueDate) || b.id - a.id)
      .map((inv) => this.invoiceJson(inv));
    return this.page(url, 'invoices', items, 100);
  }

  private createInvoice(body: Record<string, unknown>): Response {
    if (this.role === 'member') return json(403, { message: 'Not allowed' });
    const clientId = Number(body['client_id']);
    if (!this.clients.some((c) => c.id === clientId)) return json(422, { message: 'Client is invalid' });
    const importSpec = body['line_items_import'] as { project_ids?: number[]; time?: { summary_type?: string; from?: string; to?: string } } | undefined;
    const lineItems: FakeInvoice['lineItems'] = [];
    let amount = 0;
    if (importSpec) {
      const projectIds = importSpec.project_ids ?? [];
      if (!projectIds.length) return json(422, { message: 'Project ids are required' });
      if (projectIds.some((id) => this.project(id)?.clientId !== clientId)) return json(422, { message: 'Projects must belong to the client' });
      const time = importSpec.time;
      if (time) {
        if (!['project', 'task', 'people', 'detailed'].includes(time.summary_type ?? '')) return json(422, { message: 'Summary type is invalid' });
        if (Boolean(time.from) !== Boolean(time.to)) return json(422, { message: 'from and to must be given together' });
        const groups = new Map<string, { description: string; hours: number; rate: number; project: Named }>();
        const entries = this.entries.filter(
          (e) =>
            projectIds.includes(e.projectId) &&
            !e.isBilled &&
            !e.isRunning &&
            this.task(e.taskId).billable &&
            (!time.from || (e.spentDate >= time.from && e.spentDate <= time.to!)),
        );
        for (const e of entries) {
          const project = this.project(e.projectId)!;
          const key =
            time.summary_type === 'project'
              ? `${project.id}`
              : time.summary_type === 'task'
                ? `${project.id}:${e.taskId}`
                : time.summary_type === 'people'
                  ? `${project.id}:${e.userId}`
                  : `${e.id}`;
          const description =
            time.summary_type === 'project'
              ? project.name
              : time.summary_type === 'task'
                ? `${project.name}: ${this.task(e.taskId).name}`
                : time.summary_type === 'people'
                  ? `${project.name}: ${this.userName(e.userId)}`
                  : `${project.name}: ${e.notes ?? ''}`;
          const group = groups.get(key) ?? { description, hours: 0, rate: project.rate, project: { id: project.id, name: project.name } };
          group.hours = round2(group.hours + e.hours);
          groups.set(key, group);
        }
        const invoiceId = this.nextId++;
        for (const e of entries) {
          e.isBilled = true;
          e.invoiceId = invoiceId;
        }
        for (const g of groups.values()) {
          const lineAmount = round2(g.hours * g.rate);
          amount = round2(amount + lineAmount);
          lineItems.push({ id: this.nextId++, kind: 'Service', description: g.description, quantity: g.hours, unit_price: g.rate, amount: lineAmount, project: g.project });
        }
        const invoice: FakeInvoice = {
          id: invoiceId,
          number: String(this.nextInvoiceNumber++),
          clientId,
          state: 'draft',
          amount,
          dueAmount: amount,
          issueDate: typeof body['issue_date'] === 'string' ? body['issue_date'] : this.today,
          dueDate: null,
          subject: typeof body['subject'] === 'string' ? body['subject'] : null,
          notes: typeof body['notes'] === 'string' ? body['notes'] : null,
          paymentTerm: typeof body['payment_term'] === 'string' ? body['payment_term'] : 'custom',
          periodStart: time.from ?? null,
          periodEnd: time.to ?? null,
          lineItems,
        };
        this.invoices.push(invoice);
        return json(201, this.invoiceJson(invoice));
      }
    }
    return json(422, { message: 'Nothing to invoice' });
  }
}

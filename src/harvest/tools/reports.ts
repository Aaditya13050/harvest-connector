import { z } from 'zod';
import { UserFacingError } from '../../core/errors.ts';
import { defineTool } from '../../core/tools.ts';
import { addDays, compactDate, daysBetween } from '../dates.ts';
import { formatHours, formatMoney, round2 } from '../format.ts';
import { resolveClient } from '../resolve.ts';
import type { HarvestSession } from '../session.ts';
import type { Invoice, TimeReportRow, UninvoicedRow } from '../types.ts';
import { hasRange, rangeFields, rangeFor } from './shared.ts';

const GROUPS = { client: 'clients', project: 'projects', task: 'tasks', team: 'team' } as const;

function checkReportRange(range: { from: string; to: string }) {
  if (daysBetween(range.from, range.to) > 365) {
    throw new UserFacingError('Harvest reports cover at most one year at a time. Use a shorter date range.');
  }
}

/** Sum amounts per currency: {"USD": 1200, "EUR": 300} → "$1,200.00 + €300.00". */
function moneyTotals(rows: { currency?: string; amount?: number }[]): { text: string; byCurrency: Record<string, number> } {
  const byCurrency: Record<string, number> = {};
  for (const row of rows) {
    if (row.amount === undefined || !row.currency) continue;
    byCurrency[row.currency] = round2((byCurrency[row.currency] ?? 0) + row.amount);
  }
  const text = Object.entries(byCurrency)
    .map(([currency, amount]) => formatMoney(amount, currency))
    .join(' + ');
  return { text, byCurrency };
}

export const timeReport = defineTool({
  name: 'get_time_report',
  title: 'Get time report',
  description:
    'Summarizes tracked hours for a date range (default: this month), grouped by client, project, task or team member, ' +
    'with billable hours and billable amounts where your role can see them. Members only see their own time.',
  access: 'read',
  input: z.object({
    ...rangeFields,
    group_by: z
      .enum(['client', 'project', 'task', 'team'])
      .optional()
      .describe('How to group the hours. Default project. "team" lists each person (Administrators and Managers).'),
  }),
  async run(input, s: HarvestSession) {
    const range = await rangeFor(s, input, 'this_month');
    checkReportRange(range);
    const group = input.group_by ?? 'project';
    const result = await s.client.list<TimeReportRow>(`/reports/time/${GROUPS[group]}`, 'results', {
      from: compactDate(range.from),
      to: compactDate(range.to),
    });
    const rows = [...result.items].sort((a, b) => b.total_hours - a.total_hours);
    const label = (r: TimeReportRow): string => {
      switch (group) {
        case 'client':
          return r.client_name ?? `Client ${r.client_id}`;
        case 'project':
          return `${r.client_name ? `${r.client_name} / ` : ''}${r.project_name ?? `Project ${r.project_id}`}`;
        case 'task':
          return r.task_name ?? `Task ${r.task_id}`;
        case 'team':
          return `${r.user_name ?? `User ${r.user_id}`}${r.is_contractor ? ' (contractor)' : ''}`;
      }
    };

    const total = rows.reduce((sum, r) => sum + r.total_hours, 0);
    const billable = rows.reduce((sum, r) => sum + r.billable_hours, 0);
    const money = moneyTotals(rows.map((r) => ({ currency: r.currency, amount: r.billable_amount })));
    const lines = [
      `Time from ${range.from} to ${range.to} by ${group}: ${formatHours(total)} total, ${formatHours(billable)} billable${
        money.text ? ` (${money.text})` : ''
      }.`,
    ];
    if (!s.isManager) lines.push('Only your own time is included because your Harvest role is Member.');
    if (rows.length === 0) lines.push('No time was tracked in this period.');
    for (const r of rows.slice(0, 100)) {
      const amount = r.billable_amount !== undefined && r.currency ? ` · ${formatMoney(r.billable_amount, r.currency)}` : '';
      lines.push(`- ${label(r)}: ${formatHours(r.total_hours)} (${formatHours(r.billable_hours)} billable)${amount}`);
    }
    if (rows.length > 100) lines.push(`…and ${rows.length - 100} more rows.`);

    return {
      text: lines.join('\n'),
      data: {
        from: range.from,
        to: range.to,
        group_by: group,
        rows: rows.map((r) => ({
          name: label(r),
          total_hours: round2(r.total_hours),
          billable_hours: round2(r.billable_hours),
          billable_amount: r.billable_amount ?? null,
          currency: r.currency ?? null,
          id: r.client_id ?? r.project_id ?? r.task_id ?? r.user_id ?? null,
        })),
        totals: { hours: round2(total), billable_hours: round2(billable), billable_amount: money.byCurrency },
      },
    };
  },
});

export const uninvoicedReport = defineTool({
  name: 'get_uninvoiced_report',
  title: 'Get uninvoiced work',
  description:
    'Shows work that has been tracked but not invoiced yet, per project: hours, expenses and amount to bill. ' +
    'Default range: the last 12 months. Needs Administrator access, or a Manager who can create invoices.',
  access: 'read',
  input: z.object({
    ...rangeFields,
    client: z.string().max(200).optional().describe('Only this client (name or ID).'),
  }),
  async run(input, s: HarvestSession) {
    const today = await s.today();
    const range = hasRange(input) ? await rangeFor(s, input, 'this_month') : { from: addDays(today, -364), to: today };
    checkReportRange(range);
    const client = input.client ? await resolveClient(s, input.client) : undefined;

    const result = await s.client.list<UninvoicedRow>('/reports/uninvoiced', 'results', {
      from: compactDate(range.from),
      to: compactDate(range.to),
    });
    const rows = result.items
      .filter((r) => !client || r.client_id === client.id)
      .filter((r) => r.uninvoiced_hours > 0 || r.uninvoiced_expenses > 0 || r.uninvoiced_amount > 0)
      .sort((a, b) => b.uninvoiced_amount - a.uninvoiced_amount);

    const money = moneyTotals(rows.map((r) => ({ currency: r.currency, amount: r.uninvoiced_amount })));
    const hours = rows.reduce((sum, r) => sum + r.uninvoiced_hours, 0);
    const scope = client ? ` for ${client.name}` : '';
    const lines = [
      rows.length
        ? `Uninvoiced work${scope} from ${range.from} to ${range.to}: ${formatHours(hours)}, ${money.text || 'no billable amount'}.`
        : `Nothing left to invoice${scope} between ${range.from} and ${range.to}.`,
    ];
    for (const r of rows.slice(0, 100)) {
      const expenses = r.uninvoiced_expenses > 0 ? ` + ${formatMoney(r.uninvoiced_expenses, r.currency)} expenses` : '';
      lines.push(
        `- ${r.client_name} / ${r.project_name} (project ID ${r.project_id}): ${formatHours(r.uninvoiced_hours)}${expenses} → ${formatMoney(
          r.uninvoiced_amount,
          r.currency,
        )}`,
      );
    }
    return {
      text: lines.join('\n'),
      data: {
        from: range.from,
        to: range.to,
        rows: rows.map((r) => ({
          client: { id: r.client_id, name: r.client_name },
          project: { id: r.project_id, name: r.project_name },
          uninvoiced_hours: round2(r.uninvoiced_hours),
          uninvoiced_expenses: r.uninvoiced_expenses,
          uninvoiced_amount: r.uninvoiced_amount,
          currency: r.currency,
        })),
        totals: { hours: round2(hours), amount: money.byCurrency },
      },
    };
  },
});

export const listInvoices = defineTool({
  name: 'list_invoices',
  title: 'List invoices',
  description:
    'Lists Harvest invoices, newest first, with number, client, state (draft, open, paid, closed), dates, amount and amount due. ' +
    'Filter by state, client or issue-date range. Needs permission to view invoices.',
  access: 'read',
  input: z.object({
    state: z.enum(['draft', 'open', 'paid', 'closed']).optional().describe('Only invoices in this state.'),
    client: z.string().max(200).optional().describe('Client name or ID.'),
    ...rangeFields,
    limit: z.number().int().min(1).max(100).optional().describe('Most invoices to return. Default 20.'),
  }),
  async run(input, s: HarvestSession) {
    const query: Record<string, string | number | undefined> = { state: input.state };
    if (input.client) query['client_id'] = (await resolveClient(s, input.client)).id;
    if (hasRange(input)) {
      const range = await rangeFor(s, input, 'this_year');
      query['from'] = range.from;
      query['to'] = range.to;
    }
    const limit = input.limit ?? 20;
    const result = await s.client.list<Invoice>('/invoices', 'invoices', query, limit);
    const invoices = result.items;
    if (invoices.length === 0) return { text: 'No invoices match.', data: { invoices: [] } };

    const lines = [`${invoices.length} invoice${invoices.length === 1 ? '' : 's'}${result.truncated ? ' (more exist)' : ''}:`];
    for (const inv of invoices) {
      const due = inv.due_amount > 0 && inv.state !== 'draft' ? `, ${formatMoney(inv.due_amount, inv.currency)} due` : '';
      lines.push(
        `- #${inv.number} · ${inv.client.name} · ${inv.state} · issued ${inv.issue_date ?? 'not yet'}${
          inv.due_date ? ` · due ${inv.due_date}` : ''
        } · ${formatMoney(inv.amount, inv.currency)}${due}${inv.subject ? ` · "${inv.subject}"` : ''} (invoice ID ${inv.id})`,
      );
    }
    return {
      text: lines.join('\n'),
      data: {
        invoices: invoices.map((inv) => ({
          id: inv.id,
          number: inv.number,
          client: inv.client,
          state: inv.state,
          amount: inv.amount,
          due_amount: inv.due_amount,
          currency: inv.currency,
          issue_date: inv.issue_date,
          due_date: inv.due_date,
          subject: inv.subject,
        })),
        truncated: result.truncated,
      },
    };
  },
});

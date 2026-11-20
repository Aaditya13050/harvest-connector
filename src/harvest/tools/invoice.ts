import { z } from 'zod';
import { UserFacingError } from '../../core/errors.ts';
import { defineTool } from '../../core/tools.ts';
import { addDays, compactDate } from '../dates.ts';
import { formatHours, formatMoney, truncate } from '../format.ts';
import { clientProjects, pickOne, resolveClient } from '../resolve.ts';
import type { HarvestSession } from '../session.ts';
import type { IdName, Invoice, UninvoicedRow } from '../types.ts';
import { dateField, hasRange, rangeFields, rangeFor } from './shared.ts';

export const createInvoiceDraft = defineTool({
  name: 'create_invoice_draft',
  title: 'Create draft invoice',
  description:
    "Creates a DRAFT Harvest invoice for a client from their uninvoiced tracked time (and optionally expenses), grouped into lines by task, project, person or entry. " +
    'It is never sent: the person reviews and sends it in Harvest. By default it bills all uninvoiced time on all of the client’s active projects; ' +
    'limit it with projects and a date range. Needs permission to create invoices.',
  access: 'write',
  input: z.object({
    client: z.string().min(1).max(200).describe('Client name or ID.'),
    projects: z
      .array(z.string().max(200))
      .max(50)
      .optional()
      .describe("Projects to bill (names, codes or IDs). Default: all of the client's active projects."),
    ...rangeFields,
    group_lines_by: z
      .enum(['task', 'project', 'people', 'detailed'])
      .optional()
      .describe('How tracked time becomes invoice lines. Default task. "detailed" makes one line per time entry.'),
    include_expenses: z.boolean().optional().describe('Also bill uninvoiced expenses. Default false.'),
    subject: z.string().max(255).optional().describe('Invoice subject line.'),
    notes: z.string().max(5000).optional().describe('Notes printed on the invoice.'),
    issue_date: dateField.optional().describe('Issue date, YYYY-MM-DD. Default today.'),
    payment_term: z
      .enum(['upon receipt', 'net 15', 'net 30', 'net 45', 'net 60'])
      .optional()
      .describe('When payment is due. Default: the account’s setting.'),
  }),
  async run(input, s: HarvestSession) {
    s.requireWrite();
    const client = await resolveClient(s, input.client);
    const available = await clientProjects(s, client.id);
    if (available.length === 0) throw new UserFacingError(`${client.name} has no active projects to invoice.`);

    let projects: IdName[] = available;
    if (input.projects?.length) {
      const picked = input.projects.map((query) =>
        pickOne(available, query, {
          kind: `project of ${client.name}`,
          id: (p) => p.id,
          names: (p) => [p.name],
          label: (p) => `${p.name} (ID ${p.id})`,
        }),
      );
      projects = [...new Map(picked.map((p) => [p.id, p])).values()];
    }
    const projectIds = new Set(projects.map((p) => p.id));

    // Check there is something to bill first, so we never leave an empty draft behind.
    const today = await s.today();
    const range = hasRange(input) ? await rangeFor(s, input, 'this_month') : undefined;
    const check = range ?? { from: addDays(today, -364), to: today };
    const report = await s.client.list<UninvoicedRow>('/reports/uninvoiced', 'results', {
      from: compactDate(check.from),
      to: compactDate(check.to),
    });
    const rows = report.items.filter((r) => projectIds.has(r.project_id));
    const hours = rows.reduce((sum, r) => sum + r.uninvoiced_hours, 0);
    const expenses = rows.reduce((sum, r) => sum + r.uninvoiced_expenses, 0);
    if (hours <= 0 && (!input.include_expenses || expenses <= 0)) {
      const when = range ? `between ${range.from} and ${range.to}` : 'in the last 12 months';
      throw new UserFacingError(
        `${client.name} has no uninvoiced time${input.include_expenses ? ' or expenses' : ''} ${when} on ${
          projects.length === available.length ? 'its active projects' : projects.map((p) => p.name).join(', ')
        }, so no invoice was created.${range ? '' : ' Give from and to to bill older work.'}`,
      );
    }

    const window = range ? { from: range.from, to: range.to } : {};
    const body: Record<string, unknown> = {
      client_id: client.id,
      line_items_import: {
        project_ids: [...projectIds],
        time: { summary_type: input.group_lines_by ?? 'task', ...window },
        ...(input.include_expenses ? { expenses: { summary_type: 'category', ...window } } : {}),
      },
    };
    if (input.subject) body['subject'] = input.subject;
    if (input.notes) body['notes'] = input.notes;
    if (input.issue_date) body['issue_date'] = input.issue_date;
    if (input.payment_term) body['payment_term'] = input.payment_term;

    const invoice = await s.client.post<Invoice>('/invoices', body);
    const company = await s.company();
    const link = company?.full_domain ? `https://${company.full_domain}/invoices/${invoice.id}` : undefined;
    const lines = invoice.line_items ?? [];

    const text = [
      `Created DRAFT invoice #${invoice.number} for ${invoice.client.name}: ${formatMoney(invoice.amount, invoice.currency)} ` +
        `(${formatHours(hours)} of time${input.include_expenses && expenses > 0 ? ` + ${formatMoney(expenses, invoice.currency)} expenses` : ''}). ` +
        'It has not been sent to the client.',
      ...lines.slice(0, 15).map(
        (l) => `- ${truncate(l.description || l.kind, 120)}: ${l.quantity} × ${formatMoney(l.unit_price, invoice.currency)} = ${formatMoney(l.amount, invoice.currency)}`,
      ),
      lines.length > 15 ? `…and ${lines.length - 15} more lines.` : '',
      link ? `Review and send it in Harvest: ${link}` : 'Review and send it from Invoices in Harvest.',
    ]
      .filter(Boolean)
      .join('\n');

    return {
      text,
      data: {
        invoice: {
          id: invoice.id,
          number: invoice.number,
          state: invoice.state,
          client: invoice.client,
          amount: invoice.amount,
          currency: invoice.currency,
          issue_date: invoice.issue_date,
          due_date: invoice.due_date,
          line_count: lines.length,
          url: link ?? null,
        },
      },
    };
  },
});

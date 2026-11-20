import { z } from 'zod';
import { defineTool } from '../../core/tools.ts';
import { todayIn, weekdayName } from '../dates.ts';
import { describeEntry, entrySummary, formatHours, round2 } from '../format.ts';
import { normalize, resolveClient } from '../resolve.ts';
import type { HarvestSession } from '../session.ts';
import type { TimeEntry } from '../types.ts';
import { rangeFields, rangeFor, resolveAnyProject } from './shared.ts';

export const getHarvestProfile = defineTool({
  name: 'get_harvest_profile',
  title: 'Get Harvest profile',
  description:
    "Shows which Harvest account and person this connection uses, their role, their time zone and today's date there, " +
    'the account settings that affect time entry (durations or start/end times, week start, currency), ' +
    'and whether this connection may make changes.',
  access: 'read',
  input: z.object({}),
  async run(_args, s: HarvestSession) {
    const [me, company, tz] = await Promise.all([s.me(), s.company(), s.timeZone()]);
    const today = todayIn(tz.zone, s.currentTime());
    const weekStart = await s.weekStart();
    const lines = [
      `Harvest account: ${s.props.accountName} (ID ${s.props.accountId})`,
      `Person: ${me.first_name} ${me.last_name} (user ID ${me.id}), role: ${s.roleLabel}`,
      tz.known
        ? `Time zone: ${tz.harvestName} (${tz.zone}). Today there is ${today} (${weekdayName(today)}).`
        : `Time zone: unknown${tz.harvestName ? ` ("${tz.harvestName}")` : ''}, so dates use UTC. Today in UTC is ${today}.`,
      `Weeks start on ${weekStart}.`,
    ];
    if (company) {
      lines.push(
        company.wants_timestamp_timers
          ? 'Time is recorded as start and end times.'
          : 'Time is recorded as durations (hours).',
        `Company: ${company.name}${company.currency_code_display ? `, currency ${company.currency_code_display}` : ''}${
          company.plan_type ? `, plan ${company.plan_type}` : ''
        }.`,
      );
    } else {
      lines.push('Company settings are only visible to Harvest Administrators.');
    }
    lines.push(
      s.canWrite
        ? 'This connection can read and make changes (log time, timers, draft invoices).'
        : 'This connection is read-only.',
    );
    return {
      text: lines.join('\n'),
      data: {
        account: { id: s.props.accountId, name: s.props.accountName },
        user: { id: me.id, name: `${me.first_name} ${me.last_name}`, role: s.roleLabel, email: me.email ?? null },
        time_zone: { harvest: tz.harvestName, iana: tz.zone, known: tz.known },
        today,
        week_start: weekStart,
        time_entry_mode: company ? (company.wants_timestamp_timers ? 'start_end_times' : 'durations') : 'unknown',
        currency: company?.currency_code_display ?? null,
        can_write: s.canWrite,
      },
    };
  },
});

export const listProjects = defineTool({
  name: 'list_projects',
  title: 'List my projects and tasks',
  description:
    'Lists the active Harvest projects you can log time to, grouped by client, with each project’s tasks and IDs. ' +
    'Project and task names from here can be passed to the time tools.',
  access: 'read',
  input: z.object({
    search: z.string().max(100).optional().describe('Only projects whose client, project name or code contains this text.'),
    include_tasks: z.boolean().optional().describe('Include each project’s tasks. Default true.'),
  }),
  async run({ search, include_tasks = true }, s: HarvestSession) {
    let assignments = await s.assignments();
    if (search) {
      const q = normalize(search);
      assignments = assignments.filter((a) =>
        normalize(`${a.client.name} ${a.project.name} ${a.project.code ?? ''}`).includes(q),
      );
    }
    assignments = [...assignments].sort(
      (a, b) => a.client.name.localeCompare(b.client.name) || a.project.name.localeCompare(b.project.name),
    );
    if (assignments.length === 0) {
      return {
        text: search ? `No active projects match "${search}".` : 'You are not assigned to any active projects in Harvest.',
        data: { projects: [] },
      };
    }

    const shown = assignments.slice(0, 150);
    const lines: string[] = [`${assignments.length} active project${assignments.length === 1 ? '' : 's'}:`];
    let currentClient = '';
    for (const a of shown) {
      if (a.client.name !== currentClient) {
        currentClient = a.client.name;
        lines.push(`\n${currentClient} (client ID ${a.client.id})`);
      }
      lines.push(`• ${a.project.name}${a.project.code ? ` [${a.project.code}]` : ''} — project ID ${a.project.id}`);
      if (include_tasks) {
        const tasks = a.task_assignments.filter((t) => t.is_active);
        lines.push(`  tasks: ${tasks.map((t) => `${t.task.name} (ID ${t.task.id}${t.billable === false ? ', non-billable' : ''})`).join(', ') || 'none'}`);
      }
    }
    if (assignments.length > shown.length) lines.push(`\n…and ${assignments.length - shown.length} more. Use search to narrow.`);

    return {
      text: lines.join('\n'),
      data: {
        projects: shown.map((a) => ({
          id: a.project.id,
          name: a.project.name,
          code: a.project.code ?? null,
          client: a.client,
          tasks: a.task_assignments.filter((t) => t.is_active).map((t) => ({ id: t.task.id, name: t.task.name, billable: t.billable ?? null })),
        })),
        total: assignments.length,
      },
    };
  },
});

export const listTimeEntries = defineTool({
  name: 'list_time_entries',
  title: 'List time entries',
  description:
    'Lists Harvest time entries in a date range (default: this week), newest first, with totals. ' +
    'Filter by project, client, task or invoiced status. By default only your own time; Administrators and Managers can include teammates.',
  access: 'read',
  input: z.object({
    ...rangeFields,
    project: z.string().max(200).optional().describe('Project name, code or ID.'),
    client: z.string().max(200).optional().describe('Client name or ID.'),
    task: z.string().max(200).optional().describe('Task name (or part of it) or task ID.'),
    everyone: z.boolean().optional().describe("Include teammates' time (Administrators and Managers). Default false."),
    invoiced: z.boolean().optional().describe('true: only invoiced entries. false: only entries not invoiced yet.'),
    limit: z.number().int().min(1).max(500).optional().describe('Most entries to return. Default 100.'),
  }),
  async run(input, s: HarvestSession) {
    const range = await rangeFor(s, input, 'this_week');
    const query: Record<string, string | number | boolean | undefined> = { from: range.from, to: range.to };
    if (!input.everyone) query['user_id'] = s.props.userId;
    if (input.invoiced !== undefined) query['is_billed'] = input.invoiced;
    let projectLabel: string | undefined;
    if (input.project) {
      const project = await resolveAnyProject(s, input.project);
      query['project_id'] = project.id;
      projectLabel = `${project.client.name} / ${project.name}`;
    }
    if (input.client) query['client_id'] = (await resolveClient(s, input.client)).id;

    let taskFilter: ((e: TimeEntry) => boolean) | undefined;
    if (input.task) {
      const t = input.task.trim();
      if (/^\d+$/.test(t)) query['task_id'] = Number(t);
      else taskFilter = (e) => normalize(e.task.name).includes(normalize(t));
    }

    const limit = input.limit ?? 100;
    // When filtering by task name locally, fetch extra so the limit still applies after filtering.
    const fetched = await s.client.list<TimeEntry>('/time_entries', 'time_entries', query, taskFilter ? 2000 : limit);
    const matching = taskFilter ? fetched.items.filter(taskFilter) : fetched.items;
    const entries = matching.slice(0, limit);
    const truncated = matching.length > limit || (!taskFilter && fetched.truncated);

    const total = entries.reduce((sum, e) => sum + e.hours, 0);
    const billable = entries.filter((e) => e.billable).reduce((sum, e) => sum + e.hours, 0);
    const byProject = new Map<string, number>();
    for (const e of entries) {
      const key = `${e.client.name} / ${e.project.name}`;
      byProject.set(key, (byProject.get(key) ?? 0) + e.hours);
    }

    const scope = input.everyone ? 'everyone' : 'you';
    const header = `${entries.length} time entr${entries.length === 1 ? 'y' : 'ies'} for ${scope} from ${range.from} to ${range.to}${
      projectLabel ? ` on ${projectLabel}` : ''
    }: ${formatHours(total)} total, ${formatHours(billable)} billable.`;
    const lines = [header];
    if (entries.length) {
      lines.push('', ...entries.map((e) => `- ${describeEntry(e, { showUser: input.everyone ?? false })}`));
      if (byProject.size > 1) {
        lines.push('', 'By project:');
        for (const [name, hours] of [...byProject].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
          lines.push(`- ${name}: ${formatHours(hours)}`);
        }
      }
    }
    if (truncated) lines.push('', `Only the first ${entries.length} entries are shown; narrow the dates or filters to see the rest.`);

    return {
      text: lines.join('\n'),
      data: {
        from: range.from,
        to: range.to,
        entries: entries.map(entrySummary),
        totals: { hours: round2(total), billable_hours: round2(billable) },
        truncated,
      },
    };
  },
});

export const getRunningTimer = defineTool({
  name: 'get_running_timer',
  title: 'Get running timer',
  description: 'Shows your currently running Harvest timer, if any: project, task, notes and time so far.',
  access: 'read',
  input: z.object({}),
  async run(_args, s: HarvestSession) {
    const entry = await s.runningTimer();
    if (!entry) return { text: 'No timer is running.', data: { running: null } };
    const started = entry.timer_started_at ? ` Timer started at ${entry.timer_started_at} (UTC).` : '';
    return { text: `Running: ${describeEntry(entry)}.${started}`, data: { running: entrySummary(entry) } };
  },
});

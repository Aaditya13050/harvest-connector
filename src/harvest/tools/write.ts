import { z } from 'zod';
import { UserFacingError } from '../../core/errors.ts';
import { defineTool } from '../../core/tools.ts';
import { HarvestApiError } from '../client.ts';
import { assertDate } from '../dates.ts';
import { describeEntry, entrySummary, formatClockTime, formatHours, parseClockTime, parseHours, round2 } from '../format.ts';
import { pickProject, pickTask, resolveProjectTask } from '../resolve.ts';
import type { HarvestSession } from '../session.ts';
import type { TimeEntry } from '../types.ts';
import { dateField } from './shared.ts';

type TimeMode = 'durations' | 'start_end_times' | 'unknown';

/** Whether this account records durations or start/end times (unknown for non-admins). */
async function timeMode(s: HarvestSession): Promise<TimeMode> {
  const company = await s.company();
  if (!company) return 'unknown';
  return company.wants_timestamp_timers ? 'start_end_times' : 'durations';
}

const durationFields = {
  hours: z
    .union([z.number(), z.string().max(20)])
    .optional()
    .describe('How long, e.g. 1.5, "1:30" or "1h 30m".'),
  start_time: z.string().max(12).optional().describe('Start time of day, e.g. "9:00am" or "14:00". Use with end_time.'),
  end_time: z.string().max(12).optional().describe('End time of day, e.g. "10:30am" or "15:30". Use with start_time.'),
};

/**
 * Build the hours / started_time / ended_time part of a time-entry body from what the person
 * gave, respecting how the account records time. Returns {} when nothing was given.
 */
async function durationBody(
  s: HarvestSession,
  input: { hours?: number | string | undefined; start_time?: string | undefined; end_time?: string | undefined },
): Promise<Record<string, unknown>> {
  const hasTimes = input.start_time !== undefined || input.end_time !== undefined;
  if (!hasTimes && input.hours === undefined) return {};
  if (hasTimes && input.hours !== undefined) {
    throw new UserFacingError('Give either hours or start_time and end_time, not both.');
  }
  const mode = await timeMode(s);
  if (hasTimes) {
    if (!input.start_time || !input.end_time) throw new UserFacingError('Give both start_time and end_time, or give hours instead.');
    const start = parseClockTime(input.start_time);
    const end = parseClockTime(input.end_time);
    if (end <= start) throw new UserFacingError('end_time must be later than start_time on the same day.');
    if (mode === 'durations') return { hours: round2((end - start) / 60) };
    const clock = (await s.company())?.clock === '24h' ? '24h' : '12h';
    return { started_time: formatClockTime(start, clock), ended_time: formatClockTime(end, clock) };
  }
  if (mode === 'start_end_times') {
    throw new UserFacingError(
      'This Harvest account records start and end times instead of durations. Give start_time and end_time, for example 9:00am and 10:30am.',
    );
  }
  return { hours: parseHours(input.hours!) };
}

/** Explain a 422 that is probably caused by the account's time-entry mode. */
function withModeHint(error: unknown, mode: TimeMode, sentHours: boolean): unknown {
  if (error instanceof HarvestApiError && error.status === 422 && mode === 'unknown' && sentHours) {
    return new UserFacingError(
      `Harvest could not save this: ${error.message}. If this account records start and end times, give start_time and end_time instead of hours.`,
    );
  }
  return error;
}

function place(e: TimeEntry): string {
  return `${e.client.name} / ${e.project.name} / ${e.task.name}`;
}

export const logTime = defineTool({
  name: 'log_time',
  title: 'Log time',
  description:
    'Adds a completed time entry to Harvest for you: project, task, date (default today in your Harvest time zone), ' +
    'duration or start/end times, and notes. Projects and tasks can be given by name or ID. To track time live, use start_timer.',
  access: 'write',
  input: z.object({
    project: z.string().min(1).max(200).describe('Project name, code or ID.'),
    task: z.string().max(200).optional().describe('Task name or ID. Optional when the project has a single task.'),
    date: dateField.optional().describe('Day the work happened, YYYY-MM-DD. Default today.'),
    ...durationFields,
    notes: z.string().max(5000).optional().describe('What was done.'),
  }),
  async run(input, s: HarvestSession) {
    s.requireWrite();
    const { assignment, task } = await resolveProjectTask(s, input.project, input.task);
    const date = input.date ? assertDate(input.date, 'date') : await s.today();
    const duration = await durationBody(s, input);
    if (Object.keys(duration).length === 0) {
      throw new UserFacingError('Give hours (for example 1.5) or start_time and end_time. To track time live, use start_timer.');
    }
    const body: Record<string, unknown> = { project_id: assignment.project.id, task_id: task.task.id, spent_date: date, ...duration };
    if (input.notes) body['notes'] = input.notes;

    let entry: TimeEntry;
    try {
      entry = await s.client.post<TimeEntry>('/time_entries', body);
    } catch (error) {
      throw withModeHint(error, await timeMode(s), 'hours' in duration);
    }
    return {
      text: `Logged ${formatHours(entry.hours)} on ${entry.spent_date} to ${place(entry)}.\n${describeEntry(entry)}`,
      data: { entry: entrySummary(entry) },
    };
  },
});

export const startTimer = defineTool({
  name: 'start_timer',
  title: 'Start timer',
  description:
    'Starts a running Harvest timer on a project and task (by name or ID), with optional notes. ' +
    'If another timer of yours is running it is stopped first, since Harvest runs one timer at a time.',
  access: 'write',
  input: z.object({
    project: z.string().min(1).max(200).describe('Project name, code or ID.'),
    task: z.string().max(200).optional().describe('Task name or ID. Optional when the project has a single task.'),
    notes: z.string().max(5000).optional().describe('What you are working on.'),
    date: dateField.optional().describe('Day to track against, YYYY-MM-DD. Default today.'),
  }),
  async run(input, s: HarvestSession) {
    s.requireWrite();
    const { assignment, task } = await resolveProjectTask(s, input.project, input.task);
    const date = input.date ? assertDate(input.date, 'date') : await s.today();

    const previous = await s.runningTimer();
    let stopped: TimeEntry | undefined;
    if (previous) stopped = await s.client.patch<TimeEntry>(`/time_entries/${previous.id}/stop`);

    const body: Record<string, unknown> = { project_id: assignment.project.id, task_id: task.task.id, spent_date: date };
    if (input.notes) body['notes'] = input.notes;
    const entry = await s.client.post<TimeEntry>('/time_entries', body);

    const lines = [`Timer started on ${place(entry)} (entry ID ${entry.id}).`];
    if (stopped) lines.push(`Stopped the timer that was running on ${place(stopped)} at ${formatHours(stopped.hours)}.`);
    return {
      text: lines.join('\n'),
      data: { entry: entrySummary(entry), stopped: stopped ? entrySummary(stopped) : null },
    };
  },
});

export const stopTimer = defineTool({
  name: 'stop_timer',
  title: 'Stop timer',
  description: 'Stops your running Harvest timer (or the running entry with the given ID) and reports the time recorded.',
  access: 'write',
  idempotent: true,
  input: z.object({
    time_entry_id: z.number().int().positive().optional().describe('ID of the running entry. Default: your running timer.'),
  }),
  async run(input, s: HarvestSession) {
    s.requireWrite();
    let id = input.time_entry_id;
    if (id === undefined) {
      const running = await s.runningTimer();
      if (!running) return { text: 'No timer is running, so nothing was stopped.', data: { stopped: null } };
      id = running.id;
    }
    try {
      const entry = await s.client.patch<TimeEntry>(`/time_entries/${id}/stop`);
      return {
        text: `Stopped the timer: ${formatHours(entry.hours)} on ${place(entry)}.\n${describeEntry(entry)}`,
        data: { stopped: entrySummary(entry) },
      };
    } catch (error) {
      if (error instanceof HarvestApiError && error.status === 422) {
        const entry = await s.client.get<TimeEntry>(`/time_entries/${id}`);
        if (!entry.is_running) {
          return { text: `Entry ${id} isn't running, so nothing was stopped.\n${describeEntry(entry)}`, data: { stopped: null } };
        }
      }
      throw error;
    }
  },
});

export const updateTimeEntry = defineTool({
  name: 'update_time_entry',
  title: 'Update time entry',
  description:
    'Changes an existing Harvest time entry: project, task, date, duration or start/end times, or notes. ' +
    'Only the fields given are changed; notes replace the old notes. Returns the entry before and after.',
  access: 'destructive',
  idempotent: true,
  input: z.object({
    time_entry_id: z.number().int().positive().describe('ID of the entry to change (from list_time_entries).'),
    project: z.string().max(200).optional().describe('Move to this project (name, code or ID).'),
    task: z.string().max(200).optional().describe('Move to this task (name or ID).'),
    date: dateField.optional().describe('New date, YYYY-MM-DD.'),
    ...durationFields,
    notes: z.string().max(5000).optional().describe('New notes, replacing the old ones. An empty string clears them.'),
  }),
  async run(input, s: HarvestSession) {
    s.requireWrite();
    const before = await s.client.get<TimeEntry>(`/time_entries/${input.time_entry_id}`);
    if (before.is_locked) {
      throw new UserFacingError(
        `Entry ${before.id} is locked${before.locked_reason ? ` (${before.locked_reason})` : ''}, so it can't be changed.`,
      );
    }

    const body: Record<string, unknown> = {};
    if (input.project) {
      const assignment = pickProject(await s.assignments(), input.project);
      // Keep the entry's current task when the new project has it; otherwise a task is needed.
      const keepsTask = assignment.task_assignments.find((t) => t.is_active && t.task.id === before.task.id);
      const task = input.task ? pickTask(assignment, input.task) : (keepsTask ?? pickTask(assignment, undefined));
      body['project_id'] = assignment.project.id;
      body['task_id'] = task.task.id;
    } else if (input.task) {
      const assignment = (await s.assignments()).find((a) => a.project.id === before.project.id);
      if (!assignment) {
        throw new UserFacingError(`You're not assigned to "${before.project.name}" any more, so its tasks can't be listed. Give a project as well.`);
      }
      body['task_id'] = pickTask(assignment, input.task).task.id;
    }
    if (input.date) body['spent_date'] = assertDate(input.date, 'date');
    Object.assign(body, await durationBody(s, input));
    if (input.notes !== undefined) body['notes'] = input.notes;
    if (Object.keys(body).length === 0) throw new UserFacingError('Nothing to change: give at least one field to update.');

    const after = await s.client.patch<TimeEntry>(`/time_entries/${before.id}`, body);
    return {
      text: `Updated entry ${after.id}.\nBefore: ${describeEntry(before)}\nAfter: ${describeEntry(after)}`,
      data: { before: entrySummary(before), after: entrySummary(after) },
    };
  },
});

export const deleteTimeEntry = defineTool({
  name: 'delete_time_entry',
  title: 'Delete time entry',
  description:
    'Permanently deletes a Harvest time entry. Without confirm set to true it changes nothing and returns a preview of the entry, ' +
    'so the person can check it first.',
  access: 'destructive',
  input: z.object({
    time_entry_id: z.number().int().positive().describe('ID of the entry to delete (from list_time_entries).'),
    confirm: z.boolean().optional().describe('true to delete. Anything else only returns a preview.'),
  }),
  async run(input, s: HarvestSession) {
    s.requireWrite();
    const entry = await s.client.get<TimeEntry>(`/time_entries/${input.time_entry_id}`);
    if (input.confirm !== true) {
      return {
        text: `Preview only, nothing was deleted. This entry would be permanently deleted:\n${describeEntry(entry)}\nTo delete it, call delete_time_entry again with confirm set to true.`,
        data: { deleted: false, preview: entrySummary(entry) },
      };
    }
    if (entry.is_billed) {
      throw new UserFacingError(`Entry ${entry.id} is already on an invoice, so it can't be deleted. Remove it from the invoice in Harvest first.`);
    }
    await s.client.delete(`/time_entries/${entry.id}`);
    return { text: `Deleted: ${describeEntry(entry)}`, data: { deleted: true, entry: entrySummary(entry) } };
  },
});

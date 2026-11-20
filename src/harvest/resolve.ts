import { UserFacingError } from '../core/errors.ts';
import { HarvestApiError } from './client.ts';
import type { HarvestSession } from './session.ts';
import type { HarvestClientRecord, HarvestProject, IdName, ProjectAssignment, TaskAssignment } from './types.ts';

export function normalize(text: string): string {
  return text.toLowerCase().replace(/[‐-―]/g, '-').replace(/\s+/g, ' ').trim();
}

/**
 * Pick exactly one item for what a person typed: an ID, an exact name, or a unique partial
 * match. Anything else is a UserFacingError that lists the candidates, so the model can ask
 * the person or retry with the exact name.
 */
export function pickOne<T>(
  items: readonly T[],
  query: string,
  options: { kind: string; id: (item: T) => number; names: (item: T) => string[]; label: (item: T) => string },
): T {
  const q = normalize(query.replace(/^#/, ''));
  if (!q) throw new UserFacingError(`Give a ${options.kind} name or ID.`);

  if (/^\d+$/.test(q)) {
    const byId = items.find((item) => options.id(item) === Number(q));
    if (byId) return byId;
  }

  const exact = items.filter((item) => options.names(item).some((name) => normalize(name) === q));
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) throw ambiguous(query, exact, options);

  const words = q.split(' ');
  const partial = items.filter((item) =>
    options.names(item).some((name) => {
      const n = normalize(name);
      return words.every((word) => n.includes(word));
    }),
  );
  if (partial.length === 1) return partial[0]!;
  if (partial.length > 1) throw ambiguous(query, partial, options);

  const available = items.slice(0, 15).map(options.label).join('; ');
  const more = items.length > 15 ? ` …and ${items.length - 15} more` : '';
  throw new UserFacingError(
    items.length
      ? `No ${options.kind} matches "${query}". Available: ${available}${more}.`
      : `No ${options.kind}s are available to this Harvest user.`,
  );
}

function ambiguous<T>(query: string, matches: T[], options: { kind: string; label: (item: T) => string }) {
  const list = matches.slice(0, 10).map(options.label).join('; ');
  return new UserFacingError(`"${query}" matches more than one ${options.kind}: ${list}. Use the exact name or the ID.`);
}

const projectLabel = (a: ProjectAssignment) => `${a.client.name} / ${a.project.name} (ID ${a.project.id})`;

export function pickProject(assignments: readonly ProjectAssignment[], query: string): ProjectAssignment {
  return pickOne(assignments, query, {
    kind: 'project',
    id: (a) => a.project.id,
    names: (a) => [
      a.project.name,
      ...(a.project.code ? [a.project.code] : []),
      `${a.client.name} / ${a.project.name}`,
      `${a.client.name} ${a.project.name}`,
    ],
    label: projectLabel,
  });
}

export function pickTask(assignment: ProjectAssignment, query: string | undefined): TaskAssignment {
  const tasks = assignment.task_assignments.filter((t) => t.is_active);
  if (!query) {
    if (tasks.length === 1) return tasks[0]!;
    const list = tasks.map((t) => `${t.task.name} (ID ${t.task.id})`).join('; ');
    throw new UserFacingError(
      tasks.length
        ? `Project "${assignment.project.name}" has several tasks; say which one: ${list}.`
        : `Project "${assignment.project.name}" has no active tasks you can log time to.`,
    );
  }
  return pickOne(tasks, query, {
    kind: `task in "${assignment.project.name}"`,
    id: (t) => t.task.id,
    names: (t) => [t.task.name],
    label: (t) => `${t.task.name} (ID ${t.task.id})`,
  });
}

/** Resolve project + task from what the person typed, against their own assignments. */
export async function resolveProjectTask(
  session: HarvestSession,
  projectQuery: string,
  taskQuery?: string,
): Promise<{ assignment: ProjectAssignment; task: TaskAssignment }> {
  const assignments = await session.assignments();
  const assignment = pickProject(assignments, projectQuery);
  return { assignment, task: pickTask(assignment, taskQuery) };
}

/**
 * Clients the person can see. Admins and managers get the full client list; everyone else
 * sees the clients of their own projects.
 */
export async function visibleClients(session: HarvestSession): Promise<IdName[]> {
  if (session.isManager) {
    try {
      const result = await session.client.list<HarvestClientRecord>('/clients', 'clients', { is_active: true });
      return result.items.map(({ id, name }) => ({ id, name }));
    } catch (error) {
      if (!(error instanceof HarvestApiError && error.status === 403)) throw error;
    }
  }
  const seen = new Map<number, IdName>();
  for (const assignment of await session.assignments()) seen.set(assignment.client.id, assignment.client);
  return [...seen.values()];
}

export async function resolveClient(session: HarvestSession, query: string): Promise<IdName> {
  return pickOne(await visibleClients(session), query, {
    kind: 'client',
    id: (c) => c.id,
    names: (c) => [c.name],
    label: (c) => `${c.name} (ID ${c.id})`,
  });
}

/** A client's active projects (admins/managers via /projects, otherwise from assignments). */
export async function clientProjects(session: HarvestSession, clientId: number): Promise<IdName[]> {
  try {
    const result = await session.client.list<HarvestProject>('/projects', 'projects', {
      client_id: clientId,
      is_active: true,
    });
    return result.items.map(({ id, name }) => ({ id, name }));
  } catch (error) {
    if (!(error instanceof HarvestApiError && error.status === 403)) throw error;
  }
  return (await session.assignments()).filter((a) => a.client.id === clientId).map((a) => a.project);
}

import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { UserFacingError } from '../../core/errors.ts';
import { HarvestApiError } from '../client.ts';
import { PERIODS, resolveRange, type Period } from '../dates.ts';
import { pickOne } from '../resolve.ts';
import type { HarvestSession } from '../session.ts';
import type { HarvestProject, IdName, ProjectAssignment } from '../types.ts';

export const dateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format');

/** The date-range inputs shared by list and report tools. */
export const rangeFields = {
  period: z
    .enum(PERIODS)
    .optional()
    .describe('A named date range in your Harvest time zone. Ignored when from or to is given.'),
  from: dateField.optional().describe('First day to include, YYYY-MM-DD.'),
  to: dateField.optional().describe('Last day to include, YYYY-MM-DD.'),
};

export interface RangeInput {
  period?: Period | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

export function hasRange(input: RangeInput): boolean {
  return Boolean(input.period || input.from || input.to);
}

export async function rangeFor(session: HarvestSession, input: RangeInput, fallback: Period) {
  const [today, weekStart] = await Promise.all([session.today(), session.weekStart()]);
  return resolveRange(input, today, weekStart, fallback);
}

/**
 * Find a project by name, code or ID: first among the person's own assignments, then (for
 * administrators and managers) among every project in the account.
 */
export async function resolveAnyProject(session: HarvestSession, query: string): Promise<IdName & { client: IdName }> {
  const assignments = await session.assignments();
  const options = {
    kind: 'project',
    id: (a: ProjectAssignment) => a.project.id,
    names: (a: ProjectAssignment) => [a.project.name, ...(a.project.code ? [a.project.code] : []), `${a.client.name} / ${a.project.name}`],
    label: (a: ProjectAssignment) => `${a.client.name} / ${a.project.name} (ID ${a.project.id})`,
  };
  try {
    const assignment = pickOne(assignments, query, options);
    return { ...assignment.project, client: assignment.client };
  } catch (error) {
    if (!(error instanceof UserFacingError) || !session.isManager) throw error;
    const all = await session.client.list<HarvestProject>('/projects', 'projects', {});
    return pickOne(all.items, query, {
      kind: 'project',
      id: (p) => p.id,
      names: (p) => [p.name, ...(p.code ? [p.code] : []), `${p.client.name} / ${p.name}`],
      label: (p) => `${p.client.name} / ${p.name} (ID ${p.id})`,
    });
  }
}

const RECONNECT = 'Reconnect the Harvest connector in your AI app’s connector settings to continue.';

/** Turn any error into a tool result the model can act on. Never leaks tokens or stack traces. */
export function makeErrorResult(resourceMetadataUrl: string) {
  return (error: unknown): CallToolResult => {
    const result = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true });

    if (error instanceof UserFacingError) return result(error.message);
    if (error instanceof HarvestApiError) {
      if (error.status === 401) {
        return {
          ...result(`Harvest no longer accepts the saved token (it may have been deleted or expired). ${RECONNECT}`),
          // Lets ChatGPT offer its "reconnect" button for this tool error.
          _meta: {
            'mcp/www_authenticate': [
              `Bearer resource_metadata="${resourceMetadataUrl}", error="invalid_token", error_description="The Harvest token was rejected; reconnect Harvest."`,
            ],
          },
        };
      }
      if (error.status === 403) {
        return result(
          `Harvest says your role doesn't allow this (${error.message}). Reports, invoices and teammates' time usually need Administrator or Manager permissions.`,
        );
      }
      if (error.status === 404) return result('Harvest could not find that record. It may have been deleted, or belong to someone else.');
      if (error.status === 422) return result(`Harvest could not save this: ${error.message}`);
      if (error.status === 429) {
        return result(`Harvest is limiting requests right now. Try again in about ${error.retryAfterSeconds ?? 15} seconds.`);
      }
      if (error.status === 0) return result(`${error.message} Try again in a moment.`);
      return result(`Harvest had a problem (HTTP ${error.status}). Try again in a moment.`);
    }
    console.error('[tool] unexpected error', error instanceof Error ? `${error.name}: ${error.message}` : error);
    return result('Something unexpected went wrong in the Harvest connector. Try again in a moment.');
  };
}

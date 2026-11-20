import { McpServer } from '@modelcontextprotocol/server';
import type { McpRequestState } from '../core/mcp.ts';
import { registerTools } from '../core/tools.ts';
import { publicBaseUrl } from '../env.ts';
import { HarvestClient, harvestEndpoints, userAgent } from './client.ts';
import { HarvestSession, SCOPE_WRITE, type HarvestProps } from './session.ts';
import { createInvoiceDraft } from './tools/invoice.ts';
import { getHarvestProfile, getRunningTimer, listProjects, listTimeEntries } from './tools/read.ts';
import { listInvoices, timeReport, uninvoicedReport } from './tools/reports.ts';
import { makeErrorResult } from './tools/shared.ts';
import { deleteTimeEntry, logTime, startTimer, stopTimer, updateTimeEntry } from './tools/write.ts';

export const SERVER_VERSION = '1.0.0';

export const READ_TOOLS = [getHarvestProfile, listProjects, listTimeEntries, getRunningTimer, timeReport, uninvoicedReport, listInvoices];
export const WRITE_TOOLS = [logTime, startTimer, stopTimer, updateTimeEntry, deleteTimeEntry, createInvoiceDraft];

const INSTRUCTIONS = [
  'Harvest time tracking and invoicing for one connected Harvest account.',
  "Dates are YYYY-MM-DD in the person's Harvest time zone; get_harvest_profile reports today's date there.",
  'Projects, tasks and clients can be named or given by ID; list_projects shows what time can be logged to.',
  'create_invoice_draft only creates drafts. Nothing here sends invoices or emails.',
].join(' ');

export interface ServerDeps {
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  now?: () => Date;
}

/** One MCP server per request, scoped to the grant's Harvest account and permissions. */
export function buildHarvestServer(state: McpRequestState<HarvestProps>, deps: ServerDeps = {}): McpServer {
  const { props, scopes, env, request } = state;
  const client = new HarvestClient({
    token: props.token,
    accountId: props.accountId,
    endpoints: harvestEndpoints(env, request),
    userAgent: userAgent(env),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  const canWrite = scopes.includes(SCOPE_WRITE);
  const session = new HarvestSession(client, props, canWrite, deps.now);

  const server = new McpServer(
    { name: 'harvest-connector', title: 'Harvest (unofficial)', version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );
  const resourceMetadataUrl = `${publicBaseUrl(env, request)}/.well-known/oauth-protected-resource/mcp`;
  registerTools(server, canWrite ? [...READ_TOOLS, ...WRITE_TOOLS] : READ_TOOLS, session, makeErrorResult(resourceMetadataUrl));
  return server;
}

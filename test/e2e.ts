/**
 * End-to-end test: runs the real Worker in `wrangler dev` (workerd, local KV) against a fake
 * Harvest server, and drives it exactly like Claude or ChatGPT would:
 *
 *   discovery (401 → protected resource metadata → authorization server metadata)
 *   → dynamic client registration → consent page → wrong token → right token
 *   → code exchange with PKCE → MCP over the 2026 protocol and over 2025-era JSON-RPC
 *   → refresh token → deny → read-only connection → public pages.
 *
 * Run: npm run test:e2e
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startWorker, stopWorker, waitForWorker } from './dev-stack.ts';
import { FAKE_TOKEN } from './fake-harvest.ts';
import { startFakeHarvestServer } from './fake-harvest-server.ts';

const WORKER_PORT = 8787;
const FAKE_PORT = 8790;
const BASE = `http://127.0.0.1:${WORKER_PORT}`;
const MCP_URL = `${BASE}/mcp`;
const REDIRECT = 'http://127.0.0.1:9876/callback';

let failures = 0;
let passes = 0;
function check(condition: unknown, message: string, detail?: unknown): void {
  if (condition) {
    passes++;
    console.log(`  ✓ ${message}`);
  } else {
    failures++;
    console.log(`  ✗ ${message}${detail === undefined ? '' : `\n      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  }
}
function step(title: string): void {
  console.log(`\n${title}`);
}

const b64url = (buf: Buffer) => buf.toString('base64url');

interface Registered {
  client_id: string;
}

async function register(name: string): Promise<Registered> {
  const res = await fetch(`${BASE}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  return (await res.json()) as Registered;
}

/** Open the consent page; returns the page, its cookie, the form handle and the URL to post to. */
async function openConsent(clientId: string, scope: string) {
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(12));
  const url = new URL(`${BASE}/authorize`);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: MCP_URL,
  }).toString();
  const res = await fetch(url, { redirect: 'manual' });
  const html = await res.text();
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const handle = html.match(/name="handle" value="([^"]+)"/)?.[1] ?? '';
  return { res, html, cookie, handle, url: url.toString(), verifier, state };
}

async function submitConsent(
  consent: { url: string; cookie: string; handle: string },
  fields: Record<string, string | string[]>,
): Promise<Response> {
  const form = new URLSearchParams();
  form.set('handle', consent.handle);
  for (const [k, v] of Object.entries(fields)) for (const value of [v].flat()) form.append(k, value);
  return fetch(consent.url, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: consent.cookie },
    body: form,
  });
}

async function exchangeCode(clientId: string, code: string, verifier: string) {
  const res = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
      resource: MCP_URL,
    }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function mcpClient(accessToken: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: 'e2e-modern', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

/** A 2025-era client speaking plain JSON-RPC over Streamable HTTP, like many hosts still do. */
async function legacyRpc(accessToken: string, protocolVersion: string, id: number, method: string, params: unknown) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (method !== 'initialize') headers['MCP-Protocol-Version'] = protocolVersion;
  const res = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  const text = await res.text();
  const payload = res.headers.get('content-type')?.includes('text/event-stream')
    ? text
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => JSON.parse(line.slice(5)))
        .find((msg) => msg.id === id)
    : text
      ? JSON.parse(text)
      : undefined;
  return { status: res.status, payload };
}

async function main(): Promise<void> {
  const stateDir = mkdtempSync(join(tmpdir(), 'harvest-e2e-'));
  const harvest = await startFakeHarvestServer(FAKE_PORT);
  const worker = startWorker({
    port: WORKER_PORT,
    fakeHarvestPort: FAKE_PORT,
    stateDir,
    supportEmail: 'e2e@example.com',
    verbose: Boolean(process.env['E2E_VERBOSE']),
  });
  try {
    step('Starting wrangler dev…');
    await waitForWorker(BASE);
    check(true, 'worker is up');

    step('Discovery');
    const unauth = await fetch(MCP_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const challenge = unauth.headers.get('www-authenticate') ?? '';
    check(unauth.status === 401, 'unauthenticated /mcp answers 401', unauth.status);
    check(challenge.includes(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`), 'challenge points at protected resource metadata', challenge);
    check(challenge.includes('scope="harvest:read"'), 'challenge names the baseline scope', challenge);

    const prm = (await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, any>;
    check(prm['resource'] === MCP_URL, 'resource equals the MCP URL exactly (Claude requirement)', prm);
    check(prm['authorization_servers']?.[0] === BASE, 'names this server as the authorization server', prm);

    const asm = (await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json()) as Record<string, any>;
    check(asm['code_challenge_methods_supported']?.includes('S256'), 'advertises PKCE S256', asm['code_challenge_methods_supported']);
    check(typeof asm['registration_endpoint'] === 'string', 'advertises dynamic client registration', asm['registration_endpoint']);
    check(asm['authorization_response_iss_parameter_supported'] === true, 'advertises iss in authorization responses (ChatGPT)', asm);
    check(asm['token_endpoint_auth_methods_supported']?.includes('none'), 'supports public clients', asm['token_endpoint_auth_methods_supported']);
    console.log(`  · client_id_metadata_document_supported = ${asm['client_id_metadata_document_supported']}`);

    step('Registration and consent');
    const app = await register('E2E Assistant');
    check(Boolean(app.client_id), 'dynamic registration returns a client_id', app);

    let consent = await openConsent(app.client_id, 'harvest:read offline_access');
    check(consent.res.status === 200, 'consent page loads', consent.res.status);
    check(consent.html.includes('Connect Harvest to E2E Assistant'), 'page names the requesting app');
    check(consent.html.includes('127.0.0.1'), 'page shows where access will be sent');
    check(consent.html.includes('Access will go to an app on this computer'), 'page warns about a local redirect');
    check(consent.res.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"), 'page cannot be framed');
    check(Boolean(consent.handle) && Boolean(consent.cookie), 'page carries a one-time handle bound to a cookie');

    const wrong = await submitConsent(consent, { decision: 'approve', token: 'not-a-real-token', scope: 'harvest:write' });
    const wrongHtml = await wrong.text();
    check(wrong.status === 400 && wrongHtml.includes('Harvest did not accept that token'), 'a wrong token re-shows the form with an error', wrong.status);
    check(!wrongHtml.includes('not-a-real-token'), 'the submitted token is never echoed back');

    harvest.fake.secondHarvestAccount = true;
    const multi = await submitConsent(consent, { decision: 'approve', token: FAKE_TOKEN, scope: 'harvest:write' });
    const multiHtml = await multi.text();
    check(multi.status === 400 && multiHtml.includes('can open 2 Harvest accounts'), 'a multi-account token asks which account', multiHtml.match(/alert error[^<]*>([^<]*)/)?.[1]);

    const ok = await submitConsent(consent, { decision: 'approve', token: FAKE_TOKEN, account_id: '424242', scope: 'harvest:write' });
    const location = new URL(ok.headers.get('location') ?? 'http://invalid/');
    check(ok.status === 302 && location.origin + location.pathname === REDIRECT, 'approving redirects back to the app', { status: ok.status, location: location.toString() });
    check(location.searchParams.get('state') === consent.state, 'state is returned unchanged');
    check(location.searchParams.get('iss') === BASE, 'iss is included (RFC 9207)', location.searchParams.get('iss'));
    const code = location.searchParams.get('code') ?? '';
    check(code.length > 10, 'an authorization code is issued');

    const replay = await submitConsent(consent, { decision: 'approve', token: FAKE_TOKEN, account_id: '424242' });
    check(replay.status === 400, 'the consent handle cannot be reused', replay.status);

    step('Token exchange');
    const badPkce = await exchangeCode(app.client_id, code, 'wrong-verifier-wrong-verifier-wrong-verifier-12345');
    check(badPkce.status === 400, 'a wrong PKCE verifier is rejected', badPkce);
    // The failed attempt above may burn the code (OAuth 2.1 allows single use), so get a fresh one.
    consent = await openConsent(app.client_id, 'harvest:read offline_access');
    const ok2 = await submitConsent(consent, { decision: 'approve', token: FAKE_TOKEN, account_id: '424242', scope: 'harvest:write' });
    const code2 = new URL(ok2.headers.get('location') ?? 'http://invalid/').searchParams.get('code') ?? '';
    const tokens = await exchangeCode(app.client_id, code2, consent.verifier);
    check(tokens.status === 200 && typeof tokens.body['access_token'] === 'string', 'code + verifier give an access token', tokens);
    check(typeof tokens.body['refresh_token'] === 'string', 'a refresh token is issued');
    const granted = String(tokens.body['scope'] ?? '').split(' ');
    check(granted.includes('harvest:read') && granted.includes('harvest:write'), 'granted scopes include read and write', tokens.body['scope']);
    const access = tokens.body['access_token'] as string;

    step('MCP, 2026 protocol (SDK v2 client)');
    const client = await mcpClient(access);
    const { tools } = await client.listTools();
    check(tools.length === 13, 'lists 13 tools', tools.map((t) => t.name));
    const entries = await client.callTool({ name: 'list_time_entries', arguments: { period: 'this_week' } });
    const entriesText = (entries.content as { text: string }[])[0]?.text ?? '';
    check(!entries.isError && entriesText.includes('time entr'), 'list_time_entries works through the Worker', entriesText.slice(0, 200));
    const logged = await client.callTool({ name: 'log_time', arguments: { project: 'Website Redesign', task: 'Development', hours: 0.5, notes: 'E2E check' } });
    check(!logged.isError, 'log_time works through the Worker', (logged.content as { text: string }[])[0]?.text);
    const post = harvest.fake.requests.find((r) => r.method === 'POST' && r.path === '/v2/time_entries');
    check(post?.headers.userAgent?.includes('e2e@example.com'), 'Harvest receives the configured User-Agent', post?.headers);
    check(post?.headers.authorization === `Bearer ${FAKE_TOKEN}`, 'Harvest receives the stored token (decrypted only per request)');
    await client.close();

    step('MCP, 2025-era JSON-RPC clients');
    for (const version of ['2025-06-18', '2025-11-25']) {
      const init = await legacyRpc(access, version, 1, 'initialize', {
        protocolVersion: version,
        capabilities: {},
        clientInfo: { name: 'legacy-client', version: '1.0.0' },
      });
      check(init.status === 200 && init.payload?.result?.serverInfo?.name === 'harvest-connector', `initialize (${version})`, init);
      const list = await legacyRpc(access, version, 2, 'tools/list', {});
      check(list.payload?.result?.tools?.length === 13, `tools/list (${version})`, list.payload?.error ?? list.status);
      const called = await legacyRpc(access, version, 3, 'tools/call', { name: 'get_harvest_profile', arguments: {} });
      check(called.payload?.result?.content?.[0]?.text?.includes('Acme Studio'), `tools/call (${version})`, called.payload?.error ?? called.status);
    }

    step('Refresh');
    const refreshed = await fetch(`${BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.body['refresh_token'], client_id: app.client_id }),
    });
    const refreshedBody = (await refreshed.json()) as Record<string, any>;
    check(refreshed.status === 200 && refreshedBody['access_token'] && refreshedBody['access_token'] !== access, 'refresh gives a new access token', refreshedBody);
    check(refreshedBody['refresh_token'] && refreshedBody['refresh_token'] !== tokens.body['refresh_token'], 'refresh tokens rotate');
    const afterRefresh = await mcpClient(refreshedBody['access_token']);
    check((await afterRefresh.listTools()).tools.length === 13, 'the refreshed token works');
    await afterRefresh.close();

    step('Deny and read-only');
    const denyConsent = await openConsent(app.client_id, 'harvest:read');
    const denied = await submitConsent(denyConsent, { decision: 'deny' });
    const deniedTo = new URL(denied.headers.get('location') ?? 'http://invalid/');
    check(denied.status === 302 && deniedTo.searchParams.get('error') === 'access_denied', 'Cancel returns access_denied to the app', deniedTo.toString());

    const readOnlyApp = await register('Read Only Assistant');
    const ro = await openConsent(readOnlyApp.client_id, 'harvest:read');
    const roOk = await submitConsent(ro, { decision: 'approve', token: FAKE_TOKEN, account_id: '424242' });
    const roCode = new URL(roOk.headers.get('location') ?? 'http://invalid/').searchParams.get('code') ?? '';
    const roTokens = await exchangeCode(readOnlyApp.client_id, roCode, ro.verifier);
    check(roTokens.body['scope'] === 'harvest:read', 'unticking write grants read only', roTokens.body['scope']);
    const roClient = await mcpClient(roTokens.body['access_token']);
    const roTools = (await roClient.listTools()).tools;
    check(roTools.length === 7 && roTools.every((t) => t.annotations?.readOnlyHint), 'a read-only connection sees only the 7 read tools', roTools.map((t) => t.name));
    await roClient.close();

    step('Bad tokens');
    const forged = await fetch(MCP_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer abc:def:ghi', 'Content-Type': 'application/json' },
      body: '{}',
    });
    check(forged.status === 401, 'a forged token is rejected', forged.status);

    step('Public pages');
    const home = await fetch(`${BASE}/`);
    check(home.status === 200 && (await home.text()).includes(MCP_URL), 'home page shows the connector URL');
    const privacy = await fetch(`${BASE}/privacy`);
    check(privacy.status === 200 && (await privacy.text()).includes('What we store'), 'privacy policy is served');
    const icon = await fetch(`${BASE}/icon.svg`);
    check(icon.status === 200 && icon.headers.get('content-type')?.includes('svg'), 'icon is served');

    step('CORS (browser-based MCP clients)');
    const preflight = await fetch(MCP_URL, {
      method: 'OPTIONS',
      headers: { Origin: 'https://inspector.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type' },
    });
    console.log(`  · OPTIONS /mcp → ${preflight.status}, allow-origin: ${preflight.headers.get('access-control-allow-origin')}, allow-headers: ${preflight.headers.get('access-control-allow-headers')}`);
  } finally {
    stopWorker(worker);
    await harvest.close();
    rmSync(stateDir, { recursive: true, force: true });
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

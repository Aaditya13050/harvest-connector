import {
  AuthorizationError,
  CimdFetchError,
  type AuthRequest,
  type ConsentDescription,
} from '@cloudflare/workers-oauth-provider';
import type { AppEnv } from '../env.ts';
import { ConnectError } from './errors.ts';
import { escapeHtml, htmlPage, htmlResponse } from './html.ts';

/** One permission the person can grant on the consent page. */
export interface ScopeOption {
  scope: string;
  /** Plain-language description, e.g. "See your projects and tracked time". */
  label: string;
  /** Always granted; shown checked and disabled. */
  required?: boolean;
  /** Pre-ticked when the page first opens. */
  defaultChecked?: boolean;
}

/** What a connector returns once the person's upstream credentials check out. */
export interface ConnectResult<Props> {
  /** Stored encrypted with the grant and handed to every MCP request as `ctx.props`. */
  props: Props;
  /** Stable, non-secret ID for this person+account. Must not contain ':'. */
  userId: string;
}

/** The parts of the consent page that differ per connector. */
export interface ConnectorAuth<Props> {
  /** Upstream product name, e.g. "Harvest". */
  productName: string;
  scopes: ScopeOption[];
  /** Form fields name → value that are safe to echo back after an error (never secrets). */
  echoFields: readonly string[];
  /** What to have ready before connecting, e.g. "Copy your token first". Shown on the page. */
  readyTip?: string;
  /** HTML for the credential fields. `values` holds the echoed fields; escape them. */
  renderFields(values: Record<string, string>, options: { showAdvanced: boolean }): string;
  /** Check the submitted credentials upstream. Throw ConnectError for anything the person can fix. */
  connect(form: FormData, env: AppEnv, request: Request): Promise<ConnectResult<Props>>;
}

const OFFLINE_ACCESS = 'offline_access';

/**
 * The OAuth `/authorize` endpoint: shows who is asking and where access will go, collects the
 * upstream credentials, then completes the authorization. The form posts back to the same URL,
 * so the OAuth request can be re-read from its query string and the page re-rendered with an
 * error without consuming the one-time consent handle.
 */
export async function handleAuthorize<Props>(
  request: Request,
  env: AppEnv,
  connector: ConnectorAuth<Props>,
): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (request.method === 'GET') {
      const authRequest = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      const nonce = newNonce();
      const page = renderConsentPage(connector, details, consent.handle, {
        values: {},
        checkedScopes: defaultScopes(connector),
        nonce,
      });
      return htmlResponse(page, { headers: consent.headers, scriptNonce: nonce });
    }

    if (request.method === 'POST') {
      const form = await request.formData();
      const handle = String(form.get('handle') ?? '');

      if (form.get('decision') !== 'approve') {
        let denied;
        try {
          denied = await oauth.denyConsent(request, handle);
        } catch (error) {
          if (error instanceof AuthorizationError) return expiredPage(connector, error, request);
          throw error;
        }
        denied.headers.set('Location', denied.redirectTo);
        return new Response(null, { status: 302, headers: denied.headers });
      }

      const authRequest = await oauth.parseAuthRequest(request);
      const checkedScopes = chosenScopes(form, connector);

      let connected: ConnectResult<Props>;
      try {
        connected = await connector.connect(form, env, request);
      } catch (error) {
        if (!(error instanceof ConnectError)) throw error;
        // The handle is still unused, so the person can fix the problem and submit again.
        const details = await oauth.describeConsent(authRequest);
        const values: Record<string, string> = {};
        for (const field of connector.echoFields) values[field] = String(form.get(field) ?? '');
        const nonce = newNonce();
        const page = renderConsentPage(connector, details, handle, {
          values,
          checkedScopes,
          error: error.message,
          showAdvanced: error.options.showAdvanced ?? false,
          nonce,
        });
        return htmlResponse(page, { status: 400, scriptNonce: nonce });
      }

      const granted = withOfflineAccess(checkedScopes, authRequest);
      let approved;
      try {
        approved = await oauth.approveConsent(request, handle, { scope: granted });
      } catch (error) {
        // The library binds each page to the browser with a 10-minute cookie. Once it lapses the
        // error reads "not started in this browser", which is confusing: say it expired instead.
        if (error instanceof AuthorizationError) return expiredPage(connector, error, request);
        throw error;
      }
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId: connected.userId,
        metadata: {},
        scope: granted,
        props: connected.props,
      });
      approved.headers.set('Location', redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    }

    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, POST' } });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) {
      return Response.redirect(error.redirectTo, 302);
    }
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      const message =
        error instanceof AuthorizationError
          ? error.description
          : 'The app asking for access could not be verified.';
      return htmlResponse(
        htmlPage(
          'Could not connect',
          `<h1>Could not connect ${escapeHtml(connector.productName)}</h1>
<div class="alert error" role="alert">${escapeHtml(message)}</div>
<p class="muted">Go back to the app you were connecting from and start again.</p>`,
        ),
        { status: 400 },
      );
    }
    throw error;
  }
}

/** Shown when a consent page has lapsed (10 minutes), was already used, or came from another browser. */
function expiredPage(connector: ConnectorAuth<unknown>, error: AuthorizationError, request: Request): Response {
  // Diagnostics only: which check failed and which consent cookies arrived (names, never values).
  const cookieNames = (request.headers.get('Cookie') ?? '')
    .split(';')
    .map((part) => part.trim().split('=')[0])
    .filter((name) => name?.startsWith('__Host-oauth-'));
  console.warn(
    `[consent] rejected: ${error.description} | consent cookies sent: ${cookieNames.length ? cookieNames.join(', ') : 'none'} | sec-fetch-site: ${request.headers.get('Sec-Fetch-Site') ?? '-'}`,
  );
  const product = escapeHtml(connector.productName);
  return htmlResponse(
    htmlPage(
      'This page has expired',
      `<h1>This connect page has expired</h1>
<div class="alert warn" role="alert">Connect pages work for 10 minutes, and this one has expired or was already used.</div>
<p><strong>Clicked Connect twice?</strong> The first click has probably already connected you. Check the app's connector settings.</p>
<p>Otherwise, go back to the app you were connecting from and click <strong>Connect</strong> again.</p>
${connector.readyTip ? `<p class="muted">Tip: ${escapeHtml(connector.readyTip)}</p>` : ''}
<p class="fine">Nothing was changed in your ${product} account.</p>`,
    ),
    { status: 400 },
  );
}

function defaultScopes(connector: ConnectorAuth<unknown>): string[] {
  return connector.scopes.filter((s) => s.required || s.defaultChecked).map((s) => s.scope);
}

/** Scopes the person ticked, always including the required ones and nothing unknown. */
function chosenScopes(form: FormData, connector: ConnectorAuth<unknown>): string[] {
  const ticked = new Set(form.getAll('scope').map(String));
  return connector.scopes.filter((s) => s.required || ticked.has(s.scope)).map((s) => s.scope);
}

/** Keep refresh tokens working for clients that asked for them (Claude adds offline_access). */
function withOfflineAccess(scopes: string[], authRequest: AuthRequest): string[] {
  return authRequest.scope.includes(OFFLINE_ACCESS) ? [...scopes, OFFLINE_ACCESS] : scopes;
}

function renderConsentPage(
  connector: ConnectorAuth<unknown>,
  details: ConsentDescription,
  handle: string,
  state: { values: Record<string, string>; checkedScopes: string[]; error?: string; showAdvanced?: boolean; nonce: string },
): string {
  const product = escapeHtml(connector.productName);
  const client = escapeHtml(details.clientName);
  const publisher = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : 'This app registered itself, so its name is not verified.';
  const loopbackWarning = details.redirectIsLoopback
    ? `<div class="alert warn" role="note"><strong>Access will go to an app on this computer.</strong>
Only continue if you just started connecting from it.</div>`
    : '';
  const error = state.error ? `<div class="alert error" role="alert">${escapeHtml(state.error)}</div>` : '';
  const scopes = connector.scopes
    .map((option) => {
      const checked = option.required || state.checkedScopes.includes(option.scope);
      // A disabled checkbox is not submitted, so required scopes are always added server-side.
      return `<label class="check"><input type="checkbox" name="scope" value="${escapeHtml(option.scope)}"${
        checked ? ' checked' : ''
      }${option.required ? ' disabled' : ''}> <span>${escapeHtml(option.label)}</span></label>`;
    })
    .join('\n');

  return htmlPage(
    `Connect ${connector.productName}`,
    `<h1>Connect ${product} to ${client}</h1>
<p class="muted">${publisher}</p>
<p>After you connect, access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${loopbackWarning}
${error}
<p class="hint">This page works for 10 minutes.${connector.readyTip ? ` ${escapeHtml(connector.readyTip)}` : ''}</p>
<form method="post" autocomplete="off">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
${connector.renderFields(state.values, { showAdvanced: state.showAdvanced ?? false })}
<fieldset>
<legend>Allow ${client} to</legend>
${scopes}
</fieldset>
<div class="actions">
<button class="primary" type="submit" name="decision" value="approve">Connect ${product}</button>
<button type="submit" name="decision" value="deny" formnovalidate>Cancel</button>
</div>
</form>
<p class="fine">You can disconnect at any time from the app's connector settings, or by deleting the token in ${product}.
<a href="/privacy">Privacy policy</a></p>
<script nonce="${escapeHtml(state.nonce)}">${SUBMIT_ONCE_SCRIPT}</script>`,
  );
}

/**
 * Connecting checks the credentials upstream, which takes a few seconds. Without feedback people
 * click again, and the second post finds the one-time page already used. Show progress and ignore
 * repeat submits (without disabling the button, which would drop its value from the form).
 */
const SUBMIT_ONCE_SCRIPT = `(function () {
  var form = document.querySelector('form');
  if (!form) return;
  form.addEventListener('submit', function (event) {
    if (form.dataset.sent) { event.preventDefault(); return; }
    form.dataset.sent = '1';
    form.setAttribute('aria-busy', 'true');
    var button = event.submitter;
    if (button && button.value === 'approve') button.textContent = 'Connecting\\u2026';
  });
  window.addEventListener('pageshow', function () { delete form.dataset.sent; form.removeAttribute('aria-busy'); });
})();`;

function newNonce(): string {
  return crypto.randomUUID().replaceAll('-', '');
}

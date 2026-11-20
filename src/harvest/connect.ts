import type { ConnectorAuth, ConnectResult } from '../core/consent.ts';
import { ConnectError } from '../core/errors.ts';
import { escapeHtml } from '../core/html.ts';
import type { AppEnv } from '../env.ts';
import { HarvestApiError, HarvestClient, harvestEndpoints, userAgent } from './client.ts';
import { SCOPE_READ, SCOPE_WRITE, type HarvestProps } from './session.ts';
import type { HarvestAccountsResponse, HarvestUser } from './types.ts';

const TOKEN_HELP_URL = 'https://id.getharvest.com/developers';

/**
 * The Harvest connect step: the person pastes a personal access token; we find the Harvest
 * accounts it can reach, check it against the API, and keep it (encrypted) with the grant.
 */
export const harvestAuth: ConnectorAuth<HarvestProps> = {
  productName: 'Harvest',
  scopes: [
    { scope: SCOPE_READ, label: 'See your projects, tracked time, reports and invoices', required: true },
    {
      scope: SCOPE_WRITE,
      label: 'Log and edit time, start and stop timers, and create draft invoices (never sent)',
      defaultChecked: true,
    },
  ],
  echoFields: ['account_id'],

  renderFields(values, { showAdvanced }) {
    return `<label for="token">Harvest personal access token</label>
<input id="token" name="token" type="password" required autocomplete="off" spellcheck="false" autocapitalize="off">
<p class="hint">Create one at <a href="${TOKEN_HELP_URL}" target="_blank" rel="noopener noreferrer">id.getharvest.com/developers</a>
→ “Create new personal access token”, then copy the token. It is stored encrypted and only used to talk to Harvest for you.</p>
<details${showAdvanced || values['account_id'] ? ' open' : ''}>
<summary>Use more than one Harvest account?</summary>
<label for="account_id">Account ID</label>
<input id="account_id" name="account_id" type="text" inputmode="numeric" autocomplete="off" value="${escapeHtml(values['account_id'] ?? '')}">
<p class="hint">Only needed if your token can open several Harvest accounts. It's listed under the token on the same page.</p>
</details>`;
  },

  async connect(form, env, request): Promise<ConnectResult<HarvestProps>> {
    const token = String(form.get('token') ?? '').trim();
    const requestedAccount = String(form.get('account_id') ?? '').trim();
    if (!token) throw new ConnectError('Paste your Harvest personal access token.');
    if (token.length > 1024 || /\s/.test(token)) {
      throw new ConnectError("That doesn't look like a Harvest token. Copy the whole token, without spaces.");
    }
    if (requestedAccount && !/^\d+$/.test(requestedAccount)) {
      throw new ConnectError('The Account ID is a number, e.g. 123456.', { showAdvanced: true });
    }

    const endpoints = harvestEndpoints(env, request);
    const agent = userAgent(env);
    const idClient = new HarvestClient({ token, endpoints, userAgent: agent, maxRetries: 1 });

    let accounts: HarvestAccountsResponse;
    try {
      accounts = await idClient.getId<HarvestAccountsResponse>('/api/v2/accounts');
    } catch (error) {
      throw connectFailure(error);
    }

    const harvestAccounts = (accounts.accounts ?? []).filter((account) => account.product === 'harvest');
    if (harvestAccounts.length === 0) {
      throw new ConnectError('This token has no Harvest accounts (it may only have Forecast). Create the token while signed in to Harvest.');
    }

    let account = harvestAccounts[0]!;
    if (requestedAccount) {
      const match = harvestAccounts.find((a) => String(a.id) === requestedAccount);
      if (!match) {
        throw new ConnectError(`Account ID ${requestedAccount} isn't available to this token. Its Harvest accounts: ${accountList(harvestAccounts)}.`, {
          showAdvanced: true,
        });
      }
      account = match;
    } else if (harvestAccounts.length > 1) {
      throw new ConnectError(
        `This token can open ${harvestAccounts.length} Harvest accounts: ${accountList(harvestAccounts)}. Enter the Account ID of the one to connect.`,
        { showAdvanced: true },
      );
    }

    const apiClient = new HarvestClient({ token, accountId: String(account.id), endpoints, userAgent: agent, maxRetries: 1 });
    let me: HarvestUser;
    try {
      me = await apiClient.get<HarvestUser>('/users/me');
    } catch (error) {
      throw connectFailure(error);
    }

    const props: HarvestProps = {
      token,
      accountId: String(account.id),
      accountName: account.name,
      userId: me.id,
      userName: `${me.first_name ?? ''} ${me.last_name ?? ''}`.trim() || `User ${me.id}`,
      accessRoles: me.access_roles ?? [],
    };
    if (me.timezone) props.timezone = me.timezone;
    return { props, userId: `harvest-${account.id}-${me.id}` };
  },
};

function accountList(accounts: { id: number; name: string }[]): string {
  return accounts.map((a) => `${a.name} (ID ${a.id})`).join(', ');
}

function connectFailure(error: unknown): ConnectError {
  if (error instanceof HarvestApiError) {
    if (error.status === 401) {
      return new ConnectError('Harvest did not accept that token. Check you copied all of it, or create a new token and try again.');
    }
    if (error.status === 403) return new ConnectError("This token doesn't have access to that Harvest account.", { showAdvanced: true });
    if (error.status === 429) return new ConnectError('Harvest is rate limiting requests right now. Wait a few seconds and try again.');
    if (error.status === 0) return new ConnectError(`${error.message} Try again in a moment.`);
    return new ConnectError(`Harvest returned an error (${error.message}). Try again in a moment.`);
  }
  console.error('[connect] unexpected error', error instanceof Error ? error.message : error);
  return new ConnectError('Something went wrong while checking the token. Try again in a moment.');
}

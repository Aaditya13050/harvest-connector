import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

/**
 * Bindings and variables this Worker reads. `OAUTH_PROVIDER` is injected by the OAuth
 * library into handlers it calls.
 */
export interface AppEnv {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  /** Contact shown on the privacy page and sent to Harvest in the User-Agent header. */
  SUPPORT_EMAIL?: string;
  /** Public URL clients use (no trailing slash). Empty: use the URL each request arrived on. */
  PUBLIC_BASE_URL?: string;
  /**
   * Local testing only: point the connector at a fake Harvest. These are ignored unless the
   * Worker itself is being served from localhost, so a stray value can't redirect production
   * traffic (and users' tokens) elsewhere.
   */
  HARVEST_API_BASE?: string;
  HARVEST_ID_BASE?: string;
}

/** True for hosts that only exist on this machine (wrangler dev). */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
}

/** The base URL this deployment is reached on, without a trailing slash. */
export function publicBaseUrl(env: AppEnv, request: Request): string {
  const configured = env.PUBLIC_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  return new URL(request.url).origin;
}

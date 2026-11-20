import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { handleAuthorize } from './core/consent.ts';
import { createMcpApiHandler } from './core/mcp.ts';
import { publicBaseUrl, type AppEnv } from './env.ts';
import { harvestAuth } from './harvest/connect.ts';
import { homePage, ICON_SVG, privacyPage } from './harvest/pages.ts';
import { buildHarvestServer } from './harvest/server.ts';
import { SCOPE_READ, SCOPE_WRITE, type HarvestProps } from './harvest/session.ts';

const DAY = 24 * 60 * 60;

/** `/mcp`: reached only with a valid access token for this deployment. */
const mcpHandler = createMcpApiHandler<HarvestProps>((state) => buildHarvestServer(state));

/** Everything that isn't OAuth plumbing or `/mcp`: the consent page and public pages. */
const appHandler = {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/authorize':
        return handleAuthorize(request, env, harvestAuth);
      case '/':
        return homePage(env, publicBaseUrl(env, request));
      case '/privacy':
        return privacyPage(env);
      case '/icon.svg':
        return new Response(ICON_SVG, {
          headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' },
        });
      case '/health':
        return Response.json({ ok: true });
      default:
        return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    }
  },
};

/**
 * The OAuth provider is configured with this deployment's public URL (it is the token
 * audience), so build one per base URL and reuse it.
 */
const providers = new Map<string, OAuthProvider<AppEnv>>();

function providerFor(base: string): OAuthProvider<AppEnv> {
  let provider = providers.get(base);
  if (!provider) {
    provider = new OAuthProvider<AppEnv>({
      apiRoute: '/mcp',
      apiHandler: mcpHandler,
      defaultHandler: appHandler,
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/oauth/token',
      // Dynamic Client Registration for clients that don't use Client ID Metadata Documents yet.
      clientRegistrationEndpoint: '/oauth/register',
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: [SCOPE_READ, SCOPE_WRITE, 'offline_access'],
      resourceMetadata: {
        resource: `${base}/mcp`,
        authorization_servers: [base],
        resource_name: 'Harvest connector',
        bearer_methods_supported: ['header'],
      },
      requiredScopes: [SCOPE_READ],
      accessTokenTTL: 60 * 60,
      // Stay connected while in use; a connection unused for 60 days expires.
      refreshTokenTTL: 60 * DAY,
      refreshTokenIdleTTL: 60 * DAY,
      onError: ({ status, code, description }) => {
        console.warn(`[oauth] ${status} ${code}: ${description}`);
      },
    });
    providers.set(base, provider);
  }
  return provider;
}

export default {
  fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    return providerFor(publicBaseUrl(env, request)).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<AppEnv>;

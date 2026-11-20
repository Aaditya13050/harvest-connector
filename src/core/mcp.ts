import type { OAuthResourceAuth } from '@cloudflare/workers-oauth-provider';
import { createMcpHandler, type AuthInfo, type McpServer } from '@modelcontextprotocol/server';
import type { AppEnv } from '../env.ts';

/** Everything a per-request MCP server needs: the decrypted grant props and the token's scopes. */
export interface McpRequestState<Props> {
  props: Props;
  scopes: string[];
  env: AppEnv;
  request: Request;
}

type ProtectedContext<Props> = ExecutionContext & { props: Props; auth: OAuthResourceAuth };

/**
 * The OAuth provider's `apiHandler` for `/mcp`. The provider has already validated the bearer
 * token (audience, expiry) before this runs; we build a fresh, stateless MCP server for each
 * request from the grant's props, so nothing about one user ever lives in shared memory.
 *
 * Serves both the 2026-07-28 protocol and 2025-era clients (stateless fallback).
 */
export function createMcpApiHandler<Props>(build: (state: McpRequestState<Props>) => McpServer) {
  const handler = createMcpHandler(
    (context) => {
      const state = context.authInfo?.extra?.['state'] as McpRequestState<Props> | undefined;
      if (!state) throw new Error('MCP request reached the server without authentication context');
      return build(state);
    },
    {
      onerror: (error) => console.error(`[mcp] ${error.name}: ${error.message}`),
    },
  );

  return {
    async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
      const { auth, props } = ctx as ProtectedContext<Props>;
      const state: McpRequestState<Props> = { props, scopes: auth.scope, env, request };
      const authInfo: AuthInfo = {
        token: auth.token,
        clientId: auth.clientId ?? 'unknown',
        scopes: auth.scope,
        resource: new URL(auth.audience),
        extra: { state },
      };
      if (auth.expiresAt !== undefined) authInfo.expiresAt = auth.expiresAt;
      return handler.fetch(request, { authInfo });
    },
  };
}

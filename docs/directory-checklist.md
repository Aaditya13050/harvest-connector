# Directory listing checklist (Claude and ChatGPT)

What Anthropic's connector directory and OpenAI's app directory asked for when this was built (November 2026),
and where this project stands. Requirements change: re-read the official pages before submitting.

Sources: Claude connector docs (claude.com/docs/connectors/building: review criteria, submission,
authentication, testing) and OpenAI Apps SDK docs (developers.openai.com/apps-sdk: auth, submission guidelines).

## Hosting and sign-in

| Requirement | Status |
|---|---|
| Remote server over HTTPS | ✅ Cloudflare Workers |
| `401` with `WWW-Authenticate: Bearer resource_metadata="…"` | ✅ tested in e2e |
| Protected resource metadata whose `resource` equals the MCP URL exactly (Claude) | ✅ tested |
| Authorization server metadata (RFC 8414) | ✅ |
| PKCE with `S256` advertised | ✅ |
| Dynamic Client Registration (`registration_endpoint`) | ✅ `/oauth/register` |
| Client ID Metadata Documents (ChatGPT's preferred method) | ✅ enabled (`client_id_metadata_document_supported: true`) |
| `iss` in authorization responses (lets ChatGPT use its fixed callback URL) | ✅ |
| Token endpoint accepts form-encoded bodies; refresh tokens rotate; `invalid_grant` for dead refresh tokens | ✅ (library) |
| `resource` parameter accepted and tokens bound to the MCP URL | ✅ |

## Tools

| Requirement | Status |
|---|---|
| Every tool has a title | ✅ enforced by `defineTool()` and a unit test |
| Explicit `readOnlyHint`, `destructiveHint`, `openWorldHint` booleans | ✅ enforced |
| Names unique, verb-first, ≤ 64 characters, no catch-all tools | ✅ |
| Descriptions match behavior and don't instruct the model | ✅ review when adding tools |
| Actionable error messages | ✅ |
| Re-link hint on auth errors (`_meta["mcp/www_authenticate"]`, ChatGPT) | ✅ when Harvest rejects the token |

## Listing details

| Item | Where |
|---|---|
| Privacy policy (data collected, use, sharing, retention, contact) | `/privacy` — set `SUPPORT_EMAIL` first |
| Support contact | `SUPPORT_EMAIL` |
| Documentation URL | this README (publish it, e.g. on GitHub) |
| Icon | `/icon.svg` (a neutral clock, deliberately not Harvest's logo) |
| Name, one-line and long description, categories | write at submission time |
| Test account with sample data for reviewers | create a free Harvest account with sample clients/projects; ChatGPT asks for a login without 2FA |

## Important for an unofficial connector

Claude's directory accepts community submissions (they're listed as Community connectors by default, and
Anthropic may escalate some to a Verified review). Still, using another company's product name in a listing
raises trademark questions, and reviewers may expect the product owner to be involved. Check the current
policy before submitting an independent connector.

For proof of work you don't need a listing: a live demo, a public repo and a short case study are enough.
The strongest listing is the official one you build for a company that hires you, using this same code.

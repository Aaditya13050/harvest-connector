# Harvest connector for Claude and ChatGPT

A remote MCP connector that lets Claude and ChatGPT work with [Harvest](https://www.getharvest.com) time tracking:
read time and reports, log and edit time, run timers, and turn unbilled hours into **draft** invoices — in plain language.

> Independent project. Not made, endorsed or supported by Harvest.

**Live connector:** `https://harvest-connector.aaditya-connectors.workers.dev/mcp`. Add it in Claude
(Settings → Connectors → Add custom connector) or in ChatGPT developer mode, and paste a Harvest personal access
token when asked. Case study: [docs/case-study.md](docs/case-study.md).

It runs on Cloudflare Workers (free tier is enough to start), signs people in with OAuth the way Claude and
ChatGPT expect, and is built as a **template**: the sign-in, consent page, MCP plumbing and tool helpers in
`src/core` are reusable for the next connector.

## What it can do

| Tool | What it does | Safety label |
|---|---|---|
| `get_harvest_profile` | Account, person, role, time zone and today's date there, time-entry mode | read-only |
| `list_projects` | Projects and tasks you can log to, grouped by client, with IDs | read-only |
| `list_time_entries` | Entries for a period (default this week) with totals; filter by project, client, task, invoiced; teammates for admins | read-only |
| `get_running_timer` | The timer that's running, if any | read-only |
| `get_time_report` | Hours by client, project, task or person, with billable amounts | read-only |
| `get_uninvoiced_report` | Tracked but not yet invoiced work, per project | read-only |
| `list_invoices` | Invoices with state, dates, amount and amount due | read-only |
| `log_time` | Add a finished entry (hours like `1.5`, `1:30`, `1h 30m`, or start/end times) | changes data |
| `start_timer` | Start a timer (stops the running one first) | changes data |
| `stop_timer` | Stop the running timer | changes data |
| `update_time_entry` | Change project, task, date, duration or notes; shows before/after | destructive |
| `delete_time_entry` | Delete an entry; without `confirm: true` it only previews | destructive |
| `create_invoice_draft` | Draft invoice from uninvoiced time (and optionally expenses). Never sends it | changes data |

People choose on the consent page whether the AI may make changes. A read-only connection only sees the
seven read-only tools.

Things that make it work well in a conversation:

- Projects, tasks and clients can be named loosely (`"web"`, `"Website Redesign"`, `"Northwind / Website"`) or by ID.
  Unclear names come back with the list of matches instead of a guess.
- "Today" and "this week" use the person's Harvest time zone and week start, not the server's.
- Works with accounts that record durations and with accounts that record start/end times.
- Errors are written for the model to act on (e.g. *"Project "Mobile App" has several tasks; say which one: …"*).
- Harvest rate limits are respected (short `Retry-After` waits, no repeated writes).

## How it fits together

```
Claude / ChatGPT ──OAuth 2.1 (PKCE, DCR or CIMD)──▶  /authorize  (consent page: paste Harvest token)
       │                                                   │ token checked with Harvest, stored encrypted
       └──── MCP over HTTPS, Bearer token ──▶  /mcp ──▶ per-request MCP server ──▶ Harvest API v2
```

- `src/index.ts` — routes: OAuth endpoints (library), `/authorize`, `/mcp`, `/`, `/privacy`, `/icon.svg`.
- `src/core/` — reusable: consent page flow, MCP handler glue, tool definition helper, HTML.
- `src/harvest/` — the Harvest-specific part: API client, connect step, session, tools, pages.
- `test/` — unit tests, a fake Harvest API, an end-to-end test and a demo mode.

Security notes: the Harvest token is only stored inside the OAuth grant, encrypted with a key that only that
connection's tokens can unwrap (`@cloudflare/workers-oauth-provider`); access tokens are stored as hashes; the
consent page shows which app is asking and where access goes, can't be framed, and uses one-time handles.
Test-only Harvest URL overrides are ignored unless the Worker runs on localhost.

## Run it locally

Requirements: Node.js 24+. **On Windows, keep the project in a short folder** (for example `C:\dev\harvest-connector`):
Cloudflare's local runtime (`workerd.exe`) can't start if its full path is longer than 260 characters.

```powershell
npm install
```

```powershell
npm run check
```

`npm run check` runs the type check, 76 unit tests, and the end-to-end test (50 checks: discovery,
registration, consent, PKCE, refresh, deny, read-only, and tool calls over the 2026 and 2025 MCP protocols)
against a fake Harvest account.

### Demo mode (no Harvest account needed)

```powershell
npm run demo
```

Starts the connector at `http://127.0.0.1:8787/mcp` with a sample account (clients *Northwind Traders* and
*Globex Corporation*, projects, a week of time). It prints the fake token to paste on the consent page.
Try it with the MCP Inspector (`npx @modelcontextprotocol/inspector`), or expose it over HTTPS with a tunnel
(`cloudflared tunnel --url http://127.0.0.1:8787`, then set `PUBLIC_BASE_URL` to the tunnel URL) to use it
from Claude or ChatGPT.

## Deploy to Cloudflare

```powershell
npx wrangler login
```

```powershell
npx wrangler kv namespace create OAUTH_KV
```

Put the printed `id` into `wrangler.jsonc`, then set your contact email. It appears on the privacy page and in
the User-Agent sent to Harvest, and is kept out of the code:

```powershell
npx wrangler secret put SUPPORT_EMAIL
```

Then deploy:

```powershell
npm run deploy
```

Your connector URL is `https://harvest-connector.<your-subdomain>.workers.dev/mcp`. Opening the base URL
shows a page with that URL. For a custom domain, add it in Cloudflare and set `PUBLIC_BASE_URL`.

## Connect it

1. In Harvest, create a personal access token at <https://id.getharvest.com/developers>.
2. **Claude:** add a custom connector with your `/mcp` URL (Settings → Connectors). **ChatGPT:** add it as an
   app/connector in developer mode. Both open the consent page.
3. Paste the token, choose whether changes are allowed, and click **Connect Harvest**.

Then ask things like:

- "What did I work on this week?"
- "Log 1.5 hours on Website Redesign, development: code review."
- "Start a timer on Mobile App." … "Stop my timer."
- "How much unbilled work do we have for Northwind?"
- "Create a draft invoice for Northwind for last month, grouped by task."

## Before you show it to anyone

All automated tests run against a fake Harvest built from Harvest's public API documentation. Before a demo
or a sale, run through the prompts above once with a real (free) Harvest account, and check:

- [ ] Logging, editing and deleting time match what Harvest's own UI shows.
- [ ] Starting a timer while another runs behaves as expected.
- [ ] A draft invoice's lines and totals match Harvest's invoice screen.
- [ ] Reports and the uninvoiced report match Harvest's Reports pages.

## Directory listing checklist

See [docs/directory-checklist.md](docs/directory-checklist.md) for what Claude's and ChatGPT's directories
require and where this project already meets it.

## Make your next connector from this template

1. Copy the project. Keep `src/core/` as it is.
2. Replace `src/harvest/` with the new product:
   - `client.ts`: its API (auth headers, pagination, errors, retries).
   - `connect.ts`: what the consent page asks for (API key, subdomain…) and how to verify it.
   - `tools/*.ts`: tools built with `defineTool()`. It enforces names, titles and safety labels.
   - `server.ts`: which tools exist for read-only and read-write connections, and the server instructions.
   - `pages.ts`: home page, privacy policy, icon.
3. Update scopes and names in `src/index.ts`.
4. Write a fake API in `test/` and reuse the test patterns: tools are tested through the real MCP handler.

For products with their own OAuth ("Sign in with X" instead of pasting a key), the OAuth library's
`beginUpstream()` / `finishUpstream()` helpers handle the redirect safely. Harvest supports this too, and it's
the natural next upgrade for this connector.

## Limits and next steps

- Uses personal access tokens. A Harvest OAuth app would give one-click sign-in.
- No expense, timesheet-approval or project-creation tools yet.
- Invoices are only ever drafted; sending stays in Harvest on purpose.

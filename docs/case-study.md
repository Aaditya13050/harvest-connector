# Case study: a Harvest connector for Claude and ChatGPT

## The problem

Freelancers and agencies track their hours in Harvest and bill clients from it. Their questions are simple:
*what did I work on this week, what haven't I billed yet, can you log this hour for me*. Answering them still
means clicking through timesheets, reports and invoice screens. Claude and ChatGPT can't help, because they can't
see or change anything in Harvest.

## What I built

A remote MCP connector that people add to Claude or ChatGPT with one URL. After a short connect step they can
just ask:

- "What did I work on this week?"
- "Log 1.5 hours on Website Redesign, development: code review."
- "Start a timer on Mobile App." … "Stop my timer."
- "How much unbilled work do we have for Northwind?"
- "Create a draft invoice for Northwind for last month, grouped by task."

It has **13 tools**: 7 that only read (profile, projects and tasks, time entries, running timer, time report,
uninvoiced work, invoices) and 6 that make changes (log time, start/stop timers, edit and delete entries, draft
invoices).

## How it's built

- **Hosting:** Cloudflare Workers. Fast to start (no "sleeping" server), global, about $5/month when in use.
- **Sign-in:** OAuth 2.1 the way Claude and ChatGPT expect it: discovery documents, dynamic client registration and
  Client ID Metadata Documents, PKCE, refresh-token rotation. The person sees which app is asking and where access
  goes, and can choose read-only access.
- **Their Harvest token** is stored encrypted inside the authorization, with a key only that connection's tokens
  can unlock. Tokens are kept only as hashes.
- **Protocol:** MCP TypeScript SDK v2, serving both the 2026 protocol and 2025-era clients.

## Details that make it work well in a conversation

- Projects, tasks and clients can be named loosely ("web", "Website Redesign") or by ID. Unclear names come back
  with the list of matches instead of a guess.
- "Today" and "this week" use the person's own Harvest time zone and week start.
- Works whether the account records durations or start/end times.
- Invoices are only ever drafts; deleting shows a preview first; a read-only connection can't change anything.
- Errors tell the model what to do next. Harvest's rate limits are respected, and writes are never repeated.
- Every tool has a title and explicit safety labels, as Anthropic's and OpenAI's directory reviews require.

## How it was tested

- **76 unit tests** drive every tool through the real MCP handler against a fake Harvest API built from Harvest's
  documentation.
- **50 end-to-end checks** run the real Worker locally and walk the full flow: discovery, registration, consent,
  wrong token, multi-account tokens, PKCE, refresh, cancel, read-only, and tool calls over the 2026 and 2025
  protocols.
- **15 live checks** against the deployed connector.

## What this means for your product

The sign-in, consent page and tool framework are reusable. A connector for your product mainly needs your API
client and the tools your users would ask for, which means weeks of work become days. I can build it, get it ready
for Claude's and ChatGPT's directories, and host and maintain it.

Want one for your product? Get in touch through my GitHub profile.

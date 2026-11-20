# Directory listing draft (Claude)

Ready to paste into Claude's connector submission form once the connector has been tested with a real Harvest
account. Field limits are from Claude's submission docs (November 2026). Re-check them in the form.

**Name** (≤ 100 characters)
> Timesheets & Invoices for Harvest (unofficial)

**One-line description** (≤ 200 characters)
> Ask about your Harvest time, log hours, run timers and turn unbilled work into draft invoices. Independent connector, not made by Harvest.

**Description** (≤ 2,000 characters)
> Work with your Harvest time tracking in plain language. See what you worked on, check time reports and unbilled
> work, log or edit time, start and stop timers, and create draft invoices from tracked hours.
>
> You connect with a Harvest personal access token and choose whether changes are allowed. A read-only connection
> can only look. Invoices are always created as drafts and never sent; deleting an entry shows a preview first.
>
> Dates follow your Harvest time zone and week start. Projects and tasks can be named loosely or by ID.
>
> Your token is stored encrypted and is only used to call Harvest for you. Time entries, reports and invoices are
> not stored by this service.
>
> This is an independent connector. It is not made, endorsed or supported by Harvest.

**Categories** (1–5): Productivity, Finance

**Server URL:** `https://harvest-connector.aaditya-connectors.workers.dev/mcp`

**Documentation URL:** the GitHub README of this repository

**Privacy policy URL:** `https://harvest-connector.aaditya-connectors.workers.dev/privacy`

**Support contact:** the email set as the `SUPPORT_EMAIL` secret (also shown on the privacy page)

**Icon:** `https://harvest-connector.aaditya-connectors.workers.dev/icon.svg` (a neutral clock, not Harvest's logo).
Export a PNG if the form asks for one.

**Sign-in:** OAuth with dynamic client registration and Client ID Metadata Documents, PKCE S256.

**Example prompts for reviewers**
1. "What did I work on this week?"
2. "Log 30 minutes on [project], [task]: testing the connector."
3. "How much unbilled work is there for [client]?"
4. "Create a draft invoice for [client] grouped by task."

**Test account (Verified review only):** a free Harvest account with one or two clients, projects and a week of
time. Share the login through the reviewer channel Anthropic gives you, never in the form itself.

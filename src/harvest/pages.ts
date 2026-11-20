import { escapeHtml, htmlPage, htmlResponse } from '../core/html.ts';
import type { AppEnv } from '../env.ts';

const NOT_AFFILIATED = 'This is an independent connector. It is not made, endorsed or supported by Harvest.';

function contact(env: AppEnv): string {
  return env.SUPPORT_EMAIL?.trim() || 'support@example.com';
}

export function homePage(env: AppEnv, base: string): Response {
  const mcpUrl = `${base}/mcp`;
  return htmlResponse(
    htmlPage(
      'Harvest connector for Claude and ChatGPT',
      `<h1>Harvest connector for Claude and ChatGPT</h1>
<p>Ask your AI assistant about your Harvest time and invoices, log time, run timers and prepare draft invoices, in plain language.</p>
<h2>Connect it</h2>
<p>Add a custom connector (Claude) or app (ChatGPT developer mode) with this URL:</p>
<p><code>${escapeHtml(mcpUrl)}</code></p>
<p>When asked, paste a Harvest personal access token. You can choose read-only access.</p>
<h2>What it can do</h2>
<ul>
<li>List your projects, tasks and time entries; show the running timer</li>
<li>Time reports by client, project, task or person, and uninvoiced work</li>
<li>Log, edit and delete time, start and stop timers (if you allow changes)</li>
<li>Create draft invoices from tracked time. Invoices are never sent automatically</li>
</ul>
<p class="fine">${NOT_AFFILIATED} <a href="/privacy">Privacy policy</a> · Support: ${escapeHtml(contact(env))}</p>`,
    ),
  );
}

export function privacyPage(env: AppEnv): Response {
  const email = escapeHtml(contact(env));
  return htmlResponse(
    htmlPage(
      'Privacy policy',
      `<h1>Privacy policy</h1>
<p class="muted">Harvest connector for AI assistants. Last updated 20 November 2026.</p>
<h2>What we store</h2>
<ul>
<li>Your Harvest personal access token, encrypted (AES-GCM) with a key that only your connection's own tokens can unlock.</li>
<li>Your Harvest account ID and name, and your Harvest user ID, name, role and time zone, so tools can act as you.</li>
<li>Records of the connection itself: which AI app was connected, the permissions you granted, and hashes of its access tokens.</li>
</ul>
<h2>What we don't store</h2>
<p>Your time entries, projects, clients, reports and invoices are fetched from Harvest when a tool runs and passed straight to the AI app you connected. They are not kept by this service.</p>
<h2>Who receives data</h2>
<ul>
<li><strong>Harvest</strong>, to carry out each request.</li>
<li><strong>The AI app you connected</strong> (for example Claude or ChatGPT), which receives tool results under its own privacy policy.</li>
<li><strong>Cloudflare</strong>, which hosts this service and processes requests and short-lived operational logs. Logs never contain your token or Harvest data.</li>
</ul>
<p>We don't sell data, show ads, or use your data for anything except running the tools you call.</p>
<h2>How long we keep it</h2>
<p>A connection, its encrypted token and its account details are deleted automatically 60 days after it was last used, or when it is revoked.
You can cut off access at any time by deleting the personal access token in Harvest (id.getharvest.com/developers) or by removing the connector from your AI app.</p>
<h2>Contact</h2>
<p>Questions or deletion requests: ${email}</p>
<p class="fine">${NOT_AFFILIATED}</p>`,
      { wide: true },
    ),
  );
}

/** A neutral clock icon (deliberately not Harvest's logo). */
export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Clock">
<rect width="64" height="64" rx="14" fill="#f36c00"/>
<circle cx="32" cy="32" r="19" fill="none" stroke="#fff" stroke-width="5"/>
<path d="M32 20v13l9 6" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

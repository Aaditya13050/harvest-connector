/** Escape text for HTML element content and quoted attribute values. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

const CSS = `
:root{color-scheme:light dark;--bg:#f6f5f2;--card:#fff;--text:#1d1d1f;--muted:#5f5f66;--line:#e3e1dc;
--accent:#f36c00;--accent-text:#fff;--danger-bg:#fdecea;--danger:#9f1d12;--warn-bg:#fff6e0;--warn:#7a4b00;--focus:#2563eb}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--card:#1e1e22;--text:#ececf1;--muted:#a1a1aa;--line:#33333a;
--danger-bg:#3a1714;--danger:#ffb4a9;--warn-bg:#382a0c;--warn:#ffd88a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
display:flex;justify-content:center;padding:32px 16px}
.card{width:100%;max-width:520px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px}
.wide{max-width:760px}
h1{font-size:1.35rem;line-height:1.3;margin:0 0 8px}
h2{font-size:1.05rem;margin:24px 0 8px}
p{margin:8px 0}
.muted,.hint{color:var(--muted)}
.hint{font-size:.875rem;margin-top:6px}
.fine{font-size:.8rem;color:var(--muted);margin-top:20px}
label{display:block;font-weight:600;margin:18px 0 6px}
input[type=password],input[type=text]{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;
background:transparent;color:inherit;font:inherit}
input:focus-visible,button:focus-visible,summary:focus-visible,a:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
fieldset{border:1px solid var(--line);border-radius:10px;margin:20px 0 0;padding:8px 14px 12px}
legend{font-weight:600;padding:0 6px}
.check{display:flex;gap:10px;align-items:flex-start;font-weight:400;margin:10px 0}
.check input{margin-top:5px}
.actions{display:flex;gap:10px;margin-top:24px;flex-wrap:wrap}
button{font:inherit;font-weight:600;padding:10px 18px;border-radius:8px;border:1px solid var(--line);cursor:pointer;
background:transparent;color:inherit}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-text)}
.alert{border-radius:8px;padding:10px 12px;margin:14px 0}
.alert.error{background:var(--danger-bg);color:var(--danger)}
.alert.warn{background:var(--warn-bg);color:var(--warn)}
details{margin-top:14px}
summary{cursor:pointer;color:var(--muted)}
code{background:rgba(127,127,127,.15);padding:2px 6px;border-radius:6px;font-size:.9em;word-break:break-all}
a{color:inherit}
ul{padding-left:20px}
`;

/** A complete, self-contained HTML page (no scripts, no external assets). */
export function htmlPage(title: string, body: string, options: { wide?: boolean } = {}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body><main class="card${options.wide ? ' wide' : ''}">${body}</main></body>
</html>`;
}

/**
 * HTML response with a strict policy: no scripts, no framing, nothing loaded from elsewhere.
 * `form-action` is deliberately not restricted: after the consent form is posted, the browser
 * follows a redirect to the AI client (claude.ai, chatgpt.com, …), which Chrome would block.
 */
export function htmlResponse(
  html: string,
  init: { status?: number; headers?: Headers; /** Allows exactly the inline scripts carrying this nonce. */ scriptNonce?: string } = {},
): Response {
  const headers = new Headers(init.headers);
  headers.append(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'" +
      (init.scriptNonce ? `; script-src 'nonce-${init.scriptNonce}'` : ''),
  );
  headers.set('Content-Type', 'text/html; charset=utf-8');
  if (!headers.has('X-Content-Type-Options')) headers.set('X-Content-Type-Options', 'nosniff');
  if (!headers.has('Referrer-Policy')) headers.set('Referrer-Policy', 'no-referrer');
  if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'no-store');
  return new Response(html, { status: init.status ?? 200, headers });
}

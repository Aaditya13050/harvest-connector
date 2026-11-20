/** Start and stop `wrangler dev` pointed at the fake Harvest server (shared by e2e and demo). */
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

export interface WorkerOptions {
  port: number;
  fakeHarvestPort: number;
  /** Where local KV data lives; a temp dir gives a clean start. */
  stateDir?: string;
  supportEmail?: string;
  verbose?: boolean;
}

export function startWorker(options: WorkerOptions): ChildProcess {
  const wrangler = join(process.cwd(), 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const args = [
    wrangler,
    'dev',
    '--ip',
    '127.0.0.1',
    '--port',
    String(options.port),
    '--var',
    `HARVEST_API_BASE:http://127.0.0.1:${options.fakeHarvestPort}/v2`,
    '--var',
    `HARVEST_ID_BASE:http://127.0.0.1:${options.fakeHarvestPort}`,
    '--var',
    `SUPPORT_EMAIL:${options.supportEmail ?? 'demo@example.com'}`,
    '--show-interactive-dev-session=false',
  ];
  if (options.stateDir) args.push('--persist-to', options.stateDir);
  const child = spawn(process.execPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  child.stdout?.on('data', (d: Buffer) => options.verbose && process.stdout.write(`[wrangler] ${d}`));
  child.stderr?.on('data', (d: Buffer) => {
    const text = d.toString();
    if (options.verbose || /error/i.test(text)) process.stdout.write(`[wrangler] ${text}`);
    if (/ENOENT[\s\S]*workerd/.test(text)) {
      process.stdout.write(
        '\n[hint] workerd.exe could not be started. On Windows this usually means the project path is too long\n' +
          '       (over 260 characters). Move the project to a shorter folder, e.g. C:\\dev\\harvest-connector.\n\n',
      );
    }
  });
  return child;
}

export function stopWorker(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
    else child.kill('SIGTERM');
  } catch {
    // already gone
  }
}

export async function waitForWorker(base: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`wrangler dev did not answer on ${base} in time`);
}

/**
 * Demo mode: the connector running locally against a fake Harvest account with sample
 * clients, projects and time, so you can record a walkthrough without real data.
 *
 *   npm run demo
 *
 * Then point an MCP client at http://127.0.0.1:8787/mcp (for example the MCP Inspector:
 * npx @modelcontextprotocol/inspector), and paste the token printed below on the consent page.
 * To use it from Claude or ChatGPT, expose port 8787 over HTTPS with a tunnel
 * (e.g. cloudflared tunnel --url http://127.0.0.1:8787) and set PUBLIC_BASE_URL to the tunnel URL.
 */
import { FAKE_TOKEN } from './fake-harvest.ts';
import { startFakeHarvestServer } from './fake-harvest-server.ts';
import { startWorker, stopWorker, waitForWorker } from './dev-stack.ts';

const PORT = 8787;
const FAKE_PORT = 8790;
const base = `http://127.0.0.1:${PORT}`;

const harvest = await startFakeHarvestServer(FAKE_PORT);
const worker = startWorker({ port: PORT, fakeHarvestPort: FAKE_PORT, verbose: process.argv.includes('--verbose') });

const shutdown = async () => {
  stopWorker(worker);
  await harvest.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await waitForWorker(base);
console.log(`
Demo is running.
  Connector URL:          ${base}/mcp
  Home page:              ${base}/
  Fake Harvest token:     ${FAKE_TOKEN}
  Sample account:         Acme Studio (clients Northwind Traders and Globex Corporation)

Press Ctrl+C to stop.`);

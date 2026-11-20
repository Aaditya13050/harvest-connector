/**
 * Serves FakeHarvest over HTTP for the end-to-end test, or by hand:
 *   npm run fake-harvest            (port 8790)
 * then run `wrangler dev` with HARVEST_API_BASE=http://127.0.0.1:8790/v2 and
 * HARVEST_ID_BASE=http://127.0.0.1:8790, and connect with the token printed below.
 */
import { createServer, type Server } from 'node:http';
import { FAKE_TOKEN, FakeHarvest } from './fake-harvest.ts';

export function todayInZone(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export async function startFakeHarvestServer(port: number, fake = new FakeHarvest({ today: todayInZone('Asia/Kolkata') })) {
  const server: Server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(name, value);
        else if (Array.isArray(value)) headers.set(name, value.join(', '));
      }
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && chunks.length > 0;
      const request = new Request(`http://127.0.0.1:${port}${req.url}`, {
        method: req.method,
        headers,
        body: hasBody ? Buffer.concat(chunks) : undefined,
      });
      const response = await fake.handle(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { fake, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

if (import.meta.url === `file:///${process.argv[1]?.replaceAll('\\', '/')}` || process.argv[1]?.endsWith('fake-harvest-server.ts')) {
  const port = Number(process.env['PORT'] ?? 8790);
  await startFakeHarvestServer(port);
  console.log(`Fake Harvest listening on http://127.0.0.1:${port}`);
  console.log(`Personal access token: ${FAKE_TOKEN}`);
}

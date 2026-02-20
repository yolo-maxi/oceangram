import { describe, it, expect } from 'vitest';
import { WebSocketServer } from 'ws';
import { OpenClawGatewayClient } from '../services/openclawGateway';

function createServer(): Promise<{ server: WebSocketServer; port: number }> {
  return new Promise((resolve) => {
    const server = new WebSocketServer({ port: 0 }, () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port });
    });
  });
}

describe('OpenClawGatewayClient', () => {
  it('should connect, request, and handle events', async () => {
    const { server, port } = await createServer();

    server.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data));
        if (msg.method === 'connect') {
          ws.send(JSON.stringify({ type: 'res', id: msg.id, result: { auth: {} } }));
        } else if (msg.method === 'sessions.list') {
          ws.send(JSON.stringify({
            type: 'res', id: msg.id,
            result: { sessions: [{ key: 'test', model: 'claude', updatedAt: Date.now() }] },
          }));
        } else if (msg.method === 'cron.list') {
          ws.send(JSON.stringify({ type: 'res', id: msg.id, result: { jobs: [] } }));
        } else if (msg.method === 'bad.method') {
          ws.send(JSON.stringify({ type: 'err', id: msg.id, error: 'not found' }));
        }
        // Other methods: no response (for timeout test)
      });
    });

    const client = new OpenClawGatewayClient(`ws://127.0.0.1:${port}`, 'test-token');

    // Connect
    await client.connect();
    expect(client.connected).toBe(true);

    // List sessions
    const result = await client.listSessions();
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].key).toBe('test');

    // List cron jobs
    const crons = await client.listCronJobs();
    expect(crons.jobs).toHaveLength(0);

    // Error handling
    await expect(client.request('bad.method')).rejects.toThrow('not found');

    // Timeout handling
    await expect(client.request('noresponse.method', {}, 200)).rejects.toThrow('timeout');

    // Cleanup
    client.dispose();
    expect(client.connected).toBe(false);
    await new Promise<void>((r) => server.close(() => r()));
  });
});

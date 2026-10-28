import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { isLegacyHost, renderRebrandPage } from '../src/dashboard/rebrand.js';
import { createDashboardServer } from '../src/dashboard/server.js';
import { createStore } from '../src/database/store.js';

describe('old host notice', () => {
  it('recognises the hosts that used to be the product', () => {
    assert.equal(isLegacyHost('asteria.navaratne.uk'), true);
    assert.equal(isLegacyHost('ASTERIA.navaratne.uk:443'), true);
    assert.equal(isLegacyHost('asteria.mini-jacob.hackclub.app'), true);
  });

  it('leaves the new host and unknown hosts alone', () => {
    assert.equal(isLegacyHost('orbit.navaratne.uk'), false);
    assert.equal(isLegacyHost('localhost:8787'), false);
    assert.equal(isLegacyHost(''), false);
    assert.equal(isLegacyHost(undefined), false);
  });

  it('says what happened and keeps the path it was asked for', () => {
    const html = renderRebrandPage({ path: '/R0C8JLTL3QW', search: '?from=slack' });
    assert(html.includes('We have rebranded to'));
    assert(html.includes('https://orbit.navaratne.uk/R0C8JLTL3QW?from=slack'));
    assert(html.includes('points and access have been moved over'));
    assert(!html.includes('—'), 'no em dashes, as requested');
  });
});

describe('serving the notice', () => {
  let store;
  let server;
  let base;

  after(() => {
    server?.close();
    store?.close();
  });

  it('shows the notice on the old host but keeps health and the api alive', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-rebrand-'));
    store = await createStore(path.join(dir, 'asteria.sqlite'));
    server = createDashboardServer({
      store,
      client: {},
      botChannels: { list: async () => [] },
      logger: { info() {}, warn() {}, error() {} },
    });
    await server.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${server.server.address().port}`;

    // fetch() treats Host as a forbidden header, so a raw request is the only
    // way to exercise host based routing in a test.
    const page = await request(base, '/', 'asteria.navaratne.uk');
    assert.equal(page.status, 200);
    assert(page.body.includes('rebranded to'), 'the notice is served');

    const health = await request(base, '/health', 'asteria.navaratne.uk');
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.body).ok, true, 'health is not the notice');

    const stats = await request(base, '/api/stats', 'asteria.navaratne.uk');
    assert.equal(stats.status, 200);
    assert.equal(typeof JSON.parse(stats.body).generatedAt, 'string', 'an open tab keeps polling');
  });
});

function request(base, route, host) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path: route, headers: { host } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

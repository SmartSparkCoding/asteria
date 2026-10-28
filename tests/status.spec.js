import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { appendStatusEvent, buildStatusRss, readStatusEvents } from '../src/status/status-core.js';

const createdFiles = [];

afterEach(() => {
  for (const filePath of createdFiles) {
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  }
  createdFiles.length = 0;
});

function tempStatusFile() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-status-'));
  const filePath = path.join(tempDir, 'status-events.json');
  createdFiles.push(filePath);
  return filePath;
}

describe('status core', () => {
  it('appends up/down transitions and records a heartbeat for repeated states', () => {
    const filePath = tempStatusFile();

    appendStatusEvent(filePath, 'up', 'service started');
    appendStatusEvent(filePath, 'down', 'service stopped');
    appendStatusEvent(filePath, 'down', 'service stopped again');

    const events = readStatusEvents(filePath);
    assert.equal(events.length, 2);
    assert.equal(events[0].state, 'up');
    assert.equal(events[0].detail, 'service started');
    assert.equal(events[1].state, 'down');
    assert.equal(events[1].detail, 'service stopped again');
  });

  it('builds an RSS feed with the current status and history items', () => {
    const filePath = tempStatusFile();
    appendStatusEvent(filePath, 'up', 'started');
    appendStatusEvent(filePath, 'down', 'stopped');

    const rss = buildStatusRss({
      events: readStatusEvents(filePath),
      siteUrl: 'https://example.com',
    });

    assert(rss.includes('<rss version="2.0"'));
    assert(rss.includes('<title>Orbit is currently down</title>'));
    assert(rss.includes('<title>Orbit is up</title>'));
    assert(rss.includes('<title>Orbit is down</title>'));
    assert(rss.includes('<link>https://example.com/</link>'));
    assert(rss.includes('<guid isPermaLink="false">asteria-status-current</guid>'));
    assert(rss.includes('application/rss+xml'));
  });

  it('serves an empty feed when no events exist', () => {
    const filePath = tempStatusFile();
    const rss = buildStatusRss({
      events: readStatusEvents(filePath),
      siteUrl: 'https://example.com',
    });
    assert(rss.includes('<title>Orbit is currently unknown</title>'));
    assert.equal((rss.match(/<item>/g) || []).length, 1);
  });
});

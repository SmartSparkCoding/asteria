import fs from 'node:fs';
import path from 'node:path';

const MAX_EVENTS = 200;

export function readStatusEvents(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function appendStatusEvent(filePath, state, detail = '') {
  const events = readStatusEvents(filePath);
  const last = events[events.length - 1];
  const nowIso = new Date().toISOString();

  if (last && last.state === state) {
    last.at = nowIso;
    last.detail = detail || last.detail || '';
  } else {
    events.push({
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      state,
      at: nowIso,
      detail: detail || '',
    });
  }

  const trimmed = events.slice(-MAX_EVENTS);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(trimmed, null, 2)}\n`);
  return trimmed;
}

function toRfc822Date(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? new Date().toUTCString() : date.toUTCString();
}

export function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildStatusRss({ events, siteUrl }) {
  const baseUrl = siteUrl || 'http://localhost';
  const lastEvent = events[events.length - 1];
  const lastBuildDate = lastEvent ? toRfc822Date(lastEvent.at) : new Date().toUTCString();
  const currentState = lastEvent ? lastEvent.state : 'unknown';

  const historyItems = events
    .slice(-50)
    .reverse()
    .map((event) => {
      const isUp = event.state === 'up';
      const when = new Date(event.at).toISOString();
      return `    <item>
      <title>Orbit is ${isUp ? 'up' : 'down'}</title>
      <link>${escapeXml(baseUrl)}/</link>
      <guid isPermaLink="false">asteria-status-${escapeXml(event.id)}</guid>
      <pubDate>${toRfc822Date(event.at)}</pubDate>
      <description>Orbit was ${isUp ? 'up' : 'down'} at ${escapeXml(when)}${event.detail ? ` (${escapeXml(event.detail)})` : ''}.</description>
    </item>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Orbit is currently ${currentState}</title>
    <link>${escapeXml(baseUrl)}/</link>
    <description>Up/down status history for the Orbit Slack bot.</description>
    <language>en</language>
    <lastBuildDate>${lastBuildDate}</lastBuildDate>
    <atom:link href="${escapeXml(baseUrl)}/rss.xml" rel="self" type="application/rss+xml"/>
    <item>
      <title>Orbit is currently ${currentState}</title>
      <link>${escapeXml(baseUrl)}/</link>
      <guid isPermaLink="false">asteria-status-current</guid>
      <pubDate>${lastBuildDate}</pubDate>
      <description>Current status of the Orbit bot as of ${lastBuildDate}.</description>
    </item>
${historyItems}
  </channel>
</rss>
`;
}

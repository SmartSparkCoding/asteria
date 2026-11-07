/**
 * Dump the huddle room payloads Slack publishes on huddle threads.
 *
 * Every huddle number Orbit produces comes out of one object: the `room` field
 * on the root message of a huddle thread. This prints what Slack actually put
 * there, so a disagreement about a duration can be settled with data instead of
 * a reading of the source.
 *
 * Run it from the folder with the .env inside:
 *
 *   node scripts/sniff-huddles.mjs
 *
 * If a huddle is running it samples the roster every 20s for four minutes, which
 * is the only way to answer "does participants update while the huddle runs".
 * Change the window with WATCH_SECONDS=600 or POLL_SECONDS=60.
 *
 * Read only. It calls conversations.list, conversations.history and
 * conversations.replies, and writes the payloads it finds to /tmp.
 */

import fs from 'node:fs';

const readEnv = (path) => {
  if (!fs.existsSync(path)) return {};
  const out = {};
  for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const at = trimmed.indexOf('=');
    out[trimmed.slice(0, at).trim()] = trimmed
      .slice(at + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }
  return out;
};

const env = readEnv('.env');
const TOKEN = process.env.SLACK_BOT_TOKEN || env.SLACK_BOT_TOKEN;
if (!TOKEN) {
  console.error('no SLACK_BOT_TOKEN found in .env, run this from the orbit folder');
  process.exit(1);
}

const WATCH_SECONDS = Number(process.env.WATCH_SECONDS || 240);
const POLL_SECONDS = Number(process.env.POLL_SECONDS || 20);
const CHANNEL_CAP = 25;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clock = (s) => (s ? new Date(Number(s) * 1000).toISOString().slice(11, 19) : '-');

async function api(method, params = {}) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(params),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`${method}: ${body.error}`);
  return body;
}

const channels = [];
let cursor = '';
do {
  const body = await api('conversations.list', {
    types: 'public_channel,private_channel',
    exclude_archived: true,
    limit: 200,
    cursor,
  });
  channels.push(...(body.channels || []).filter((c) => c.is_member));
  cursor = body.response_metadata?.next_cursor || '';
} while (cursor && channels.length < 200);

const scan = channels.slice(0, CHANNEL_CAP);
console.log(`scanning ${scan.length} channels the bot is in`);

const found = [];
for (const channel of scan) {
  let threads = [];
  try {
    const body = await api('conversations.history', { channel: channel.id, limit: 100 });
    threads = (body.messages || []).filter((m) => m.subtype === 'huddle_thread');
  } catch (error) {
    console.log(`  ${channel.name}: ${error.message}`);
  }
  for (const thread of threads) {
    try {
      const body = await api('conversations.replies', { channel: channel.id, ts: thread.ts, limit: 1 });
      const room = body.messages?.[0]?.room;
      if (room?.call_family === 'huddle') {
        found.push({ channel: channel.id, name: channel.name, ts: thread.ts, room });
      }
    } catch (error) {
      console.log(`  ${channel.name}/${thread.ts}: ${error.message}`);
    }
    await sleep(250);
  }
  await sleep(250);
}

if (!found.length) {
  console.log('no huddle_thread messages in the last 100 messages of any channel.');
  process.exit(0);
}

found.sort((a, b) => Number(b.room.date_start) - Number(a.room.date_start));
console.log('');
for (const item of found) {
  const room = item.room;
  const who = (room.participants || []).join(',') || '-';
  const state = room.date_end ? 'ended' : 'LIVE ';
  console.log(
    `${item.name} (${item.channel})  ${state}  start ${clock(room.date_start)}  end ${clock(room.date_end)}  in ${String((room.participants || []).length).padStart(2)} [${who}]  ever ${(room.participant_history || []).length}`,
  );
}

const live = found.filter((item) => !item.room.date_end);
const hottest = live[0] || found[0];
const path = `/tmp/orbit-room-${hottest.room.id || 'unknown'}.json`;
fs.writeFileSync(path, JSON.stringify(hottest.room, null, 2));
console.log('');
console.log(`full payload of ${hottest.name}: ${path}`);

if (!live.length) {
  console.log('nothing running right now, so that is the after-it-ended payload.');
} else {
  console.log('');
  console.log(`watching ${live.length} running huddle(s) for ${WATCH_SECONDS}s, a sample every ${POLL_SECONDS}s`);
  console.log('');
  const deadline = Date.now() + WATCH_SECONDS * 1000;
  const previous = new Map();
  while (Date.now() < deadline) {
    for (const item of live) {
      try {
        const body = await api('conversations.replies', { channel: item.channel, ts: item.ts, limit: 1 });
        const room = body.messages?.[0]?.room;
        if (!room) continue;
        item.room = room;
        const who = (room.participants || []).join(',') || '-';
        const before = previous.get(room.id);
        const moved = before === undefined ? '' : before === who ? '  same' : '  CHANGED';
        previous.set(room.id, who);
        console.log(
          `${clock(Math.floor(Date.now() / 1000))}  ${item.name}  in ${String((room.participants || []).length).padStart(2)} [${who}]  ever ${(room.participant_history || []).length}  end ${clock(room.date_end)}${moved}`,
        );
        if (room.date_end) {
          const done = `/tmp/orbit-room-${room.id}-ended.json`;
          fs.writeFileSync(done, JSON.stringify(room, null, 2));
          console.log(`ended, final payload ${done}`);
        }
      } catch (error) {
        console.log(`  ${item.name}: ${error.message}`);
      }
      await sleep(400);
    }
    await sleep(POLL_SECONDS * 1000);
  }
  for (const item of live) {
    const out = `/tmp/orbit-room-${item.room.id}-last.json`;
    fs.writeFileSync(out, JSON.stringify(item.room, null, 2));
    console.log(`last payload for ${item.name}: ${out}`);
  }
}

console.log('');
console.log('----- newest payload, paste this back -----');
console.log(JSON.stringify(hottest.room, null, 2));

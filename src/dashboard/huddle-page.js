/**
 * A single huddle's own page, at /<call id>.
 *
 * These pages are deliberately not linked from anywhere public. The access rule
 * is: Jacob (the super admin), or somebody who was actually in the huddle. A
 * Slack link unfetcher has no session cookie, so pasting one of these links into
 * a channel shows whoever is not already allowed to see it nothing at all, and
 * the page carries noindex plus no Open Graph tags so nothing is previewed
 * either.
 */

import { awardItems } from '../huddles/points.js';
import { ORBIT_FAVICON, ORBIT_MARK_SVG, THEME_TOKENS } from './theme.js';

const STYLES = `
${THEME_TOKENS}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;color:var(--ink);font-family:var(--sans);font-size:15px;line-height:1.5;
  background:radial-gradient(900px 400px at 50% -8%, var(--tint), transparent 70%),var(--bg);
  -webkit-font-smoothing:antialiased}
a{color:var(--accent-bright);text-decoration:none}
a:hover{text-decoration:underline}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;
  padding:0 clamp(16px,4vw,36px);height:56px;background:var(--glass);
  backdrop-filter:saturate(140%) blur(10px);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:2}
.brand{display:flex;align-items:center;gap:9px;color:var(--ink);font-weight:600}
.brand:hover{text-decoration:none}
.mark{display:grid;place-items:center;width:28px;height:28px;border-radius:var(--r-sm);color:var(--accent-bright);
  background:var(--surface);box-shadow:0 0 0 1px var(--line)}
.brand-text{display:flex;flex-direction:column;line-height:1.2}
.brand-text em{font-style:normal;font-size:9.5px;letter-spacing:.15em;text-transform:uppercase;color:var(--ink-3)}
main{max-width:880px;margin:0 auto;padding:28px clamp(16px,4vw,28px) 64px}
h1{font-size:24px;letter-spacing:-.01em;margin:0 0 4px}
.sub{color:var(--ink-3);font-size:13px;margin:0 0 22px}
.sub a{color:var(--ink-3)}
.status{display:inline-flex;align-items:center;gap:7px;font-size:11px;letter-spacing:.12em;text-transform:uppercase;
  color:var(--ink-2);padding:4px 10px;border-radius:999px;box-shadow:0 0 0 1px var(--line);margin-left:8px;
  vertical-align:middle}
.status i{width:6px;height:6px;border-radius:50%;background:var(--ink-3)}
.status.live i{background:var(--green);animation:pulse 2.4s infinite}
.status.ended i{background:var(--ink-3)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:0 0 26px}
.fact{background:var(--surface);border-radius:var(--r);padding:12px 14px;box-shadow:0 0 0 1px var(--line)}
.fact dt{font-size:10.5px;letter-spacing:.13em;text-transform:uppercase;color:var(--ink-3);margin:0 0 3px}
.fact dd{margin:0;font-size:19px;font-weight:600;font-family:var(--mono);letter-spacing:-.01em}
.fact dd small{font-size:11px;font-weight:400;color:var(--ink-3);font-family:var(--sans)}
.kicker{margin:0 0 8px;font-size:9.5px;letter-spacing:.22em;text-transform:uppercase;color:var(--accent);font-weight:700}
.bar{height:4px;border-radius:3px;background:var(--line);margin-top:7px;overflow:hidden;max-width:260px}
.bar i{display:block;height:100%;border-radius:3px;background:linear-gradient(90deg,var(--accent),var(--accent-bright))}
.stage{position:relative;overflow:hidden;margin:0 0 28px;padding:26px 26px 22px;border-radius:24px;
  background:
    radial-gradient(680px 300px at 90% -50%,var(--tint-2),transparent 70%),
    linear-gradient(165deg,var(--stage-top),var(--stage-bottom));
  box-shadow:inset 0 0 0 1px var(--hair),var(--lift)}
.stage::after{content:"";position:absolute;right:-100px;top:-130px;width:420px;height:420px;pointer-events:none;
  opacity:.5;transform:rotate(-18deg) scaleY(.5);
  background:
    radial-gradient(circle at 50% 50%,transparent 46.6%,var(--ring-strong) 47%,transparent 47.6%),
    radial-gradient(circle at 50% 50%,transparent 62%,var(--hair-strong) 62.3%,transparent 62.9%)}
.stage .facts{position:relative;z-index:1;display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));
  gap:0;margin:24px 0 0;padding-top:20px;border-top:1px solid var(--hair)}
.stage .fact{background:none;box-shadow:none;border-radius:0;padding:0 18px;border-left:1px solid var(--hair)}
.stage .fact:first-child{padding-left:0;border-left:0}
.fact dd{font-size:24px;letter-spacing:-.03em}
@media (max-width:620px){
  .stage{padding:20px 18px 18px;border-radius:20px}
  .stage .facts{grid-template-columns:1fr 1fr;gap:18px 0}
  .stage .fact:nth-child(odd){padding-left:0;border-left:0}
}
table{box-shadow:inset 0 0 0 1px var(--hair)}
tr.longest{background:var(--tint)}
h2{font-size:12px;letter-spacing:.13em;text-transform:uppercase;color:var(--ink-3);margin:30px 0 10px;font-weight:600}
table{width:100%;border-collapse:collapse;background:var(--surface);border-radius:var(--r);overflow:hidden;
  box-shadow:0 0 0 1px var(--line)}
th{font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3);text-align:left;
  padding:10px 14px;font-weight:600;background:var(--raised)}
td{padding:10px 14px;border-top:1px solid var(--line);vertical-align:top}
td.num,th.num{text-align:right;font-family:var(--mono);font-size:13px;white-space:nowrap}
.who-cell{display:flex;align-items:center;gap:9px}
.avatar{width:24px;height:24px;border-radius:50%;background:var(--raised);flex:none}
.reasons{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}
.reason{font-family:var(--mono);font-size:10.5px;color:var(--ink-2);background:var(--raised);
  border-radius:999px;padding:2px 7px;box-shadow:0 0 0 1px var(--line)}
.reason b{color:var(--accent-bright);font-weight:600;margin-left:4px}
.empty{background:var(--surface);border-radius:var(--r);padding:20px 16px;box-shadow:0 0 0 1px var(--line);
  color:var(--ink-3);font-size:13.5px}
.note{font-size:12.5px;color:var(--ink-3);background:var(--surface);border-radius:var(--r);padding:12px 14px;
  box-shadow:0 0 0 1px var(--line);margin:0 0 20px}
.starter{color:var(--ink-2)}
.rank{font-family:var(--mono);color:var(--ink-3);font-size:12px;width:28px}
tr.longest .reason{color:var(--gold)}
.foot{color:var(--ink-3);font-size:12px;margin-top:30px;padding-top:16px;border-top:1px solid var(--line)}
`;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** "1h 12m" / "8m" / "45s", which is how the one line summary reads it too. */
export function formatHuddleLength(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (total === 0) {
    return '0m';
  }
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (!hours) {
    return `${Math.max(1, minutes)}m`;
  }
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

/**
 * The chips under a name, each carrying what it was worth.
 *
 * `awardItems` also understands the bare strings older awards were stored as,
 * so a huddle from before the breakdown existed still shows its reasons, with
 * the values rebuilt from the rules that produced them.
 */
function reasonChips(reasons) {
  return awardItems(reasons)
    .map((item) => {
      const label = item.label === 'backfilled' ? 'rebuilt from recorded attendance' : item.label;
      return `<span class="reason">${escapeHtml(label)}${
        item.points ? `<b>+${item.points}</b>` : ''
      }</span>`;
    })
    .join('');
}

function personCell(name, avatarUrl) {
  return `<span class="who-cell">${
    avatarUrl ? `<img class="avatar" src="${escapeHtml(avatarUrl)}" alt="">` : '<span class="avatar"></span>'
  }<span>${escapeHtml(name)}</span></span>`;
}

/**
 * @param {object} view
 * @param {object} view.huddle       the huddle row
 * @param {Array}  view.participants [{ userId, name, avatarUrl, durationSeconds, points, reasons, longest }]
 * @param {object} view.channel      { name, isPrivate }
 * @param {number} view.totalPoints
 * @param {string} view.startedLabel / endedLabel
 * @param {boolean} view.reconstructed  true when this breakdown was rebuilt after the fact
 */
/**
 * What to print in "In the call".
 *
 * A partial stretch used to print 0m, which reads as "never here" for somebody
 * who was actually in the call for hours. Show the provable floor instead and
 * say so, and call out anyone Slack still lists as present.
 */
function timeLabel(participant) {
  const seconds = Number(participant.provableSeconds) || 0;
  const inNow = participant.isIn ? ' · in now' : '';
  if (seconds > 0) {
    return (participant.partial ? 'at least ' : '') + formatHuddleLength(seconds) + inNow;
  }
  if (participant.isIn) {
    return 'in now';
  }
  return participant.partial ? 'unknown' : '0m';
}

export function renderHuddlePage(view) {
  const {
    huddle,
    participants = [],
    channel = {},
    totalPoints = 0,
    startedLabel = 'unknown',
    endedLabel = '',
    durationSeconds = 0,
    isLive = false,
    reconstructed = false,
    attendancePartial = false,
  } = view;

  // Naming the channel here is deliberate even when it is private. Reaching this
  // page already requires being the owner or a participant, and somebody who was
  // in a private channel already knows its name, so hiding it here would tell
  // them nothing. The surfaces that need hiding are the ones anyone can load.
  const channelLabel = channel.name
    ? `#${channel.name}`
    : huddle.channel_id
      ? huddle.channel_id.startsWith('D') || huddle.channel_id.startsWith('G')
        ? 'a DM'
        : 'a channel'
      : 'no channel';
  const startedBy = participants.find((participant) => participant.userId === huddle.created_by);
  const startedByName = startedBy?.name || 'someone';

  // `text: true` is a name rather than a figure, so it gets the smaller type.
  const facts = [
    // data-live marks the two numbers that move while the huddle is still going,
    // so the poller below can update them without reloading the page.
    { label: 'Points awarded', value: `${totalPoints}`, live: 'points' },
    { label: 'Length', value: formatHuddleLength(durationSeconds) },
    { label: 'People (ever)', value: `${participants.length}`, live: 'participants' },
    { label: 'Started by', value: startedByName, text: true },
  ];

  const longestStretch = Math.max(0, ...participants.map((participant) => participant.provableSeconds || 0));
  const rows = participants
    .map((participant, index) => {
      const medal = participant.longest
        ? ' var(--gold)'
        : index === 0
          ? 'var(--gold)'
          : index === 1
            ? 'var(--bronze)'
            : index === 2
              ? 'var(--silver)'
              : 'var(--ink-3)';
      const reasons = reasonChips(participant.reasons || []);
      return `<tr${participant.longest ? ' class="longest"' : ''}>
<td class="rank" style="color:${medal}">${index + 1}</td>
<td>${personCell(participant.name, participant.avatarUrl)}${reasons ? `<div class="reasons">${reasons}</div>` : ''}${
        longestStretch > 0
          ? `<div class="bar"><i style="width:${Math.max(2, Math.round(((participant.provableSeconds || 0) / longestStretch) * 100))}%"></i></div>`
          : ''
      }</td>
<td class="num">${escapeHtml(timeLabel(participant))}</td>
<td class="num">${participant.points ? `${participant.points}` : '<span class="muted">0</span>'}</td>
</tr>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>Huddle ${escapeHtml(huddle.call_id)} · Jacob's Orbit</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(ORBIT_FAVICON)}" type="image/svg+xml">
<style>${STYLES}</style>
</head>
<body>
<header class="topbar">
  <a class="brand" href="/">
    <span class="mark">${ORBIT_MARK_SVG}</span>
    <span class="brand-text">Jacob's Orbit<em>huddle</em></span>
  </a>
</header>

<main>
  <section class="stage">
  <p class="kicker">orbit · huddle</p>
  <h1>${escapeHtml(channelLabel)}<span class="status ${isLive ? 'live' : 'ended'}"><i></i>${isLive ? 'live now' : 'ended'}</span></h1>
  <p class="sub">Started ${escapeHtml(startedLabel)}${
    endedLabel ? ` · ended ${escapeHtml(endedLabel)}` : ''
  } · <span class="muted">${escapeHtml(huddle.call_id)}</span></p>

  ${
    reconstructed
      ? `<p class="note">This breakdown was rebuilt from the attendance Orbit recorded at the time. The longest
         and shortest message awards were never stored, so they are not included here. New huddles record every
         reason.</p>`
      : ''
  }
  ${
    attendancePartial
      ? `<p class="note">Some attendance could not be proven. Slack dropped a few join and leave events during
         this huddle, so the times below are the stretches Orbit can demonstrate and may undercount. Points are
         awarded on that same basis.</p>`
      : ''
  }
  ${
    totalPoints === 0
      ? `<p class="note">No points were awarded for this huddle. Orbit only awards points for huddles it can
         prove it was inside, and this one has no channel it was in.</p>`
      : ''
  }

  <dl class="facts">
${facts
  .map(
    ({ label, value, text, live }) =>
      `    <div class="fact"><dt>${escapeHtml(label)}</dt><dd${
        live ? ` data-live="${live}"` : ''
      }${text ? ' style="font-size:15px"' : ''}>${escapeHtml(value)}</dd></div>`,
  )
  .join('\n')}
  </dl>
  </section>

  <h2>Everyone in the huddle</h2>
  ${
    participants.length
      ? `<table>
<thead><tr><th class="rank">#</th><th>Person</th><th class="num">In the call</th><th class="num">Points</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`
      : '<div class="empty">Nobody was recorded in this huddle.</div>'
  }

  <p class="foot">This page is only visible to Orbit's owner and to people who were in this huddle. It is not
  listed anywhere. Huddle data is Orbit's own; where a channel is private, the numbers here are only ever shown
  here.</p>
</main>
${
  isLive
    ? `<script>
// Keeps a running huddle current without a reload. Same origin, no third party.
(async () => {
  const id = ${JSON.stringify(huddle.call_id)};
  while (document.visibilityState === 'visible') {
    try {
      const response = await fetch('/api/huddle/' + encodeURIComponent(id) + '/live', { headers: { accept: 'application/json' } });
      if (response.status === 401 || response.status === 403 || response.status === 404) return;
      if (!response.ok) break;
      const data = await response.json();
      if (!data.isLive) { location.reload(); return; }
      // Show the movement rather than only using the poll to notice the end.
      // A number that silently stays at its first value is worse than no
      // live view, because it looks like a huddle nobody is in.
      for (const [key, value] of [['participants', data.participants], ['points', data.totalPoints]]) {
        const node = document.querySelector('[data-live="' + key + '"]');
        if (node && Number.isFinite(value) && node.textContent !== String(value)) {
          node.textContent = String(value);
        }
      }
    } catch { break; }
    await new Promise((r) => setTimeout(r, 5000));
  }
})();
</script>`
    : ''
}
</body>
</html>`;
}

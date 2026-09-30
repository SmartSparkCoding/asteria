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

const ACCENT = '#238636';
const ACCENT_BRIGHT = '#2ea043';

const STYLES = `
:root{color-scheme:dark;
  --bg:#0d1117; --surface:#161b22; --raised:#21262d; --line:#30363d;
  --ink:#f0f6fc; --ink-2:#c9d1d9; --ink-3:#8b949e;
  --accent:${ACCENT}; --accent-bright:${ACCENT_BRIGHT};
  --gold:#ffd700; --bronze:#cd7f32; --silver:#c0c0c0; --red:#f85149;
  --r:10px; --r-sm:6px;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;color:var(--ink);font-family:var(--sans);font-size:15px;line-height:1.5;
  background:radial-gradient(900px 400px at 50% -8%, rgba(46,160,67,.07), transparent 70%),var(--bg);
  -webkit-font-smoothing:antialiased}
a{color:var(--accent-bright);text-decoration:none}
a:hover{text-decoration:underline}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;
  padding:0 clamp(16px,4vw,36px);height:56px;background:rgba(13,17,23,.86);
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
.status.live i{background:var(--accent-bright);animation:pulse 2.4s infinite}
.status.ended i{background:var(--ink-3)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:0 0 26px}
.fact{background:var(--surface);border-radius:var(--r);padding:12px 14px;box-shadow:0 0 0 1px var(--line)}
.fact dt{font-size:10.5px;letter-spacing:.13em;text-transform:uppercase;color:var(--ink-3);margin:0 0 3px}
.fact dd{margin:0;font-size:19px;font-weight:600;font-family:var(--mono);letter-spacing:-.01em}
.fact dd small{font-size:11px;font-weight:400;color:var(--ink-3);font-family:var(--sans)}
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

function reasonLabel(reason) {
  // Written by computeHuddlePoints: "12m" attendance, "rank 1", "longest
  // message", "shortest message", "started the huddle".
  if (/^\d+m$/.test(reason)) {
    return `${reason} in the call`;
  }
  if (/^rank /.test(reason)) {
    return reason;
  }
  return reason;
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
    { label: 'In the huddle', value: `${participants.length}`, live: 'participants' },
    { label: 'Started by', value: startedByName, text: true },
  ];

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
      const reasons = (participant.reasons || [])
        .map((reason) => `<span class="reason">${escapeHtml(reasonLabel(reason))}</span>`)
        .join('');
      return `<tr${participant.longest ? ' class="longest"' : ''}>
<td class="rank" style="color:${medal}">${index + 1}</td>
<td>${personCell(participant.name, participant.avatarUrl)}${reasons ? `<div class="reasons">${reasons}</div>` : ''}</td>
<td class="num">${escapeHtml(formatHuddleLength(participant.durationSeconds))}</td>
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
<title>Huddle ${escapeHtml(huddle.call_id)} · Asteria</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${STYLES}</style>
</head>
<body>
<header class="topbar">
  <a class="brand" href="/">
    <span class="mark"><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.6c.4 0 .8.3 1 .7l2.4 7.4c.2.5.5.9 1 1l7.4 2.4c.8.3.8 1.4 0 1.7l-7.4 2.4c-.5.2-.9.5-1 1L13 21c-.3.8-1.4.8-1.7 0l-2.4-7.4c-.2-.5-.5-.9-1-1L.5 10.5c-.8-.3-.8-1.4 0-1.7l7.4-2.4c.5-.2.9-.5 1-1L11 3.3c.2-.4.6-.7 1-.7z"/></svg></span>
    <span class="brand-text">Asteria<em>huddle</em></span>
  </a>
</header>

<main>
  <h1>Huddle overview<span class="status ${isLive ? 'live' : 'ended'}"><i></i>${isLive ? 'live now' : 'ended'}</span></h1>
  <p class="sub">${escapeHtml(channelLabel)} · started ${escapeHtml(startedLabel)}${
    endedLabel ? ` · ended ${escapeHtml(endedLabel)}` : ''
  } · <span class="muted">${escapeHtml(huddle.call_id)}</span></p>

  ${
    reconstructed
      ? `<p class="note">This breakdown was rebuilt from the attendance Asteria recorded at the time. The longest
         and shortest message awards were never stored, so they are not included here. New huddles record every
         reason.</p>`
      : ''
  }
  ${
    attendancePartial
      ? `<p class="note">Some attendance could not be proven. Slack dropped a few join and leave events during
         this huddle, so the times below are the stretches Asteria can demonstrate and may undercount. Points are
         awarded on that same basis.</p>`
      : ''
  }
  ${
    totalPoints === 0
      ? `<p class="note">No points were awarded for this huddle. Asteria only awards points for huddles it can
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

  <p class="foot">This page is only visible to Asteria's owner and to people who were in this huddle. It is not
  listed anywhere. Huddle data is Asteria's own; where a channel is private, the numbers here are only ever shown
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

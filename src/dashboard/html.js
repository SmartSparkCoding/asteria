const ACCENT = '#238636';
const ACCENT_BRIGHT = '#2ea043';

/**
 * The dashboard shell. Deliberately server rendered with a small client script that
 * polls /api/stats: it keeps the first paint instant and needs no build step, while
 * the numbers still move while you watch them.
 */
export function renderDashboardHtml({
  oauthConfigured = false,
  signedIn = false,
  role = null,
  baseUrl = '',
  view = 'home',
} = {}) {
  return `<!doctype html>
<html lang="en" data-base="${escapeHtml(baseUrl)}" data-oauth="${oauthConfigured ? '1' : '0'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Asteria, ${VIEWS[view]?.title || VIEWS.home.title}</title>
<meta name="color-scheme" content="dark">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(STAR_FAVICON)}">
<style>${STYLES}</style>
</head>
<body>
<header class="topbar">
  <a class="brand" href="/">
    <span class="mark">${STAR_SVG}</span>
    <span class="brand-text">Asteria<em>live status</em></span>
  </a>
  <div class="topbar-right">
    <button class="btn ghost" type="button" id="about-open">What is this?</button>
    <span class="live" title="refreshes every 5 seconds"><i></i>live</span>
    <span class="uptime-pill" id="uptime-pill"><span class="skel skel-sm"></span></span>
    ${
      signedIn
        ? `<span class="who" id="who">${escapeHtml(role || 'user')}</span>
           <form method="post" action="/logout"><button class="btn ghost" type="submit">Sign out</button></form>`
        : `<a class="btn" href="/login">Sign in with Slack</a>`
    }
  </div>
</header>

${renderTabs(view)}

<main>
${view === 'home' ? homeView() : view === 'j-log' ? jLogView() : view === 'huddles' ? huddlesView() : adminView()}
</main>
<div class="modal hidden" id="channel-modal" role="dialog" aria-modal="true" aria-labelledby="cm-title">
  <div class="modal-scrim" id="cm-scrim"></div>
  <div class="modal-card" id="cm-card"></div>
</div>

<div class="modal hidden" id="about-modal" role="dialog" aria-modal="true" aria-labelledby="about-title">
  <div class="modal-scrim" id="about-scrim"></div>
  <div class="modal-card about-card">
    <div class="cm-head">
      <h2 class="cm-title" id="about-title"><span class="mark">${STAR_SVG}</span><span>What Asteria does</span></h2>
      <button class="cm-close" type="button" id="about-close" aria-label="Close">&#215;</button>
    </div>

    <p class="about-lede">Asteria sits in your Slack channels and keeps score of the huddles that happen in them.
      This page is the window into what it has seen.</p>

    <h3 class="about-h">A huddle is a voice call</h3>
    <p class="about-p">A huddle is Slack's built-in voice chat, the headphones icon in a channel. Anyone can start
      one and anyone can pop in and out. Asteria does not record audio. It only reads the roster Slack already
      publishes: who was in the call, and roughly when.</p>

    <h3 class="about-h">How it keeps track</h3>
    <p class="about-p">When people join or leave, Slack sends Asteria an event. Slack also drops some of those
      events, so a huddle it has not heard from for a minute gets checked directly against Slack for the real
      end time. That is why a duration shown here is measured, and not just "when the bot happened to notice".</p>

    <h3 class="about-h">Where the numbers come from</h3>
    <ul class="about-list">
      <li><b>People seen</b> counts distinct Slack ids ever seen in a huddle the bot could verify, across the channels it is in.</li>
      <li><b>Points</b> reward showing up. A short huddle with six people who stayed beats a long one where two joined and left. Minimum and maximum values are capped so a huddle cannot be farmed by sitting in it.</li>
      <li><b>Channels the bot is in</b> is the only scope. Slack sends the bot huddle events from the whole workspace, so most of what it sees happens in channels it was never in. Those are deliberately left out of every number here.</li>
    </ul>

    <h3 class="about-h">Why the bot sometimes says nothing</h3>
    <p class="about-p">Silence is usually deliberate rather than broken. It does not answer in a channel where
      huddle replies have been switched off, and where only channel managers may trigger it, anyone else asking
      gets a short note saying so rather than being ignored. It will not start a conversation with you unprompted
      either: if a huddle ended with nowhere to ask about it, it stays quiet and records that it did.</p>

    <h3 class="about-h">Getting in</h3>
    <p class="about-p">Sign in with Slack, or DM the bot the word <code>dashboard</code> and it will send you a
      single-use link. There is no password and no account to make.</p>

    <div class="about-foot">
      <a class="btn" href="/health">Service health</a>
      <a class="btn ghost" href="/rss.xml">RSS feed</a>
    </div>
  </div>
</div>

<footer>
  <span>Asteria, <a href="/health">health</a>, <a href="/rss.xml">rss</a></span>
  <span class="muted" id="foot-updated"><span class="skel skel-sm"></span></span>
</footer>

<script>${SCRIPT}
if (document.getElementById('about-modal')) {
  if ('${view}' === 'j-log') { loadJLog(); wireJLog(); }
  else if ('${view}' === 'huddles') { loadHuddles(); wireHuddles(); }
  else if ('${view}' === 'admin') { loadAdmin(); }
}
</script>
</body>
</html>`;
}

function homeView() {
  return `  <section class="hero">
    <p class="kicker">personal channel companion</p>
    <h1>Everything Asteria is doing, <span class="accent">right now</span>.</h1>
    <p class="sub">Huddles it watched, points it handed out, and how long it has been standing by.
      New here? <button class="linkish" type="button" id="about-open-2">What Asteria does</button>.</p>
  </section>

  <section class="stat-strip" id="stat-strip">
    ${statCell('stat-active', 'Huddles live', 'right now')}
    ${statCell('stat-24h', 'Huddles ended', 'last 24 hours')}
    ${statCell('stat-members', 'People seen', 'all time')}
    ${statCell('stat-channels', 'Channels', 'bot is in')}
    ${statCell('stat-score', 'Points awarded', 'on the board')}
  </section>

  <div id="cold-start" class="hidden"></div>

  <div class="grid" id="grid">
    <section class="panel leaderboard">
      <header class="panel-head">
        <h2>Leaderboard</h2>
        <span class="tag" id="lb-scope">channels the bot is in</span>
      </header>
      <div id="opt-in-slot"></div>
      <ol class="board" id="board"><li class="none-slot"><div class="none"><span class="skel" style="width:130px"></span></div></li></ol>
    </section>

    <div class="side">
      <section class="panel">
        <header class="panel-head"><h2>Status</h2><span class="tag" id="state-tag"><span class="skel skel-sm"></span></span></header>
        <dl class="kv">
          <div><dt>Uptime</dt><dd id="kv-uptime"><span class="skel"></span></dd></div>
          <div><dt>Started</dt><dd id="kv-started"><span class="skel"></span></dd></div>
          <div><dt>Longest huddle</dt><dd id="kv-longest"><span class="skel"></span></dd></div>
          <div><dt>Average huddle</dt><dd id="kv-average"><span class="skel"></span></dd></div>
          <div><dt>Opted out</dt><dd id="kv-optedout"><span class="skel"></span></dd></div>
        </dl>
        <div class="spark" id="spark"></div>
      </section>

      <section class="panel">
        <header class="panel-head"><h2>Channels</h2><span class="tag" id="ch-tag"><span class="skel skel-sm"></span></span></header>
        <ul class="channels" id="channels"><li class="none-slot"><div class="none"><span class="skel" style="width:96px"></span></div></li></ul>
      </section>
    </div>
  </div>

  <section class="panel hidden" id="log-panel">
    <header class="panel-head"><h2>Activity</h2><span class="tag">owner only</span></header>
    <ul class="log" id="log"></ul>
  </section>
`;
}

const TABS = [
  { id: 'home', label: 'Dashboard' },
  { id: 'j-log', label: 'j-log manager' },
  { id: 'huddles', label: 'Huddle customisation' },
  { id: 'admin', label: 'Admin panel' },
];

const VIEWS = {
  home: { title: 'live dashboard' },
  'j-log': { title: 'j-log manager' },
  huddles: { title: 'huddle customisation' },
  admin: { title: 'admin panel' },
};

function renderTabs(view) {
  return `<nav class="tabs" aria-label="Sections">
${TABS.map(
  (tab) =>
    `    <a class="tab${tab.id === view ? ' on' : ''}" href="${tab.id === 'home' ? '/' : `/${tab.id}`}"${
      tab.id === view ? ' aria-current="page"' : ''
    }>${tab.id === 'home' ? '<span class="dot"></span>' : ''}${tab.label}</a>`,
).join('\n')}
  </nav>`;
}

function jLogView() {
  return `  <section class="hero">
    <p class="kicker">j-log manager</p>
    <h1>The daily <span class="accent">standup</span> channel, on rails.</h1>
    <p class="sub">Draft the update, set the question that goes out each morning, and check what has already
      been sent. Saving here changes what the bot posts; it does not post anything until you send it.</p>
  </section>

  <div class="grid">
    <section class="panel">
      <header class="panel-head"><h2>Daily update</h2><span class="tag" id="draft-tag">draft</span></header>
      <div class="form">
        <div class="field">
          <label for="f-main">Main update</label>
          <textarea id="f-main" rows="7" placeholder="What happened?"></textarea>
          <span class="hint">Posted to the channel at the send time below.</span>
        </div>
        <div class="field">
          <label for="f-song">Song</label>
          <input type="text" id="f-song" placeholder="Song of the day">
        </div>
        <div class="field">
          <label for="f-event">Event</label>
          <input type="text" id="f-event" placeholder="Anything coming up">
        </div>
        <div class="row-actions">
          <button class="btn" type="button" id="draft-save">Save draft</button>
          <button class="btn ghost" type="button" id="draft-clear">Clear</button>
          <span class="saved" id="draft-saved">saved</span>
        </div>
      </div>
    </section>

    <div class="side">
      <section class="panel">
        <header class="panel-head"><h2>Daily question</h2></header>
        <div class="form">
          <div class="switchrow">
            <div><div class="t">Ask a question each morning</div><div class="d">Posted at the time set below.</div></div>
            <label class="switch"><input type="checkbox" id="q-enabled"><i></i></label>
          </div>
          <div class="field">
            <label for="q-time">Send time</label>
            <input type="time" id="q-time" value="09:00">
          </div>
          <div class="field">
            <label for="q-prompt">Prompt handed to the generator</label>
            <textarea id="q-prompt" rows="4"></textarea>
            <span class="hint">Asteria writes the question itself from this.</span>
          </div>
          <div class="field">
            <label for="q-reply">Reply nudge</label>
            <input type="text" id="q-reply" placeholder="Reply to this message in a thread!">
          </div>
          <div class="switchrow">
            <div><div class="t">Fold it into the daily update</div><div class="d">One post instead of two.</div></div>
            <label class="switch"><input type="checkbox" id="q-include"><i></i></label>
          </div>
          <div class="row-actions">
            <button class="btn" type="button" id="q-save">Save question settings</button>
            <span class="saved" id="q-saved">saved</span>
          </div>
        </div>
      </section>

      <section class="panel">
        <header class="panel-head"><h2>Reminder</h2></header>
        <div class="form">
          <div class="switchrow">
            <div><div class="t">Nudge the channel</div><div class="d">If the update has not gone out yet.</div></div>
            <label class="switch"><input type="checkbox" id="r-enabled"><i></i></label>
          </div>
          <div class="field">
            <label for="r-time">Reminder time</label>
            <input type="time" id="r-time" value="17:00">
          </div>
          <div class="switchrow">
            <div><div class="t">Reply in a thread</div><div class="d">Keeps the channel readable.</div></div>
            <label class="switch"><input type="checkbox" id="r-thread"><i></i></label>
          </div>
          <div class="row-actions">
            <button class="btn" type="button" id="r-save">Save reminder</button>
            <span class="saved" id="r-saved">saved</span>
          </div>
        </div>
      </section>

      <section class="panel">
        <header class="panel-head"><h2>Recent questions</h2><span class="tag">last 5</span></header>
        <ul class="log" id="q-history"><li class="none-slot"><div class="none"><span class="skel" style="width:120px"></span></div></li></ul>
      </section>
    </div>
  </div>`;
}

function huddlesView() {
  return `  <section class="hero">
    <p class="kicker">huddle customisation</p>
    <h1>How Asteria behaves, <span class="accent">per channel</span>.</h1>
    <p class="sub">Turn tracking off to stop the announcements, reviews and points for a channel without
      muting the bot itself, or restrict it so only the managers below can ask it something.</p>
  </section>

  <div class="warnrow" id="unconfigured-note" hidden>
    <span class="ic">!</span>
    <span><b id="unconfigured-text"></b></span>
  </div>

  <section class="panel" style="margin-top:14px">
    <header class="panel-head"><h2>Channels</h2><span class="tag" id="hc-tag"><span class="skel skel-sm"></span></span></header>
    <div class="cardlist" id="hc-list">
      <div class="cardrow"><span class="skel" style="width:180px"></span></div>
    </div>
  </section>`;
}

function adminView() {
  return `  <section class="hero">
    <p class="kicker">admin panel</p>
    <h1>What the bot can <span class="accent">actually see</span>.</h1>
    <p class="sub">Owner only. This is the honest state of the integration: which channels it is in, what
      Slack will not tell it, and the huddles it recorded but could never place.</p>
  </section>

  <div class="grid">
    <section class="panel">
      <header class="panel-head"><h2>Slack permissions</h2><span class="tag">live</span></header>
      <div class="cardlist" id="scope-list">
        <div class="cardrow"><span class="skel" style="width:200px"></span></div>
      </div>
    </section>

    <div class="side">
      <section class="panel">
        <header class="panel-head"><h2>Unplaceable huddles</h2><span class="tag" id="orphan-tag">owner only</span></header>
        <p class="emptynote" id="orphan-note">Loading.</p>
        <dl class="kvlist" id="orphan-kv"></dl>
      </section>
      <section class="panel">
        <header class="panel-head"><h2>Bot membership</h2></header>
        <dl class="kvlist" id="member-kv"></dl>
      </section>
    </div>
  </div>`;
}

function statCell(id, label, hint) {
  return `<div class="stat">
  <p class="stat-label">${escapeHtml(label)}</p>
  <p class="stat-value" id="${id}"><span class="skel skel-lg"></span></p>
  <p class="stat-hint">${escapeHtml(hint)}</p>
</div>`;
}

const STAR_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.2l2.1 4.6 5 .6-3.7 3.4 1 4.9L12 14.4 7.6 16.7l1-4.9L4.9 8.4l5-.6z"/></svg>`;
const STAR_FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="#0d1117"/><path d="M12 4l2 4.4 4.8.6-3.6 3.3.95 4.7L12 14.7 7.85 17l.95-4.7L5.2 9l4.8-.6z" fill="none" stroke="#2ea043" stroke-width="1.5"/></svg>`;

const STYLES = `
:root{color-scheme:dark;
  --bg:#0d1117; --surface:#161b22; --raised:#21262d; --line:#30363d; --line-soft:#21262d;
  --ink:#f0f6fc; --ink-2:#c9d1d9; --ink-3:#8b949e;
  --accent:${ACCENT}; --accent-bright:${ACCENT_BRIGHT};
  --gold:#ffd700; --bronze:#cd7f32; --silver:#c0c0c0; --red:#f85149;
  --r:10px; --r-sm:6px;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0; min-height:100vh; color:var(--ink); font-family:var(--sans); font-size:15px; line-height:1.5;
  background:radial-gradient(900px 400px at 50% -8%, rgba(46,160,67,.07), transparent 70%),var(--bg);
  -webkit-font-smoothing:antialiased;
}
a{color:var(--accent-bright);text-decoration:none}
a:hover{text-decoration:underline}
.hidden{display:none !important}
.muted{color:var(--ink-3)}

/* top bar */
.topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;
  padding:0 clamp(16px,4vw,36px);height:56px;background:rgba(13,17,23,.86);
  backdrop-filter:saturate(140%) blur(10px);border-bottom:1px solid var(--line);
  position:sticky;top:0;z-index:2}
.brand{display:flex;align-items:center;gap:9px;color:var(--ink);font-weight:600;letter-spacing:-.01em}
.brand:hover{text-decoration:none}
.mark{display:grid;place-items:center;width:28px;height:28px;border-radius:var(--r-sm);color:var(--accent-bright);
  background:var(--surface);box-shadow:0 0 0 1px var(--line)}
.brand-text{display:flex;flex-direction:column;line-height:1.2}
.brand-text em{font-style:normal;font-size:9.5px;letter-spacing:.15em;text-transform:uppercase;color:var(--ink-3)}
.topbar-right{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.live{display:inline-flex;align-items:center;gap:6px;font-size:10px;letter-spacing:.14em;text-transform:uppercase;
  color:var(--ink-2);padding:4px 9px;border-radius:999px;box-shadow:0 0 0 1px var(--line)}
.live i{width:5px;height:5px;border-radius:50%;background:var(--accent-bright);animation:pulse 2.4s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.uptime-pill,.who{font-family:var(--mono);font-size:11.5px;color:var(--ink-2);padding:4px 9px;
  border-radius:999px;box-shadow:0 0 0 1px var(--line);min-width:52px;display:inline-flex;align-items:center;gap:6px}
.who{color:var(--accent-bright);box-shadow:0 0 0 1px rgba(46,160,67,.35)}
.btn{display:inline-flex;align-items:center;font:inherit;font-size:13px;font-weight:600;color:#fff;
  background:var(--accent);border:0;border-radius:var(--r-sm);padding:7px 14px;cursor:pointer;transition:.14s ease}
.btn:hover{background:var(--accent-bright);text-decoration:none}
.btn:active{transform:translateY(1px)}
.btn.ghost{background:transparent;color:var(--ink-2);box-shadow:0 0 0 1px var(--line)}
.btn.ghost:hover{color:var(--ink);background:var(--raised)}

main{max-width:1180px;margin:0 auto;padding:clamp(26px,4vw,44px) clamp(16px,4vw,36px) 56px}

/* hero */
.hero{max-width:680px;margin-bottom:24px}
.kicker{margin:0 0 10px;font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--accent-bright);font-weight:600}
h1{margin:0 0 9px;font-size:clamp(26px,4.2vw,42px);line-height:1.08;letter-spacing:-.028em;font-weight:650}
h1 .accent{color:var(--accent-bright)}
.sub{margin:0;color:var(--ink-3);font-size:15px;max-width:56ch}

/* stat strip */
.stat-strip{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));background:var(--surface);
  border-radius:var(--r);box-shadow:0 0 0 1px var(--line);margin-bottom:18px;overflow:hidden}
@media (max-width:860px){.stat-strip{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:460px){.stat-strip{grid-template-columns:1fr}}
.stat{position:relative;padding:13px 15px 12px}
.stat+.stat{box-shadow:inset 1px 0 0 var(--line)}
.stat::before{content:"";position:absolute;top:0;left:0;right:0;height:1px;
  background:linear-gradient(90deg,transparent,rgba(46,160,67,.5),transparent);opacity:.55}
.stat-label{margin:0;font-size:10px;letter-spacing:.11em;text-transform:uppercase;color:var(--ink-3);font-weight:600}
.stat-value{margin:7px 0 1px;font-family:var(--mono);font-size:27px;line-height:1;font-variant-numeric:tabular-nums;
  letter-spacing:-.02em;transition:color .3s}
.stat-value.bump{color:var(--accent-bright)}
.stat-hint{margin:0;font-size:11px;color:var(--ink-3)}

/* layout */
.grid{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:16px;align-items:start}
@media (max-width:940px){.grid{grid-template-columns:1fr}}
.panel{background:var(--surface);border-radius:var(--r);box-shadow:0 0 0 1px var(--line);
  padding:15px 16px 16px;margin-bottom:16px}
.panel-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:13px}
.panel-head h2{margin:0;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-2);font-weight:700}
.tag{font-family:var(--mono);font-size:10.5px;color:var(--ink-3);border-radius:999px;padding:3px 8px;
  box-shadow:0 0 0 1px var(--line-soft);white-space:nowrap;display:inline-flex;align-items:center;gap:6px;min-height:20px}
.tag.ok{color:var(--accent-bright);box-shadow:0 0 0 1px rgba(46,160,67,.35)}

/* leaderboard */
.board{list-style:none;margin:0;padding:0}
.board li{display:grid;grid-template-columns:24px 28px minmax(0,1fr) auto;align-items:center;gap:11px;
  padding:7px 9px;border-radius:var(--r-sm);box-shadow:0 0 0 1px transparent}
.board li+li{margin-top:2px}
.board li:hover{background:var(--raised)}
.board li.me{background:rgba(46,160,67,.09);box-shadow:0 0 0 1px rgba(46,160,67,.4)}
.rank{font-family:var(--mono);font-size:12px;color:var(--ink-3);text-align:right}
.board li:nth-child(1) .rank{color:var(--gold);font-weight:700}
.board li:nth-child(2) .rank{color:var(--bronze);font-weight:700}
.board li:nth-child(3) .rank{color:var(--silver);font-weight:700}
.avatar{width:28px;height:28px;border-radius:var(--r-sm);object-fit:cover;background:var(--raised);
  box-shadow:0 0 0 1px var(--line);display:grid;place-items:center;font-size:10.5px;font-weight:700;color:var(--ink-3)}
.who-cell{display:flex;flex-direction:column;min-width:0}
.who-name-row{display:flex;align-items:center;gap:6px;min-width:0}
.who-name{font-size:14px;font-weight:520;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.who-sub{font-size:11.5px;color:var(--ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.avatar-hidden{background:var(--raised);border:1px dashed var(--line);color:transparent}
.pts{font-family:var(--mono);font-size:14px;font-variant-numeric:tabular-nums}
.pts.zero{color:var(--ink-3)}

/* empty states, the whole point of a quiet design */
.none{display:grid;justify-items:center;gap:3px;padding:22px 16px;text-align:center;
  border-radius:var(--r-sm);box-shadow:0 0 0 1px var(--line-soft)}
.none-mark{display:grid;place-items:center;width:26px;height:26px;border-radius:var(--r-sm);color:var(--ink-3);
  background:var(--raised);box-shadow:0 0 0 1px var(--line);margin-bottom:5px}
.none-title{margin:0;font-size:13px;font-weight:600;color:var(--ink-2)}
.none-hint{margin:0;font-size:12px;color:var(--ink-3);max-width:34ch}
.none-slot{padding:0;list-style:none;display:block !important}
.log li.none-slot,.board li.none-slot,.channels li.none-slot{grid-template-columns:none;background:none}
.placeholder{color:var(--ink-3);font-style:normal}

/* loading skeletons, so nothing ever shows a bare dash */
.skel{display:inline-block;width:100%;height:11px;border-radius:3px;
  background:linear-gradient(90deg,var(--raised),#2b3138,var(--raised));background-size:200% 100%;
  animation:shimmer 1.5s linear infinite}
.skel-sm{width:44px;height:9px}
.skel-lg{width:52px;height:22px}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}

/* cold start, when the bot has literally nothing yet */
.cold{display:grid;justify-items:center;gap:9px;text-align:center;padding:52px 20px;background:var(--surface);
  border-radius:var(--r);box-shadow:0 0 0 1px var(--line)}
.cold h2{margin:0;font-size:19px;letter-spacing:-.01em}
.cold p{margin:0;color:var(--ink-3);max-width:46ch;font-size:14px}
.cold .none-mark{width:38px;height:38px;margin-bottom:2px}

/* opt-in switch */
.optin{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:13px;
  padding:10px 12px;border-radius:var(--r-sm);background:rgba(46,160,67,.07);box-shadow:0 0 0 1px rgba(46,160,67,.25)}
.optin-text{display:flex;flex-direction:column}
.optin-text b{font-size:13.5px;font-weight:600}
.optin-text span{font-size:11.5px;color:var(--ink-3)}
.switch{position:relative;width:44px;height:25px;border-radius:999px;background:var(--raised);border:0;
  box-shadow:0 0 0 1px var(--line);cursor:pointer;transition:.18s;flex:none}
.switch::after{content:"";position:absolute;top:3px;left:3px;width:19px;height:19px;border-radius:50%;
  background:var(--ink-3);transition:.18s}
.switch[aria-checked="true"]{background:rgba(46,160,67,.28);box-shadow:0 0 0 1px rgba(46,160,67,.6)}
.switch[aria-checked="true"]::after{left:22px;background:var(--accent-bright)}

/* kv list */
.kv{margin:0;display:grid;gap:1px;background:var(--line-soft);border-radius:var(--r-sm);overflow:hidden;
  box-shadow:0 0 0 1px var(--line-soft)}
.kv>div{display:flex;justify-content:space-between;align-items:center;gap:10px;background:var(--surface);padding:8px 11px}
.kv dt{font-size:12.5px;color:var(--ink-2)}
.kv dd{margin:0;font-family:var(--mono);font-size:12.5px;font-variant-numeric:tabular-nums;text-align:right}
.kv dd .placeholder{font-family:var(--sans);font-size:12px}
.spark{display:flex;align-items:flex-end;gap:3px;height:40px;margin-top:13px}
.spark i{flex:1;background:linear-gradient(180deg,rgba(46,160,67,.85),rgba(46,160,67,.16));border-radius:2px 2px 0 0;min-height:2px}
.spark-empty{margin-top:13px}

/* channels */
.channels{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.channels li{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;
  background:var(--raised);border-radius:var(--r-sm);font-size:13.5px}
.channels .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* The row opens a popup rather than leaving the site, so it is a button but
   still reads as the blue link the channel name has always been. */
.chan-open{background:none;border:0;padding:0;font:inherit;color:var(--accent-bright);cursor:pointer;
  text-align:left;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}
.chan-open:hover{text-decoration:underline}
.chan-open:focus-visible{outline:2px solid var(--accent-bright);outline-offset:2px;border-radius:3px}
.dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--ink-3);box-shadow:0 0 0 2px rgba(139,148,158,.16)}
.dot.on{background:var(--accent-bright);box-shadow:0 0 0 2px rgba(46,160,67,.2)}
.dot.paused{background:var(--gold)}

/* channel popup */
.modal{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:20px}
.modal.hidden{display:none}
.modal-scrim{position:absolute;inset:0;background:rgba(1,4,9,.72);backdrop-filter:blur(2px)}
.modal-card{position:relative;width:min(560px,100%);max-height:86vh;overflow-y:auto;background:var(--surface);
  border-radius:var(--r-lg);box-shadow:0 0 0 1px var(--line),0 24px 60px rgba(1,4,9,.6);padding:20px}
.cm-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:16px}
.cm-title{font-size:19px;font-weight:640;letter-spacing:-.01em;display:flex;align-items:center;gap:8px;min-width:0}
.cm-title span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cm-close{background:none;border:0;color:var(--ink-3);cursor:pointer;font-size:20px;line-height:1;padding:2px 6px;border-radius:6px}
.cm-close:hover{color:var(--ink);background:var(--raised)}
.cm-sub{color:var(--ink-3);font-size:12.5px;margin-top:5px}
.cm-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:1px;background:var(--line-soft);
  border-radius:var(--r-sm);overflow:hidden;margin-bottom:16px}
.cm-stat{background:var(--raised);padding:10px 12px}
.cm-stat b{display:block;font-size:16px;font-weight:620;letter-spacing:-.01em}
.cm-stat span{display:block;font-size:11px;color:var(--ink-3);text-transform:uppercase;letter-spacing:.06em;margin-top:3px}
.cm-label{font-size:11px;color:var(--ink-3);text-transform:uppercase;letter-spacing:.06em;margin:16px 0 8px}
.cm-managers{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.cm-managers li{display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--raised);border-radius:var(--r-sm)}
.cm-managers .avatar{width:30px;height:30px;border-radius:8px;object-fit:cover;flex:none;background:var(--line-soft)}
.cm-who{min-width:0;flex:1}
.cm-who b{display:block;font-size:13.5px;font-weight:560;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cm-who span{display:block;font-size:11.5px;color:var(--ink-3)}
.cm-note{font-size:12.5px;color:var(--ink-3);margin-top:10px}
.tag-cm{font-size:9.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:2px 5px;border-radius:4px;
  background:rgba(88,166,255,.16);color:var(--accent-bright);box-shadow:0 0 0 1px rgba(88,166,255,.28);flex:none}

/* activity log */
.log{list-style:none;margin:0;padding:0;display:grid;gap:1px;background:var(--line-soft);
  border-radius:var(--r-sm);overflow:hidden;max-height:340px;overflow-y:auto;box-shadow:0 0 0 1px var(--line-soft)}
.log li{display:grid;grid-template-columns:74px 128px minmax(0,1fr);gap:10px;background:var(--surface);
  padding:7px 10px;font-size:12.5px;align-items:baseline}
.log time{font-family:var(--mono);font-size:11.5px;color:var(--ink-3)}
.log .act{font-family:var(--mono);font-size:11.5px;color:var(--accent-bright);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.log .det{color:var(--ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

footer{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;
  max-width:1180px;margin:0 auto;padding:16px clamp(16px,4vw,36px) 32px;
  border-top:1px solid var(--line);font-size:12.5px;color:var(--ink-3)}
@media (prefers-reduced-motion:reduce){*{animation:none !important;transition:none !important}}

/* inline text button, reads as a link but behaves as a button */
.linkish{background:none;border:0;padding:0;font:inherit;color:var(--accent-bright);cursor:pointer;
  text-decoration:underline;text-underline-offset:2px}
.linkish:hover{color:var(--ink)}

/* tab bar */
.tabs{display:flex;gap:2px;max-width:1180px;margin:0 auto;padding:0 clamp(16px,4vw,36px);
  border-bottom:1px solid var(--line);overflow-x:auto;scrollbar-width:none}
.tabs::-webkit-scrollbar{display:none}
.tab{display:inline-flex;align-items:center;gap:7px;flex:0 0 auto;padding:11px 14px;
  font-size:13px;font-weight:600;color:var(--ink-3);background:none;border:0;border-bottom:2px solid transparent;
  cursor:pointer;text-decoration:none;margin-bottom:-1px;white-space:nowrap}
.tab:hover{color:var(--ink);text-decoration:none;background:var(--surface)}
.tab.on{color:var(--ink);border-bottom-color:var(--accent-bright)}
.tab .dot{width:5px;height:5px;border-radius:50%;background:var(--accent-bright);flex:0 0 auto}

/* explainer modal */
.about-card{width:min(640px,100%)}
.about-lede{color:var(--ink-2);font-size:14.5px;margin:0 0 18px}
.about-h{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-2);font-weight:700;
  margin:20px 0 7px}
.about-h:first-of-type{margin-top:0}
.about-p{color:var(--ink-3);font-size:13.5px;margin:0}
.about-list{margin:0;padding-left:18px;color:var(--ink-3);font-size:13.5px}
.about-list li{margin-bottom:7px}
.about-list b{color:var(--ink-2)}
.about-card code{font-family:var(--mono);font-size:12px;background:var(--raised);
  border-radius:4px;padding:1px 5px;color:var(--ink-2)}
.about-foot{display:flex;gap:8px;flex-wrap:wrap;margin-top:22px;padding-top:16px;border-top:1px solid var(--line-soft)}

/* settings pages */
.form{display:grid;gap:14px}
.field{display:grid;gap:5px}
.field label{font-size:12px;font-weight:600;color:var(--ink-2)}
.field .hint{font-size:11.5px;color:var(--ink-3);line-height:1.45}
.field input[type=text],.field input[type=time],.field input[type=number],.field textarea,.field select{
  font:inherit;font-size:13.5px;color:var(--ink);background:var(--bg);border:1px solid var(--line);
  border-radius:var(--r-sm);padding:8px 10px;width:100%}
.field textarea{font-family:var(--mono);font-size:12.5px;line-height:1.5;resize:vertical;min-height:76px}
.field input:focus,.field textarea:focus,.field select:focus{outline:none;border-color:var(--accent)}
.switchrow{display:flex;align-items:center;justify-content:space-between;gap:14px;
  padding:11px 13px;background:var(--raised);border-radius:var(--r-sm)}
.switchrow .t{font-size:13.5px;font-weight:600}
.switchrow .d{font-size:11.5px;color:var(--ink-3);margin-top:2px}
.switch{position:relative;width:38px;height:22px;flex:0 0 auto}
.switch input{position:absolute;inset:0;opacity:0;margin:0;cursor:pointer}
.switch i{position:absolute;inset:0;background:var(--line);border-radius:999px;transition:background .15s;
  pointer-events:none}
.switch i::after{content:'';position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;
  background:#fff;transition:transform .15s}
.switch input:checked+i{background:var(--accent)}
.switch input:checked+i::after{transform:translateX(16px)}
.switch input:focus-visible+i{box-shadow:0 0 0 3px rgba(46,160,67,.35)}
.row-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:4px}
.saved{font-size:12px;color:var(--accent-bright);opacity:0;transition:opacity .2s}
.saved.on{opacity:1}
.cardlist{display:grid;gap:10px}
.cardrow{background:var(--raised);border-radius:var(--r-sm);padding:13px}
.cardrow .hd{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:3px}
.cardrow .nm{font-size:14px;font-weight:620;display:flex;align-items:center;gap:7px;min-width:0}
.cardrow .nm span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cardrow .id{font-family:var(--mono);font-size:11px;color:var(--ink-3)}
.cardrow .grid2{display:grid;gap:8px;margin-top:11px}
.owners{display:flex;gap:6px;flex-wrap:wrap;margin-top:9px}
.ownerchip{display:inline-flex;align-items:center;gap:6px;background:var(--surface);
  border-radius:999px;padding:3px 5px 3px 3px;font-size:11.5px}
.ownerchip img{width:18px;height:18px;border-radius:50%}
.ownerchip button{background:none;border:0;color:var(--ink-3);cursor:pointer;padding:0 3px;font:inherit;line-height:1}
.ownerchip button:hover{color:var(--red)}
.emptynote{color:var(--ink-3);font-size:13px;padding:4px 0}
.kvlist{display:grid;gap:1px;background:var(--line-soft);border-radius:var(--r-sm);overflow:hidden}
.kvlist>div{display:flex;justify-content:space-between;gap:14px;background:var(--raised);padding:10px 13px;font-size:13px}
.kvlist dt,.kvlist .k{color:var(--ink-3)}
.kvlist .v{font-family:var(--mono);font-size:12.5px;text-align:right;word-break:break-word}
.warnrow{display:flex;gap:9px;align-items:flex-start;background:rgba(248,81,73,.08);
  box-shadow:0 0 0 1px rgba(248,81,73,.25);border-radius:var(--r-sm);padding:11px 13px;
  font-size:12.5px;color:var(--ink-2);line-height:1.5}
.warnrow b{color:var(--ink)}
.warnrow .ic{color:var(--red);flex:0 0 auto;font-weight:700}
`;

// NOTE: this is a server side template literal, so any dollar-brace inside it is
// interpolated before the browser sees it. Client code here must build strings
// with concatenation, not template literals. A stray one throws at import time.
const SCRIPT = `
const $ = (id) => document.getElementById(id);
const base = document.documentElement.dataset.base || '';
const fmt = new Intl.NumberFormat();
const STAR_MARK = '${STAR_SVG}';
let viewer = null, first = true, teamId = '';

/** Huddle lengths, as "1h 04m" or "12m 30s". */
function fmtDuration(seconds){
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return h + 'h ' + String(m).padStart(2, '0') + 'm';
  if (m) return m + 'm ' + String(s).padStart(2, '0') + 's';
  return s + 's';
}

const NONE_MARK = '<span class="none-mark">' + STAR_MARK + '</span>';
function none(title, hint){
  return '<div class="none">' + NONE_MARK +
    '<p class="none-title">' + title + '</p>' +
    '<p class="none-hint">' + hint + '</p></div>';
}
function cold(title, body){
  const slot = $('cold-start');
  slot.classList.remove('hidden');
  slot.innerHTML = '<div class="cold">' + NONE_MARK + '<h2>' + title + '</h2><p>' + body + '</p></div>';
  $('stat-strip').classList.add('hidden');
  $('grid').classList.add('hidden');
}
function duration(seconds){
  const s = Math.max(0, Math.floor(seconds || 0));
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  if (d) return d + 'd ' + h + 'h';
  if (h) return h + 'h ' + m + 'm';
  if (m) return m + 'm ' + (s % 60) + 's';
  return s + 's';
}
function initials(text){
  return (text || '?').trim().split(/\\s+/).slice(0,2).map((w) => w[0]).join('').toUpperCase();
}
function setValue(id, value){
  const node = $(id);
  if (!node) return;
  const text = String(value);
  if (node.textContent === text) return;
  node.textContent = text;
  if (first) return;
  node.classList.add('bump');
  setTimeout(() => node.classList.remove('bump'), 700);
}
function setField(id, value, placeholder){
  const node = $(id);
  if (!node) return;
  node.textContent = value == null || value === '' ? '' : String(value);
  if (!node.textContent) node.innerHTML = '<span class="placeholder">' + placeholder + '</span>';
}

/**
 * Board rows are patched in place rather than re-rendered. Replacing the list's
 * HTML on every 5s poll threw away each <img> and made every avatar flash and
 * re-download, and a rank change used to look like a full page refresh. Rows are
 * keyed by user id and re-ordered with appendChild, which moves the existing
 * nodes (and their loaded images) instead of recreating them.
 */
let boardRows = new Map();
let channelData = [];

function slackProfileUrl(userId){
  if (!userId || !teamId) return '';
  return 'slack://user?team=' + encodeURIComponent(teamId) + '&id=' + encodeURIComponent(userId);
}

function avatarNode(row, name){
  if (row.anonymised){
    const span = document.createElement('span');
    span.className = 'avatar avatar-hidden';
    span.title = 'Hidden until you sign in';
    return span;
  }
  if (row.imageUrl){
    const img = document.createElement('img');
    img.className = 'avatar';
    img.alt = '';
    img.loading = 'lazy';
    img.src = row.imageUrl;
    img.addEventListener('error', function(){
      const fallback = document.createElement('span');
      fallback.className = 'avatar';
      fallback.textContent = initials(name);
      this.replaceWith(fallback);
    });
    return img;
  }
  const fallback = document.createElement('span');
  fallback.className = 'avatar';
  fallback.textContent = initials(name);
  return fallback;
}

function boardRow(row, viewer, existing){
  // An anonymous row has no name, so there is nothing to take initials from and
  // "Member 3" would put a meaningless "M3" in the avatar circle.
  const name = row.displayName || row.userId || '';
  const sub = row.anonymised
    ? 'sign in to see who this is'
    : [row.pronouns, row.realName && row.realName !== name ? row.realName : ''].filter(Boolean).join(' / ');
  const node = existing ? existing.li : document.createElement('li');
  if (!existing){
    node.innerHTML = '<span class="rank"></span><span class="who-cell">' +
      '<span class="who-name-row"><span class="who-name"></span></span><span class="who-sub"></span></span>' +
      '<span class="pts"></span>';
    node.insertBefore(avatarNode(row, name), node.querySelector('.who-cell'));
  } else if (existing.imageUrl !== row.imageUrl){
    // A profile that resolves after the first paint still gets its picture, and
    // one that disappears falls back without touching the rest of the row.
    const current = node.querySelector('.avatar');
    if (current && (current.tagName !== 'IMG' || current.getAttribute('src') !== row.imageUrl)){
      current.replaceWith(avatarNode(row, name));
    }
  }
  node.classList.toggle('me', Boolean(viewer && viewer.userId === row.userId));
  node.querySelector('.rank').textContent = String(row.rank);

  // Everything is addressed by class, never by position: the CM tag is inserted
  // and removed as manager status changes, which must not renumber anything.
  const whoCell = node.querySelector('.who-cell');
  const nameRow = whoCell.querySelector('.who-name-row');
  const cmTag = nameRow.querySelector('.tag-cm');
  if (row.channelManager && !cmTag){
    const tag = document.createElement('span');
    tag.className = 'tag-cm';
    tag.textContent = 'CM';
    tag.title = 'Channel manager';
    nameRow.appendChild(tag);
  } else if (!row.channelManager && cmTag){
    cmTag.remove();
  }

  const href = slackProfileUrl(row.userId);
  let whoName = nameRow.querySelector('.who-name');
  // A blank name reads as a loading failure. An anonymous row gets the rank as
  // its label and one honest line underneath, so the board looks deliberate.
  // Concatenation, not a template literal: this whole block lives inside a
  // server side template literal, so a dollar-brace here is interpolated before
  // it ships and breaks the file.
  const label = row.anonymised ? '#' + row.rank : name;
  if (href && whoName.tagName !== 'A'){
    const link = document.createElement('a');
    link.className = 'who-name';
    link.textContent = whoName.textContent;
    whoName.parentNode.replaceChild(link, whoName);
    whoName = link;
  }
  if (whoName.textContent !== label) {
    whoName.textContent = label;
  }
  if (href && whoName.getAttribute('href') !== href) {
    whoName.setAttribute('href', href);
  }
  const whoSub = whoCell.querySelector('.who-sub');
  whoSub.textContent = sub;
  whoSub.classList.toggle('hidden', !sub);
  const pts = node.querySelector('.pts');
  pts.textContent = fmt.format(row.points);
  pts.classList.toggle('zero', !row.points);
  return node;
}

function renderBoard(rows, viewer){
  const board = $('board');
  if (!rows.length){
    if (boardRows.size){
      boardRows = new Map();
      const everyoneHidden = viewer && viewer.signedIn && viewer.isOwner;
      board.innerHTML = '<li class="none-slot">' + none(
        'No points on the board',
        everyoneHidden
          ? 'Nobody has opted in to the leaderboard yet.'
          : 'Points appear once the bot is in a tracked channel and someone joins a huddle.'
      ) + '</li>';
    }
    return;
  }
  if (board.querySelector('.none-slot')){
    board.innerHTML = '';
    boardRows = new Map();
  }
  const next = new Map();
  rows.forEach((row) => {
    const key = row.key || row.userId;
    const existing = boardRows.get(key);
    const li = boardRow(row, viewer, existing);
    next.set(key, { li: li, userId: row.userId, imageUrl: row.imageUrl });

    board.appendChild(li);
  });
  for (const [key, entry] of boardRows){
    if (!next.has(key)) entry.li.remove();
  }
  boardRows = next;
}

function renderOptIn(){
  const slot = $('opt-in-slot');
  if (!viewer || !viewer.signedIn) { slot.innerHTML = ''; return; }
  slot.innerHTML = '<div class="optin"><span class="optin-text"><b>On the leaderboard</b>' +
    '<span>' + (viewer.role === 'owner' ? 'You see everything, yours or not' : 'Turn this off to hide your points') + '</span></span>' +
    '<button class="switch" id="optin-switch" role="switch" aria-checked="' + viewer.leaderboardOptIn + '" aria-label="Show me on the leaderboard"></button></div>';
  $('optin-switch').addEventListener('click', toggleOptIn);
}

async function toggleOptIn(){
  const button = $('optin-switch');
  const next = button.getAttribute('aria-checked') !== 'true';
  button.setAttribute('aria-checked', String(next));
  const response = await fetch(base + '/api/me/opt-in', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ optedIn: next }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok){
    button.setAttribute('aria-checked', String(!next));
    return;
  }
  viewer.leaderboardOptIn = body.leaderboardOptIn;
  refresh();
}

function renderChannels(channels, botCount){
  const list = $('channels');
  $('ch-tag').textContent = botCount + ' in bot';
  // Kept so the popup can read the same numbers without another round trip.
  channelData = channels || [];
  if (!channelData.length){
    list.innerHTML = '<li class="none-slot">' + none('No channels yet', 'Add Asteria to a channel and it shows up here.') + '</li>';
    return;
  }
  list.innerHTML = channelData.map((channel) => {
    const cls = channel.paused ? 'paused' : (channel.enabled ? 'on' : '');
    const state = channel.paused ? 'paused' : (channel.enabled ? 'tracking' : 'off');
    return '<li><span class="name"><button class="chan-open" data-channel="' + escapeHtml(channel.id) + '">' +
      escapeHtml(channel.name) + '</button>' + (channel.inBot ? '' : ' <span class="muted">not in bot</span>') + '</span>' +
      '<span class="tag' + (channel.enabled ? ' ok' : '') + '"><i class="dot ' + cls + '"></i>' + state + '</span></li>';
  }).join('');
}

/** The channel popup: huddle totals, then who runs it. */
function openChannelModal(id){
  const channel = channelData.find((entry) => entry.id === id);
  const modal = $('channel-modal');
  if (!channel || !modal) return;
  const stats = channel.stats || {};
  const members = channel.flaron || {};
  const source = members.source === 'flaron'
    ? 'Flaron'
    : members.source === 'slack' ? 'Slack' : 'Unknown';
  const card = $('cm-card');
  const managers = channel.managers || [];
  const managerHtml = managers.length
    ? managers.map((manager) => {
        const label = manager.realName && manager.realName !== manager.displayName
          ? manager.displayName + ' (' + manager.realName + ')'
          : manager.displayName;
        const standing = manager.rank
          ? 'Rank ' + manager.rank + ' / ' + fmt.format(manager.points || 0) + ' pts'
          : 'Not on the leaderboard';
        const img = manager.imageUrl
          ? '<img class="avatar" src="' + escapeHtml(manager.imageUrl) + '" alt="">'
          : '<span class="avatar">' + escapeHtml(initials(manager.displayName)) + '</span>';
        return '<li>' + img + '<span class="cm-who"><b>' + escapeHtml(label) + '</b>' +
          '<span>' + escapeHtml([manager.pronouns, standing].filter(Boolean).join(' / ')) + '</span></span>' +
          '<span class="tag-cm">CM</span></li>';
      }).join('')
    : '<li class="none">' + none('No manager found', 'Flaron does not describe private channels yet.') + '</li>';
  card.innerHTML = '<div class="cm-head"><div><div class="cm-title" id="cm-title"><span>' +
      escapeHtml(channel.name) + '</span><span class="tag' + (channel.enabled ? ' ok' : '') + '">' +
      (channel.paused ? 'paused' : channel.enabled ? 'tracking' : 'off') + '</span></div>' +
      '<div class="cm-sub">' + escapeHtml([
        members.members != null ? fmt.format(members.members) + ' members' : 'Size unknown',
        members.humans != null ? members.humans + ' human' + (members.humans === 1 ? '' : 's') : '',
        members.bots != null ? members.bots + ' bot' + (members.bots === 1 ? '' : 's') : '',
        'size from ' + source,
      ].filter(Boolean).join(' / ')) + '</div></div>' +
      '<button class="cm-close" id="cm-close" aria-label="Close">&times;</button></div>' +
    '<div class="cm-stats">' + [
      ['Huddles', stats.total || 0],
      ['Active', stats.active || 0],
      ['Ended', stats.ended || 0],
      ['Last 24h', stats.last24h || 0],
      ['Members seen', stats.members || 0],
      ['Avg length', stats.averageSeconds ? fmtDuration(stats.averageSeconds) : 'none'],
    ].map((pair) => '<div class="cm-stat"><b>' + escapeHtml(String(pair[1])) + '</b><span>' + pair[0] + '</span></div>').join('') + '</div>' +
    '<div class="cm-label">Managed by</div><ul class="cm-managers">' + managerHtml + '</ul>' +
    '<p class="cm-note">Huddles here: ' + fmtDuration(stats.totalSeconds || 0) + ' of huddle time, longest ' +
    (stats.longestSeconds ? fmtDuration(stats.longestSeconds) : 'none yet') + '.</p>' +
    '<p class="cm-note"><a href="https://slack.com/app_redirect?channel=' + encodeURIComponent(channel.id) +
      '" target="_blank" rel="noopener">Open #' + escapeHtml(channel.name) + ' in Slack</a></p>';
  modal.classList.remove('hidden');
  $('cm-close').focus();
}

function closeChannelModal(){
  $('channel-modal').classList.add('hidden');
}

function renderLog(entries, allowed){
  if (!allowed) return;
  const panel = $('log-panel');
  panel.classList.remove('hidden');
  const list = $('log');
  if (!entries || !entries.length){
    list.innerHTML = '<li class="none-slot">' + none('Nothing logged yet', 'Owner actions show up here as soon as they happen.') + '</li>';
    return;
  }
  list.innerHTML = entries.map((entry) => {
    const at = new Date(String(entry.created_at).replace(' ', 'T') + 'Z');
    return '<li><time>' + at.toISOString().slice(11, 19) + '</time>' +
      '<span class="act">' + escapeHtml(entry.action) + '</span>' +
      '<span class="det">' + escapeHtml([entry.user_id, entry.detail, entry.channel_id].filter(Boolean).join(' / ')) + '</span></li>';
  }).join('');
}

function renderSparkline(values){
  const node = $('spark');
  if (!values.length || values.every((value) => !value)){
    node.innerHTML = none('No points to chart', 'The chart fills in once the leaderboard has scores.');
    node.classList.add('spark-empty');
    return;
  }
  node.classList.remove('spark-empty');
  const max = Math.max(1, ...values);
  node.innerHTML = values.map((value) => '<i style="height:' + Math.max(3, Math.round(value / max * 100)) + '%"></i>').join('');
}

function escapeHtml(value){
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function refresh(){
  let data;
  try {
    const response = await fetch(base + '/api/stats', { headers: { accept: 'application/json' } });
    if (!response.ok) return;
    data = await response.json();
  } catch (error) {
    return;
  }
  viewer = data.viewer;
  if (data.teamId) teamId = data.teamId;
  const h = data.huddles, u = data.uptime;

  const boardTotal = data.leaderboard.reduce((total, row) => total + row.points, 0);

  setValue('stat-active', fmt.format(h.active));
  setValue('stat-24h', fmt.format(h.last24h));
  setValue('stat-members', fmt.format(h.members));
  setValue('stat-channels', fmt.format(data.botChannels.count));
  setValue('stat-score', fmt.format(boardTotal));
  $('uptime-pill').textContent = 'up ' + duration(u.seconds);
  setField('kv-uptime', duration(u.seconds));
  setField('kv-started', new Date(u.startedAt).toISOString().slice(0, 16).replace('T', ' ') + 'Z');
  setField('kv-longest', h.longestSeconds ? duration(h.longestSeconds) : null, 'no huddles yet');
  setField('kv-average', h.averageSeconds ? duration(h.averageSeconds) : null, 'no huddles yet');
  setField('kv-optedout', fmt.format(h.optedOut));
  const stateTag = $('state-tag');
  stateTag.textContent = u.state;
  stateTag.classList.toggle('ok', u.state === 'ok' || u.state === 'operational');
  $('foot-updated').textContent = 'updated ' + new Date(data.generatedAt).toISOString().slice(11, 19) + 'Z';

  // Only the numbers above are on a timer. Re-drawing the lists every 5s is what
  // made avatars flash and re-download, and nothing in them moves that fast, so
  // the first paint owns them.
  if (first) renderAll(data);

  if (first) {
    const bare = !h.total && !h.members && !data.botChannels.count;
    if (bare) {
      cold('Nothing here yet', 'Asteria has not seen a huddle, a person, or a channel. Invite it to a channel and this page fills itself in.');
    }
    first = false;
  }
}

function renderAll(data){
  renderBoard(data.leaderboard, viewer);
  renderOptIn();
  renderChannels(data.channels, data.botChannels.count);
  renderLog(data.logs, Boolean(viewer && viewer.isOwner));
  renderSparkline(data.leaderboard.slice(0, 12).map((row) => row.points));
}

// The channel list is re-rendered, so the open handler is delegated rather than
// bound per row. The popup closes on the scrim, the close button, or Escape.
document.addEventListener('click', function (event) {
  const opener = event.target.closest('.chan-open');
  if (opener){
    openChannelModal(opener.getAttribute('data-channel'));
    return;
  }
  if (event.target.closest('#cm-close') || event.target.id === 'cm-scrim'){
    closeChannelModal();
  }
});
document.addEventListener('keydown', function (event) {
  if (event.key === 'Escape') closeChannelModal();
});

/* ---------- explainer popup ---------- */
function openAbout() {
  $('about-modal').classList.remove('hidden');
  $('about-close').focus();
}
function closeAbout() {
  $('about-modal').classList.add('hidden');
}
for (const id of ['about-open', 'about-open-2']) {
  const el = $(id);
  if (el) el.addEventListener('click', openAbout);
}
$('about-close').addEventListener('click', closeAbout);
$('about-scrim').addEventListener('click', closeAbout);
document.addEventListener('keydown', function (event) {
  if (event.key === 'Escape' && !$('about-modal').classList.contains('hidden')) {
    closeAbout();
  }
});

/* ---------- settings pages ---------- */
const post = (url, body) =>
  fetch(base + url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => (r.ok ? r.json() : Promise.reject(new Error('save failed'))));

function flash(id) {
  const el = $(id);
  if (!el) return;
  el.classList.add('on');
  setTimeout(() => el.classList.remove('on'), 1600);
}

const setVal = (id, value) => {
  const el = $(id);
  if (el) el.value = value ?? '';
};
const setChecked = (id, value) => {
  const el = $(id);
  if (el) el.checked = !!value;
};
const setText = (id, value) => {
  const el = $(id);
  if (el) el.textContent = value ?? '';
};

function loadJLog() {
  fetch(base + '/api/j-log')
    .then((r) => r.json())
    .then((d) => {
      const s = d.settings || {};
      setVal('f-main', d.draft?.main_update_text);
      setVal('f-song', d.draft?.song_text);
      setVal('f-event', d.draft?.event_text);
      setText('draft-tag', d.draft?.main_update_text ? 'has a draft' : 'empty');

      setChecked('q-enabled', s.daily_question_enabled);
      setVal('q-time', s.daily_question_send_time);
      setVal('q-prompt', s.daily_question_prompt);
      setVal('q-reply', s.daily_question_reply_text);
      setChecked('q-include', s.daily_question_include_in_daily_update);

      setChecked('r-enabled', s.daily_update_reminder_enabled);
      setVal('r-time', s.daily_update_reminder_time);
      setChecked('r-thread', s.daily_update_thread_enabled);

      const list = d.recentQuestions || [];
      $('q-history').innerHTML = list.length
        ? list
            .map(
              (q) =>
                '<li><div class="lrow"><span class="lwhen">' +
                escapeHtml((q.sent_at_utc || q.local_date || '').slice(0, 10)) +
                '</span><span class="ltext">' +
                escapeHtml(q.question_text || '') +
                '</span></div></li>',
            )
            .join('')
        : '<li class="none-slot"><div class="none">No questions sent yet.</div></li>';
    })
    .catch(() => {});
}

function wireJLog() {
  $('draft-save').addEventListener('click', () =>
    post('/api/j-log/draft', {
      main_update_text: $('f-main').value,
      song_text: $('f-song').value,
      event_text: $('f-event').value,
    })
      .then(() => {
        flash('draft-saved');
        setText('draft-tag', 'has a draft');
      })
      .catch(() => {}),
  );
  $('draft-clear').addEventListener('click', () =>
    post('/api/j-log/draft', { clear: true })
      .then(() => {
        setVal('f-main', '');
        setVal('f-song', '');
        setVal('f-event', '');
        flash('draft-saved');
        setText('draft-tag', 'empty');
      })
      .catch(() => {}),
  );
  $('q-save').addEventListener('click', () =>
    post('/api/j-log/settings', {
      daily_question_enabled: $('q-enabled').checked ? 1 : 0,
      daily_question_send_time: $('q-time').value,
      daily_question_prompt: $('q-prompt').value,
      daily_question_reply_text: $('q-reply').value,
      daily_question_include_in_daily_update: $('q-include').checked ? 1 : 0,
    })
      .then(() => flash('q-saved'))
      .catch(() => {}),
  );
  $('r-save').addEventListener('click', () =>
    post('/api/j-log/settings', {
      daily_update_reminder_enabled: $('r-enabled').checked ? 1 : 0,
      daily_update_reminder_time: $('r-time').value,
      daily_update_thread_enabled: $('r-thread').checked ? 1 : 0,
    })
      .then(() => flash('r-saved'))
      .catch(() => {}),
  );
}

function channelCard(c) {
  return (
    '<div class="cardrow" data-channel="' +
    escapeHtml(c.channelId) +
    '">' +
    '<div class="hd"><div class="nm"><span>' +
    escapeHtml(c.name || c.channelId) +
    '</span></div><span class="id">' +
    escapeHtml(c.channelId) +
    '</span></div>' +
    '<div class="grid2">' +
    '<div class="switchrow"><div><div class="t">Track huddles</div><div class="d">Announcements, reviews and points.</div></div>' +
    '<label class="switch"><input type="checkbox" data-flag="enabled"' +
    (c.enabled ? ' checked' : '') +
    '><i></i></label></div>' +
    '<div class="switchrow"><div><div class="t">Answer when mentioned</div><div class="d">Turning this off silences the bot in the channel.</div></div>' +
    '<label class="switch"><input type="checkbox" data-flag="auto_replies"' +
    (c.auto_replies ? ' checked' : '') +
    '><i></i></label></div>' +
    '<div class="switchrow"><div><div class="t">Managers only</div><div class="d">Everyone else who asks is told why, not ignored.</div></div>' +
    '<label class="switch"><input type="checkbox" data-flag="restrict_triggers"' +
    (c.restrict_triggers ? ' checked' : '') +
    '><i></i></label></div>' +
    '<div class="switchrow"><div><div class="t">Condended recaps</div><div class="d">On, the thread gets the summary and a link, and no review button.</div></div>' +
    '<label class="switch"><input type="checkbox" data-flag="condensed_review"' +
    (c.condensed_review ? ' checked' : '') +
    '><i></i></label></div>' +
    '<div class="switchrow"><div><div class="t">Paused</div><div class="d">Stops everything until ' +
    escapeHtml(c.pausedUntilLabel || 'never') +
    '</div></div>' +
    '<label class="switch"><input type="checkbox" data-flag="paused"' +
    (c.paused ? ' checked' : '') +
    '><i></i></label></div>' +
    '</div>' +
    '<div class="owners"><span class="id" style="align-self:center">managers</span>' +
    (c.owners || [])
      .map(
        (o) =>
          '<span class="ownerchip"><img src="' +
          base +
          '/avatar?u=' +
          encodeURIComponent(o.id) +
          '" alt="">' +
          escapeHtml(o.name || o.id) +
          '<button type="button" data-remove-owner="' +
          escapeHtml(o.id) +
          '" title="remove">&times;</button></span>',
      )
      .join('') +
    '<span class="ownerchip" style="padding-right:8px"><input type="text" placeholder="U0ABC123" data-add-owner style="width:88px;background:transparent;border:0;color:inherit;font:inherit;font-size:11.5px;outline:none">+ add</span>' +
    '</div>' +
    '<div class="row-actions"><span class="saved" data-saved> saved</span></div>' +
    '</div>'
  );
}

function loadHuddles() {
  fetch(base + '/api/huddles/config')
    .then((r) => r.json())
    .then((d) => {
      const note = $('unconfigured-note');
      if (d.unconfigured?.length) {
        note.hidden = false;
        setText(
          'unconfigured-text',
          'The bot is in ' +
            d.unconfigured.length +
            ' channel(s) it has no settings for: ' +
            d.unconfigured.map((c) => '#' + (c.name || c.channelId)).join(', ') +
            '. Huddles there are still announced and still score points, but they do not appear on the dashboard.',
        );
      } else {
        note.hidden = true;
      }
      setText('hc-tag', d.channels.length + ' configured');
      $('hc-list').innerHTML = d.channels.length
        ? d.channels.map(channelCard).join('')
        : '<div class="emptynote">No channels configured yet.</div>';
    })
    .catch(() => {
      $('hc-list').innerHTML = '<div class="emptynote">Could not load channel settings.</div>';
    });
}

function wireHuddles() {
  $('hc-list').addEventListener('change', (event) => {
    const box = event.target.closest('input[data-flag]');
    if (!box) return;
    const row = box.closest('.cardrow');
    const channelId = row.dataset.channel;
    const flag = box.dataset.flag;
    const patch = flag === 'paused' ? { paused: box.checked } : { [flag]: box.checked ? 1 : 0 };
    post('/api/huddles/config', { channelId, ...patch })
      .then(() => row.querySelector('[data-saved]').classList.add('on'))
      .catch(() => {});
  });
  $('hc-list').addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-remove-owner]');
    if (!btn) return;
    const row = btn.closest('.cardrow');
    post('/api/huddles/owners', { channelId: row.dataset.channel, remove: btn.dataset.removeOwner })
      .then(() => loadHuddles())
      .catch(() => {});
  });
  $('hc-list').addEventListener('keydown', (event) => {
    const input = event.target.closest('input[data-add-owner]');
    if (!input || event.key !== 'Enter') return;
    event.preventDefault();
    const value = input.value.trim().toUpperCase();
    if (!value) return;
    const row = input.closest('.cardrow');
    post('/api/huddles/owners', { channelId: row.dataset.channel, add: value })
      .then(() => loadHuddles())
      .catch(() => {});
  });
}

function loadAdmin() {
  fetch(base + '/api/admin')
    .then((r) => r.json())
    .then((d) => {
      $('scope-list').innerHTML = (d.permissions || [])
        .map(
          (p) =>
            '<div class="cardrow"><div class="hd"><div class="nm"><span>' +
            escapeHtml(p.label) +
            '</span></div><span class="tag' +
            (p.granted ? ' ok' : '') +
            '">' +
            (p.granted ? 'granted' : 'missing') +
            '</span></div><div class="id">' +
            escapeHtml(p.detail) +
            '</div></div>',
        )
        .join('');
      setText('orphan-tag', d.orphans?.total + ' total');
      setText(
        'orphan-note',
        d.orphans?.total
          ? 'Recorded from workspace-wide events, so there is no channel to attribute them to. They are excluded from every number on the dashboard and score no points.'
          : 'Every huddle the bot has recorded has a channel it can be attributed to.',
      );
      $('orphan-kv').innerHTML = [
        ['never had a channel', d.orphans?.noChannel ?? 0],
        ['no thread to check', d.orphans?.noThread ?? 0],
        ['still open', d.orphans?.active ?? 0],
        ['already closed', d.orphans?.ended ?? 0],
      ]
        .map(([k, v]) => '<div><span class="k">' + k + '</span><span class="v">' + v + '</span></div>')
        .join('');
      // membership arrives as an object keyed by scope, not an array, so it needs
      // Object.entries before it can be mapped over.
      $('member-kv').innerHTML = Object.entries(d.membership || {})
        .map(
          ([k, v]) =>
            '<div><span class="k">' + escapeHtml(k) + '</span><span class="v">' + escapeHtml(v) + '</span></div>',
        )
        .join('');
    })
    .catch(() => {});
}

refresh();
setInterval(refresh, 5000);
`;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const DASHBOARD_ACCENT = ACCENT;

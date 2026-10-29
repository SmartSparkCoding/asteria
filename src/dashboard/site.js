import { ORBIT_FAVICON, ORBIT_MARK_SVG } from './theme.js';

/**
 * Orbit's entire website: the public landing page and the signed-in app.
 *
 * This replaces the old dashboard wholesale. The backend endpoints are the same
 * ones the bot and the tracker maintain; only the presentation and the client
 * were rebuilt.
 */

const ACCENT = '#cba6f7';
const ACCENT_2 = '#b4befe';

const TOKENS = `
:root{color-scheme:dark;
  --bg:#0b0d10;--bg-2:#0e1115;--surface:#12161b;--raised:#171c23;--hover:#1c222a;
  --line:#232a33;--line-2:#2e3742;
  --ink:#e7eaf0;--ink-2:#b3bcc9;--muted:#8792a2;
  --accent:${ACCENT};--accent-2:${ACCENT_2};
  --green:#a6e3a1;--red:#f38ba8;--yellow:#f9e2af;--blue:#89b4fa;--orange:#fab387;
  --radius:8px;--radius-lg:10px;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}`;

const BASE = `
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:14px;line-height:1.55;
  -webkit-font-smoothing:antialiased}
a{color:var(--accent-2);text-decoration:none}
a:hover{text-decoration:underline}
h1,h2,h3,h4{margin:0;font-weight:640;letter-spacing:-.02em}
p{margin:0}
button,input,select,textarea{font:inherit;color:inherit}
svg{display:block}
.hidden{display:none !important}
.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
.muted{color:var(--muted)}
.small{font-size:12px}
.nowrap{white-space:nowrap}

/* buttons */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;
  border:1px solid transparent;border-radius:var(--radius);background:var(--accent);color:#0b0d10;
  font-size:12.5px;font-weight:650;cursor:pointer;white-space:nowrap}
.btn:hover{background:var(--accent-2);text-decoration:none}
.btn:active{transform:translateY(1px)}
.btn:focus-visible{outline:2px solid var(--accent-2);outline-offset:2px}
.btn.ghost{background:transparent;border-color:var(--line-2);color:var(--ink-2)}
.btn.ghost:hover{background:var(--hover);color:var(--ink)}
.btn.danger{background:transparent;border-color:var(--red);color:var(--red)}
.btn.tiny{height:26px;padding:0 9px;font-size:11.5px}
.btn[disabled]{opacity:.45;cursor:not-allowed}
.linkish{background:none;border:0;padding:0;font:inherit;color:var(--accent-2);cursor:pointer}
.linkish:hover{text-decoration:underline}

/* inputs */
.field{display:grid;gap:5px}
.field label,.label{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:650}
.input,.field input,.field textarea,.field select{width:100%;background:var(--bg-2);border:1px solid var(--line-2);
  border-radius:var(--radius);padding:8px 10px;font-size:13px;color:var(--ink)}
.input:focus,.field input:focus,.field textarea:focus,.field select:focus{outline:none;border-color:var(--accent)}
textarea{resize:vertical;min-height:90px;font-family:var(--mono);font-size:12.5px;line-height:1.5}
.hint{font-size:11.5px;color:var(--muted);line-height:1.5}

/* switches */
.sw{position:relative;display:inline-block;width:34px;height:19px;flex:none}
.sw input{position:absolute;inset:0;opacity:0;margin:0;cursor:pointer}
.sw i{position:absolute;inset:0;background:var(--raised);border:1px solid var(--line-2);border-radius:99px;transition:background .12s}
.sw i::after{content:"";position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:var(--muted);transition:transform .12s,background .12s}
.sw input:checked+i{background:rgba(203,166,247,.28);border-color:var(--accent)}
.sw input:checked+i::after{transform:translateX(15px);background:var(--accent)}
.sw input:focus-visible+i{outline:2px solid var(--accent-2);outline-offset:2px}

/* tags */
.tag{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 7px;border:1px solid var(--line-2);
  border-radius:5px;font-size:10.5px;font-weight:600;color:var(--muted);white-space:nowrap}
.tag.ok{color:var(--green);border-color:rgba(166,227,161,.35)}
.tag.warn{color:var(--yellow);border-color:rgba(249,226,175,.35)}
.tag.bad{color:var(--red);border-color:rgba(243,139,168,.35)}
.dot{width:5px;height:5px;border-radius:50%;background:var(--muted);flex:none}
.dot.on{background:var(--green)}
.dot.warn{background:var(--yellow)}

/* tables */
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
thead th{text-align:left;font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);
  font-weight:650;padding:0 10px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
tbody td{padding:10px;border-bottom:1px solid var(--line);vertical-align:middle}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover td{background:var(--bg-2)}
td.num,th.num{text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums;white-space:nowrap}
td.act{text-align:right;white-space:nowrap}
.empty-cell{text-align:center;color:var(--muted);padding:32px 10px !important}
.sub{color:var(--muted);font-size:11.5px}
.stack{display:grid;gap:2px;min-width:0}
.stack .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* avatars */
.av{width:26px;height:26px;border-radius:50%;background:var(--raised);object-fit:cover;flex:none;
  display:inline-grid;place-items:center;font-size:10px;font-weight:700;color:var(--muted)}
.cell-person{display:flex;align-items:center;gap:9px;min-width:0}

/* layout */
.page{max-width:1200px;margin:0 auto;padding:26px 24px 64px}
.page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:22px;flex-wrap:wrap}
.page-head h1{font-size:24px;line-height:1.15}
.page-head .desc{margin-top:4px;color:var(--muted);font-size:13px;max-width:70ch}
.page-head .actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.kicker{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--accent);font-weight:650;margin-bottom:6px}
.section{margin-bottom:26px}
.section-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}
.section-head h2{font-size:13px;font-weight:640}
.section-head .tag{color:var(--muted)}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-lg);padding:14px 14px 6px}
.panel.flush{padding:0}
.grid-2{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(0,1fr);gap:16px;align-items:start}
@media (max-width:980px){.grid-2{grid-template-columns:1fr}}
.split{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:24px}
@media (max-width:900px){.split{grid-template-columns:1fr}}

/* kpis */
.kpis{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));border:1px solid var(--line);
  border-radius:var(--radius-lg);background:var(--surface);margin-bottom:22px;overflow:hidden}
.kpi{padding:12px 14px}
.kpi+.kpi{border-left:1px solid var(--line)}
.kpi .k{font-size:9.5px;letter-spacing:.11em;text-transform:uppercase;color:var(--muted);font-weight:650}
.kpi .v{font-family:var(--mono);font-size:22px;line-height:1.1;margin-top:6px;letter-spacing:-.03em}
.kpi .h{font-size:10.5px;color:var(--muted);margin-top:2px}
@media (max-width:820px){.kpis{grid-template-columns:repeat(3,1fr)}
  .kpi:nth-child(4){border-left:0;border-top:1px solid var(--line)}
  .kpi:nth-child(5){border-top:1px solid var(--line)}
  .kpi:nth-child(n+4){padding-top:12px}}
@media (max-width:520px){.kpis{grid-template-columns:repeat(2,1fr)}
  .kpi:nth-child(odd){border-left:0}
  .kpi:nth-child(3){border-top:1px solid var(--line)}
  .kpi:nth-child(4){border-top:1px solid var(--line)}
  .kpi:nth-child(5){border-top:1px solid var(--line)}}

/* leaderboard */
.lead{list-style:none;margin:0;padding:0}
.lead li{display:grid;grid-template-columns:22px minmax(0,1fr) auto;gap:9px;align-items:center;
  padding:8px 2px;border-bottom:1px solid var(--line)}
.lead li:last-child{border-bottom:0}
.lead .r{font-family:var(--mono);font-size:11px;color:var(--muted);text-align:right}
.lead li:nth-child(1) .r{color:var(--yellow)}
.lead li:nth-child(2) .r{color:var(--orange)}
.lead li:nth-child(3) .r{color:var(--ink-2)}
.lead .n{font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lead .p{font-family:var(--mono);font-size:12px;color:var(--ink-2)}
.lead li.me{background:rgba(203,166,247,.07)}
.mine{margin-top:12px;padding-top:10px;border-top:1px solid var(--line)}
.mine .label{margin-bottom:6px}
.mine-list{list-style:none;margin:0;padding:0;display:grid;gap:4px}
.mine-list li{display:flex;justify-content:space-between;gap:10px;font-size:12px;color:var(--ink-2)}
.mine-list li .mono{color:var(--ink)}

/* the one question */
.agree-wrap{margin-bottom:18px}
.agree{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:18px;align-items:center;
  border:1px solid var(--line-2);border-left:2px solid var(--accent);border-radius:var(--radius-lg);
  background:var(--surface);padding:14px 16px}
.agree h2{font-size:14px;margin:2px 0 4px}
.agree .agree-body{font-size:12.5px;color:var(--ink-2);max-width:74ch}
.agree .hint{margin-top:4px;max-width:74ch}
.agree .agree-actions{display:flex;gap:8px;flex:none}
.agree-row{display:flex;align-items:center;gap:8px;padding:8px 2px;border-bottom:1px solid var(--line);
  font-size:12px;color:var(--muted)}
@media (max-width:700px){.agree{grid-template-columns:1fr}.agree .agree-actions{justify-content:flex-start}}

/* misc */
.filters{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-bottom:14px}
.filters .field{gap:4px}
.filters select,.filters input{min-width:150px}
.empty{padding:28px 16px;text-align:center;color:var(--muted);font-size:13px}
.skel{display:inline-block;height:10px;border-radius:4px;background:var(--raised);animation:skel 1.4s ease infinite}
@keyframes skel{0%,100%{opacity:.55}50%{opacity:1}}
.foot{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;color:var(--muted);font-size:11.5px;
  border-top:1px solid var(--line);margin-top:32px;padding-top:14px}
.chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.chip{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 6px;border:1px solid var(--line-2);
  border-radius:5px;font-size:11px;color:var(--ink-2)}
.chip img{width:16px;height:16px;border-radius:50%}
.chip button{background:none;border:0;color:var(--muted);cursor:pointer;padding:0 1px;font-size:12px}
.chip button:hover{color:var(--red)}
.saved{font-size:11.5px;color:var(--green);opacity:0;transition:opacity .2s}
.saved.on{opacity:1}
.sike{position:fixed;inset:0;z-index:100;display:grid;place-items:center;text-align:center;padding:24px;
  background:rgba(11,13,16,.95)}
.sike.hidden{display:none}
.sike b{display:block;font-size:clamp(56px,15vw,140px);line-height:.9;font-weight:800;letter-spacing:-.05em;color:var(--accent)}
.sike span{display:block;margin-top:14px;color:var(--ink-2);font-size:16px}
@media (prefers-reduced-motion:reduce){*{animation:none !important;transition:none !important}}
`;

const LANDING_STYLES = `
.lnav{position:sticky;top:0;z-index:20;background:rgba(11,13,16,.88);backdrop-filter:blur(10px);
  border-bottom:1px solid var(--line)}
.lnav .in{max-width:1120px;margin:0 auto;padding:0 24px;height:56px;display:flex;align-items:center;gap:20px}
.brand{display:flex;align-items:center;gap:9px;color:var(--ink);font-weight:650;letter-spacing:-.02em;font-size:14px}
.brand:hover{text-decoration:none}
.brand .mark{width:26px;height:26px;border-radius:7px;display:grid;place-items:center;color:var(--accent);
  border:1px solid var(--line-2);background:var(--surface)}
.lnav .links{display:flex;gap:2px;margin-left:6px}
.lnav .links a{color:var(--muted);font-size:12.5px;font-weight:550;padding:6px 9px;border-radius:6px}
.lnav .links a:hover{color:var(--ink);background:var(--surface);text-decoration:none}
.lnav .sp{flex:1}
.hero{max-width:1120px;margin:0 auto;padding:68px 24px 48px;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);
  gap:48px;align-items:center}
@media (max-width:920px){.hero{grid-template-columns:1fr;padding-top:48px;gap:34px}}
.hero h1{font-size:clamp(34px,4.6vw,52px);line-height:1.03;letter-spacing:-.04em;font-weight:700;margin:0 0 14px}
.hero h1 em{font-style:normal;color:var(--accent)}
.hero .lede{color:var(--ink-2);font-size:16px;max-width:48ch;margin-bottom:22px}
.hero .row{display:flex;gap:8px;flex-wrap:wrap}
.hero .note{margin-top:14px;font-size:12px;color:var(--muted)}
.pv{border:1px solid var(--line);border-radius:12px;background:var(--surface);overflow:hidden}
.pv .bar{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid var(--line);
  background:var(--bg-2);font-size:11px;color:var(--muted)}
.pv .bar i{width:6px;height:6px;border-radius:50%;background:var(--line-2)}
.pv .body{padding:12px}
.pv .kpirow{display:grid;grid-template-columns:repeat(3,1fr);border:1px solid var(--line);border-radius:8px;overflow:hidden;margin-bottom:10px}
.pv .kp{padding:9px 10px}
.pv .kp+.kp{border-left:1px solid var(--line)}
.pv .kp small{display:block;font-size:8.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.pv .kp b{display:block;font-family:var(--mono);font-size:18px;margin-top:3px}
.pv table{font-size:12px}
.pv td{padding:7px 6px}
.claims{border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.claims .in{max-width:1120px;margin:0 auto;padding:18px 24px;display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
@media (max-width:820px){.claims .in{grid-template-columns:1fr 1fr}}
.claims b{display:block;font-size:12.5px;margin-bottom:2px}
.claims span{font-size:11.5px;color:var(--muted)}
.block{max-width:1120px;margin:0 auto;padding:56px 24px}
.block h2{font-size:clamp(22px,3vw,30px);letter-spacing:-.03em;margin-bottom:8px}
.block .intro{color:var(--muted);max-width:60ch;margin-bottom:26px;font-size:13.5px}
.features{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--line);border:1px solid var(--line);border-radius:10px;overflow:hidden}
@media (max-width:900px){.features{grid-template-columns:1fr}}
.feature{background:var(--surface);padding:18px}
.feature h3{font-size:13px;display:flex;align-items:center;gap:7px;margin-bottom:5px}
.feature .ico{color:var(--accent)}
.feature p{font-size:12.5px;color:var(--muted)}
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
@media (max-width:900px){.steps{grid-template-columns:1fr}}
.step{border-left:2px solid var(--line-2);padding-left:14px}
.step .n{font-family:var(--mono);font-size:11px;color:var(--accent)}
.step h3{font-size:13px;margin:3px 0 4px}
.step p{font-size:12.5px;color:var(--muted)}
.privacy{border:1px solid var(--line);border-radius:10px;background:var(--surface);padding:22px}
.privacy ul{margin:0;padding:0;list-style:none;display:grid;grid-template-columns:1fr 1fr;gap:8px 24px}
@media (max-width:760px){.privacy ul{grid-template-columns:1fr}}
.privacy li{font-size:12.5px;color:var(--ink-2);padding-left:14px;position:relative}
.privacy li::before{content:"";position:absolute;left:0;top:7px;width:4px;height:4px;border-radius:50%;background:var(--accent)}
.cta{border:1px solid var(--line);border-radius:10px;padding:26px;display:flex;align-items:center;justify-content:space-between;gap:18px;flex-wrap:wrap;background:var(--surface)}
.cta h2{font-size:22px}
.cta p{color:var(--muted);font-size:12.5px;margin-top:3px}
footer{border-top:1px solid var(--line);margin-top:40px}
footer .in{max-width:1120px;margin:0 auto;padding:20px 24px 34px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;color:var(--muted);font-size:11.5px}
`;

export function renderLanding({ signedIn = false } = {}) {
  const cta = signedIn
    ? '<a class="btn" href="/dashboard">Open Orbit</a>'
    : '<a class="btn" href="/login">Sign in with Slack</a>';
  return `<!doctype html>
<html lang="en" data-view="landing">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Orbit, huddles scored and remembered</title>
<meta name="description" content="Orbit tracks huddles in your Hack Club Slack, keeps the leaderboard, and collects the funny bits. No audio, no scraping, no public data.">
<meta name="color-scheme" content="dark">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(ORBIT_FAVICON)}" type="image/svg+xml">
<style>${TOKENS}${BASE}${LANDING_STYLES}</style>
</head>
<body>
<nav class="lnav"><div class="in">
  <a class="brand" href="/"><span class="mark">${ORBIT_MARK_SVG}</span>Orbit</a>
  <div class="links">
    <a href="#features">Features</a>
    <a href="#how">How it works</a>
    <a href="#privacy">Privacy</a>
  </div>
  <span class="sp"></span>
  ${cta}
</div></nav>

<header class="hero">
  <div>
    <p class="kicker">for Hack Club Slack</p>
    <h1>Huddles, <em>scored</em> and remembered.</h1>
    <p class="lede">Orbit sits in your channels, tracks every huddle, keeps the leaderboard, and collects the
      funny bits in recaps. It never joins the call and never records audio.</p>
    <div class="row">
      ${signedIn
        ? '<a class="btn" href="/dashboard">Open your dashboard</a><a class="btn ghost" href="#features">What it does</a>'
        : '<a class="btn" href="/login">Sign in with Slack</a><a class="btn ghost" href="#how">How it works</a>'}
    </div>
    <p class="note">Slack sign in. Nothing about the leaderboard or huddle history is public.</p>
  </div>

  <div class="pv" aria-hidden="true">
    <div class="bar"><i></i><i></i><i></i><span style="margin-left:6px">orbit.navaratne.uk/dashboard</span></div>
    <div class="body">
      <div class="kpirow">
        <div class="kp"><small>Huddles</small><b>54</b></div>
        <div class="kp"><small>Points</small><b>3,457</b></div>
        <div class="kp"><small>People</small><b>18</b></div>
      </div>
      <table>
        <thead><tr><th>#</th><th>Person</th><th class="num">Points</th></tr></thead>
        <tbody>
          <tr><td class="mono muted">1</td><td>FreeformWave</td><td class="num">706</td></tr>
          <tr><td class="mono muted">2</td><td>Jacob N</td><td class="num">550</td></tr>
          <tr><td class="mono muted">3</td><td>Trulle123</td><td class="num">493</td></tr>
          <tr><td class="mono muted">4</td><td>Dragaroni</td><td class="num">460</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</header>

<section class="claims"><div class="in">
  <div><b>Every huddle</b><span>Join to leave, with the gaps kept.</span></div>
  <div><b>Real minutes</b><span>Points follow provable time.</span></div>
  <div><b>Recaps, opt in</b><span>Moments from people, not scraped chat.</span></div>
  <div><b>No audio</b><span>Never in the call, never recording.</span></div>
</div></section>

<section class="block" id="features">
  <p class="kicker">features</p>
  <h2>Built around the huddle, not the dashboard.</h2>
  <p class="intro">Huddle tracking, points, channel controls and recaps. All of it behind Slack sign in.</p>
  <div class="features">
    <article class="feature"><h3><span class="ico">${icon('users')}</span>Huddles</h3>
      <p>Who joined, how long they stayed, the gaps in between. Each huddle has its own page with the full breakdown.</p></article>
    <article class="feature"><h3><span class="ico">${icon('chart')}</span>Leaderboard</h3>
      <p>Minutes become points, with small bonuses for rank, the person who started it and the targets. Opt out and you are not listed.</p></article>
    <article class="feature"><h3><span class="ico">${icon('sliders')}</span>Channel controls</h3>
      <p>Tracking, replies, managers-only triggers, condensed recaps and a pause switch, per channel.</p></article>
    <article class="feature"><h3><span class="ico">${icon('pen')}</span>Recaps</h3>
      <p>Share a channel page. People who have huddled there submit their own moments, with an explicit policy and a stored tick.</p></article>
    <article class="feature"><h3><span class="ico">${icon('send')}</span>Messages</h3>
      <p>The owner can DM anyone as Orbit, signed off with <b>from @jacob</b>. No hidden sender.</p></article>
    <article class="feature"><h3><span class="ico">${icon('shield')}</span>Privacy</h3>
      <p>Private channels need membership. Recaps need consent. The board is never public.</p></article>
  </div>
</section>

<section class="block" id="how">
  <p class="kicker">how it works</p>
  <h2>Invite it, huddle, sign in.</h2>
  <div class="steps">
    <article class="step"><span class="n">01</span><h3>Invite Orbit</h3><p>Add the bot to a channel. It only sees conversations it is already in.</p></article>
    <article class="step"><span class="n">02</span><h3>Huddle</h3><p>Orbit reads the roster Slack publishes and live presence events. No audio, no joining.</p></article>
    <article class="step"><span class="n">03</span><h3>Sign in</h3><p>Open the dashboard with Slack, see the board, and read any huddle you were in.</p></article>
  </div>
</section>

<section class="block" id="privacy">
  <p class="kicker">privacy</p>
  <h2>What Orbit will never do.</h2>
  <div class="privacy"><ul>
    <li>Record audio or join a huddle.</li>
    <li>Scrape message bodies. Live events and metadata only.</li>
    <li>Publish the board, huddle pages or channel stats.</li>
    <li>Show a private channel to anyone outside it.</li>
    <li>DM people unprompted, apart from sign-in links.</li>
    <li>Sell or share data.</li>
  </ul></div>
</section>

<section class="block">
  <div class="cta">
    <div><h2>${signedIn ? 'Pick up where you left off.' : 'See your huddles.'}</h2>
      <p>Sign in with Slack. If you are in the workspace, that is all you need.</p></div>
    ${signedIn ? '<a class="btn" href="/dashboard">Open Orbit</a>' : '<a class="btn" href="/login">Sign in with Slack</a>'}
  </div>
</section>

<footer><div class="in">
  <span>Orbit. Built for Hack Club, not affiliated with Slack.</span>
  <span><a href="/health">health</a> · <a href="/rss.xml">rss</a> · <a href="/login">sign in</a></span>
</div></footer>
</body>
</html>`;
}

/** The signed-in application shell and pages. */
export function renderApp({ signedIn = false, role = null, displayRole = null, isAdminViewer = false, view = 'dashboard' } = {}) {
  const body = VIEWS[view] ? VIEWS[view]({ role, isAdminViewer }) : VIEWS.dashboard();
  return `<!doctype html>
<html lang="en" data-view="${escapeAttr(view)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(TITLES[view] || 'Orbit')} · Orbit</title>
<meta name="robots" content="noindex,nofollow">
<meta name="color-scheme" content="dark">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(ORBIT_FAVICON)}" type="image/svg+xml">
<style>${TOKENS}${BASE}${APP_STYLES}</style>
</head>
<body>
<header class="top">
  <div class="in">
    <a class="brand" href="/dashboard"><span class="mark">${ORBIT_MARK_SVG}</span>Orbit</a>
    <nav class="nav" aria-label="Sections">${navItems(view, { role, isAdminViewer })}</nav>
    <div class="account">
      <span class="state" id="state-pill"><span class="dot" id="state-dot"></span><span id="state-text">live</span></span>
      <span class="who" id="who">${escapeHtml(displayRole || role || 'member')}</span>
      <form method="post" action="/logout"><button class="btn ghost tiny" type="submit">Sign out</button></form>
    </div>
  </div>
</header>
<main class="page">${body}</main>
<div class="sike hidden" id="sike" role="alert"><div><b>SIKE!</b><span>You get view, but not real.</span></div></div>
<script>${APP_SCRIPT}</script>
</body>
</html>`;
}

const TITLES = {
  dashboard: 'Dashboard',
  huddles: 'Huddles',
  channels: 'Channels',
  recaps: 'Recaps',
  'j-log': 'Daily update',
  users: 'Users',
  messages: 'Messages',
  admin: 'Admin',
};

function navItems(view, { role, isAdminViewer }) {
  const owner = role === 'owner';
  const manager = role === 'manager' || owner;
  const admin = owner || isAdminViewer;
  const items = [
    ['dashboard', 'Dashboard', true],
    ['huddles', 'Huddles', true],
    ['channels', 'Channels', manager],
    ['recaps', 'Recaps', manager],
    ['j-log', 'Daily update', owner],
    ['users', 'Users', admin],
    ['messages', 'Messages', admin],
    ['admin', 'Admin', admin],
  ];
  return items
    .filter(([, , allowed]) => allowed)
    .map(
      ([id, label, allowed]) =>
        `<a class="navlink${id === view ? ' on' : ''}" href="/${id === 'dashboard' ? 'dashboard' : id}"${
          id === view ? ' aria-current="page"' : ''
        }>${label}</a>`,
    )
    .join('');
}

const APP_STYLES = `
.top{position:sticky;top:0;z-index:30;background:rgba(11,13,16,.9);backdrop-filter:blur(10px);
  border-bottom:1px solid var(--line)}
.top .in{max-width:1200px;margin:0 auto;padding:0 24px;height:52px;display:flex;align-items:center;gap:18px}
.top .brand{display:flex;align-items:center;gap:8px;color:var(--ink);font-weight:650;font-size:13.5px}
.top .brand:hover{text-decoration:none}
.top .brand .mark{width:24px;height:24px;border-radius:6px;display:grid;place-items:center;color:var(--accent);
  border:1px solid var(--line-2);background:var(--surface)}
.nav{display:flex;gap:1px;overflow-x:auto;scrollbar-width:none;min-width:0}
.nav::-webkit-scrollbar{display:none}
.navlink{display:inline-flex;align-items:center;height:52px;padding:0 10px;font-size:12.5px;font-weight:550;
  color:var(--muted);border-bottom:2px solid transparent;white-space:nowrap}
.navlink:hover{color:var(--ink);text-decoration:none}
.navlink.on{color:var(--ink);border-bottom-color:var(--accent)}
.account{display:flex;align-items:center;gap:8px;margin-left:auto;flex:none}
.account .state{display:inline-flex;align-items:center;gap:5px;font-size:10px;letter-spacing:.1em;
  text-transform:uppercase;color:var(--muted)}
.account .who{font-family:var(--mono);font-size:10.5px;color:var(--accent-2);text-transform:lowercase}
@media (max-width:1000px){
  .navlink{padding:0 8px;font-size:12px}
  .account .who{display:none}
}
@media (max-width:760px){
  .top .in{height:auto;padding:8px 16px 0;flex-wrap:wrap;gap:4px}
  .top .brand{height:32px}
  .account{order:2;margin-left:auto;height:32px}
  .nav{order:3;flex-basis:100%;border-top:1px solid var(--line);margin-top:4px}
  .navlink{height:42px}
}
`;

const VIEWS = {
  dashboard: () => `  <div class="page-head">
    <div>
      <p class="kicker">dashboard</p>
      <h1>Overview</h1>
      <div class="desc">What Orbit has seen, what it scored, and which channels it watches.</div>
    </div>
    <div class="actions"><a class="btn ghost" href="/huddles">All huddles</a></div>
  </div>

  <section class="agree-wrap hidden" id="agreement" aria-live="polite"></section>

  <section class="kpis" aria-label="Summary">
    <div class="kpi"><div class="k">Huddles live</div><div class="v" id="k-active"><span class="skel" style="width:30px"></span></div><div class="h">right now</div></div>
    <div class="kpi"><div class="k">Ended, 24h</div><div class="v" id="k-24h"><span class="skel" style="width:30px"></span></div><div class="h">last day</div></div>
    <div class="kpi"><div class="k">People</div><div class="v" id="k-people"><span class="skel" style="width:30px"></span></div><div class="h">in tracked huddles</div></div>
    <div class="kpi"><div class="k">Points</div><div class="v" id="k-points"><span class="skel" style="width:46px"></span></div><div class="h">awarded</div></div>
    <div class="kpi"><div class="k">Channels</div><div class="v" id="k-channels"><span class="skel" style="width:30px"></span></div><div class="h">bot is in</div></div>
  </section>

  <div class="grid-2">
    <section class="section">
      <div class="section-head"><h2>Recent huddles</h2><a class="linkish small" href="/huddles">View all</a></div>
      <div class="panel flush"><div class="table-wrap"><table>
        <thead><tr><th>When</th><th>Channel</th><th class="num">Length</th><th class="num">People</th><th class="num">Points</th><th></th></tr></thead>
        <tbody id="recent-body"><tr><td colspan="6" class="empty-cell"><span class="skel" style="width:180px"></span></td></tr></tbody>
      </table></div></div>
    </section>

    <aside class="section">
      <div class="section-head"><h2>Leaderboard</h2><span class="tag" id="board-scope">all channels</span></div>
      <div class="panel">
        <div id="optin-slot"></div>
        <ol class="lead" id="board"><li><span class="skel" style="width:100%"></span></li></ol>
        <div class="mine hidden" id="my-points"></div>
      </div>
    </aside>
  </div>

  <section class="section">
    <div class="section-head"><h2>Channels</h2><span class="tag" id="channels-tag">bot membership</span></div>
    <div class="panel flush"><div class="table-wrap"><table>
      <thead><tr><th>Channel</th><th>State</th><th class="num">Huddles</th><th class="num">People</th><th class="num">Managers</th><th></th></tr></thead>
      <tbody id="channels-body"><tr><td colspan="6" class="empty-cell"><span class="skel" style="width:200px"></span></td></tr></tbody>
    </table></div></div>
  </section>

  <footer class="foot">
    <span id="foot-updated">loading</span>
    <span id="foot-status">uptime, longest and average</span>
  </footer>`,

  huddles: () => `  <div class="page-head">
    <div>
      <p class="kicker">huddles</p>
      <h1>Huddles</h1>
      <div class="desc">Most recent first. Every row opens the full attendance and points breakdown.</div>
    </div>
  </div>
  <div class="filters">
    <div class="field"><label for="f-channel">Channel</label>
      <select id="f-channel"><option value="">All channels</option></select></div>
    <div class="field"><label for="f-sort">Sort</label>
      <select id="f-sort"><option value="recent">Most recent</option><option value="longest">Longest</option><option value="points">Most points</option></select></div>
    <span class="muted small" id="huddle-count"></span>
  </div>
  <div class="panel flush"><div class="table-wrap"><table>
    <thead><tr><th>When</th><th>Channel</th><th class="num">Length</th><th class="num">People</th><th class="num">Points</th><th></th></tr></thead>
    <tbody id="huddle-body"><tr><td colspan="6" class="empty-cell"><span class="skel" style="width:200px"></span></td></tr></tbody>
  </table></div></div>`,

  channels: () => `  <div class="page-head">
    <div>
      <p class="kicker">channels</p>
      <h1>Channels</h1>
      <div class="desc">What Orbit does in each channel. Changes save as you toggle them.</div>
    </div>
    <div class="actions"><span class="saved" id="ch-saved">saved</span></div>
  </div>
  <div class="panel flush"><div class="table-wrap"><table>
    <thead><tr><th>Channel</th><th>Tracking</th><th>Replies</th><th>Managers only</th><th>Condensed</th><th>Paused</th><th>Managers</th></tr></thead>
    <tbody id="channels-config"><tr><td colspan="7" class="empty-cell"><span class="skel" style="width:220px"></span></td></tr></tbody>
  </table></div></div>
  <section class="section" id="available-section" style="margin-top:20px"></section>`,

  recaps: () => `  <div class="page-head">
    <div>
      <p class="kicker">recaps</p>
      <h1>Recaps</h1>
      <div class="desc">Share a channel page so people can submit their own moments. Submissions appear here for review.</div>
    </div>
  </div>
  <div class="panel flush"><div class="table-wrap"><table>
    <thead><tr><th>Channel</th><th class="num">Submissions</th><th>Page</th><th></th></tr></thead>
    <tbody id="recap-channels"><tr><td colspan="4" class="empty-cell"><span class="skel" style="width:200px"></span></td></tr></tbody>
  </table></div></div>
  <section class="section hidden" id="recap-view-section" style="margin-top:20px">
    <div class="section-head"><h2 id="recap-view-title">Submissions</h2></div>
    <div class="panel flush"><div class="table-wrap"><table>
      <thead><tr><th>When</th><th>Who</th><th>Moment</th><th>Links</th></tr></thead>
      <tbody id="recap-view"></tbody>
    </table></div></div>
  </section>`,

  users: () => `  <div class="page-head">
    <div>
      <p class="kicker">users</p>
      <h1>Users</h1>
      <div class="desc">Everyone with a way into Orbit, and what they can do.</div>
    </div>
  </div>
  <div class="kpis" style="grid-template-columns:repeat(4,1fr)">
    <div class="kpi"><div class="k">Owners</div><div class="v" id="u-owner">0</div></div>
    <div class="kpi"><div class="k">Managers</div><div class="v" id="u-manager">0</div></div>
    <div class="kpi"><div class="k">Members</div><div class="v" id="u-user">0</div></div>
    <div class="kpi"><div class="k">Total</div><div class="v" id="u-total">0</div></div>
  </div>
  <div class="panel flush"><div class="table-wrap"><table>
    <thead><tr><th>Person</th><th>Role</th><th>Last sign in</th><th>Leaderboard</th><th></th></tr></thead>
    <tbody id="users-body"><tr><td colspan="5" class="empty-cell"><span class="skel" style="width:200px"></span></td></tr></tbody>
  </table></div></div>`,

  messages: () => `  <div class="page-head">
    <div>
      <p class="kicker">messages</p>
      <h1>Messages</h1>
      <div class="desc">Send a DM as Orbit. Every message ends with <b>from @jacob</b>.</div>
    </div>
  </div>
  <div class="split">
    <div class="panel" style="padding:16px">
      <div class="field" style="margin-bottom:12px"><label for="m-user">To</label>
        <input class="input" id="m-user" list="m-people" placeholder="U0ABC123 or a name" autocomplete="off">
        <datalist id="m-people"></datalist>
        <span class="hint">Pick someone from Users or paste their Slack id.</span></div>
      <div class="field" style="margin-bottom:12px"><label for="m-text">Message</label>
        <textarea id="m-text" placeholder="Write the message..."></textarea></div>
      <div style="display:flex;gap:10px;align-items:center">
        <button class="btn" type="button" id="m-send">Send DM</button>
        <span class="saved" id="m-status"></span>
      </div>
    </div>
    <div class="panel" style="padding:16px">
      <p class="label" style="margin-bottom:8px">Preview</p>
      <p class="small muted" style="margin-bottom:10px">It arrives as a DM from Orbit.</p>
      <div style="border:1px solid var(--line);border-radius:8px;padding:12px;background:var(--bg-2)">
        <p class="small" id="m-preview" style="white-space:pre-wrap">Your message<br><br><span class="muted">from @jacob</span></p>
      </div>
    </div>
  </div>`,

  admin: () => `  <div class="page-head">
    <div>
      <p class="kicker">admin</p>
      <h1>Admin</h1>
      <div class="desc">What the integration can and cannot see.</div>
    </div>
  </div>
  <div class="section"><div class="section-head"><h2>Slack permissions</h2></div>
    <div class="panel flush"><div class="table-wrap"><table>
      <thead><tr><th>Permission</th><th>Status</th><th>Detail</th></tr></thead>
      <tbody id="admin-permissions"></tbody></table></div></div></div>
  <div class="section"><div class="section-head"><h2>Huddles without a channel</h2></div>
    <div class="panel flush"><div class="table-wrap"><table>
      <thead><tr><th>Total</th><th>No channel</th><th>No thread</th><th>Active</th><th>Ended</th></tr></thead>
      <tbody id="admin-orphans"></tbody></table></div></div></div>
  <div class="section"><div class="section-head"><h2>Membership</h2></div>
    <div class="panel flush"><div class="table-wrap"><table>
      <thead><tr><th>Item</th><th>Value</th></tr></thead>
      <tbody id="admin-membership"></tbody></table></div></div></div>`,

  'j-log': () => `  <div class="page-head">
    <div>
      <p class="kicker">daily update</p>
      <h1>Daily update</h1>
      <div class="desc">Draft the standup, set the question, and check what has been sent.</div>
    </div>
  </div>
  <div class="split">
    <div>
      <div class="section"><div class="section-head"><h2>Draft</h2><span class="tag" id="draft-state">draft</span></div>
        <div class="panel" style="padding:16px;display:grid;gap:12px">
          <div class="field"><label for="j-main">Main update</label><textarea id="j-main"></textarea></div>
          <div class="field"><label for="j-song">Song</label><textarea id="j-song" style="min-height:56px"></textarea></div>
          <div class="field"><label for="j-event">Event</label><textarea id="j-event" style="min-height:56px"></textarea></div>
          <div style="display:flex;gap:8px;align-items:center">
            <button class="btn" type="button" id="j-save">Save draft</button>
            <button class="btn ghost" type="button" id="j-clear">Clear</button>
            <span class="saved" id="j-saved">saved</span>
          </div>
        </div>
      </div>
      <div class="section"><div class="section-head"><h2>Daily question</h2></div>
        <div class="panel" style="padding:16px;display:grid;gap:12px">
          <div class="field"><label for="q-prompt">Prompt</label><textarea id="q-prompt"></textarea></div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div class="field"><label for="q-time">Send at</label><input class="input" id="q-time" type="time"></div>
            <div class="field"><label for="q-enabled">Enabled</label><select id="q-enabled"><option value="1">Yes</option><option value="0">No</option></select></div>
          </div>
          <div class="field"><label for="q-reply">Reply prompt</label><input class="input" id="q-reply"></div>
          <div><button class="btn" type="button" id="q-save">Save question</button></div>
        </div>
      </div>
    </div>
    <aside>
      <div class="section"><div class="section-head"><h2>Recent questions</h2></div>
        <div class="panel"><ul class="lead" id="q-history"></ul></div>
      </div>
    </aside>
  </div>`,
};

const APP_SCRIPT = `
const $ = (id) => document.getElementById(id);
const base = '';
const view = document.documentElement.dataset.view || 'dashboard';
const num = new Intl.NumberFormat();

function esc(value){
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}

async function api(path, options){
  const opts = Object.assign({ headers: { accept: 'application/json' } }, options || {});
  if (opts.body && !opts.headers['content-type']) {
    opts.headers = Object.assign({ 'content-type': 'application/json' }, opts.headers);
  }
  let response;
  try { response = await fetch(path, opts); } catch (error) { throw new Error('network'); }
  if (response.status === 401) {
    window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname);
    throw new Error('auth');
  }
  const data = await response.json().catch(function () { return {}; });
  if (data && data.sike) { showSike(); throw new Error('sike'); }
  if (!response.ok) throw new Error(data.error || 'request failed');
  return data;
}

let sikeTimer = null;
function showSike(){
  const node = $('sike');
  if (!node) return;
  node.classList.remove('hidden');
  clearTimeout(sikeTimer);
  sikeTimer = setTimeout(function () { node.classList.add('hidden'); }, 2200);
}

function dur(seconds){
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return h + 'h ' + String(m).padStart(2, '0') + 'm';
  if (m) return m + 'm ' + String(s).padStart(2, '0') + 's';
  return s + 's';
}

function when(epoch){
  const at = new Date((Number(epoch) || 0) * 1000);
  const mins = Math.round(Math.max(0, Date.now() - at.getTime()) / 60000);
  const label = mins < 1 ? 'just now' : mins < 60 ? mins + 'm ago' : mins < 2160 ? Math.round(mins / 60) + 'h ago' : at.toISOString().slice(0, 10);
  return '<span title="' + at.toISOString().replace('T', ' ').slice(0, 16) + 'Z">' + label + '</span>';
}

function personCell(name, imageUrl, userId){
  const img = imageUrl
    ? '<img class="av" src="' + esc(imageUrl) + '" alt="">'
    : '<span class="av">' + esc((name || '?').slice(0, 2).toUpperCase()) + '</span>';
  return '<span class="cell-person">' + img + '<span class="stack"><span class="name">' + esc(name || userId) + '</span></span></span>';
}

function huddleRows(rows){
  if (!rows || !rows.length) return '<tr><td colspan="6" class="empty-cell">No huddles yet.</td></tr>';
  return rows.map(function (h) {
    const length = dur(h.durationSeconds) + (h.isLive ? ' live' : '');
    return '<tr>' +
      '<td class="nowrap"><a href="' + esc(h.url) + '">' + when(h.startedAt) + '</a></td>' +
      '<td class="nowrap">' + esc(h.channelName || h.channelId) + '</td>' +
      '<td class="num">' + length + '</td>' +
      '<td class="num">' + num.format(h.members) + '</td>' +
      '<td class="num">' + (h.points ? num.format(h.points) : '&mdash;') + '</td>' +
      '<td class="act"><a class="btn ghost tiny" href="' + esc(h.url) + '">Open</a></td>' +
    '</tr>';
  }).join('');
}

function boardRows(rows, viewer){
  if (!rows || !rows.length) return '<li><span class="empty">No points yet.</span></li>';
  return rows.map(function (row) {
    const me = viewer && viewer.userId === row.userId;
    return '<li' + (me ? ' class="me"' : '') + '>' +
      '<span class="r">' + row.rank + '</span>' +
      personCell(row.displayName, row.imageUrl, row.userId) +
      '<span class="p">' + num.format(row.points) + '</span>' +
    '</li>';
  }).join('');
}

function channelRows(channels){
  if (!channels || !channels.length) return '<tr><td colspan="6" class="empty-cell">No channels yet.</td></tr>';
  return channels.map(function (c) {
    const state = c.locked ? 'Private' : c.paused ? 'Paused' : c.enabled ? 'Tracking' : 'Off';
    const dotClass = c.locked ? '' : c.paused ? 'warn' : c.enabled ? 'on' : '';
    const stats = c.stats || {};
    return '<tr>' +
      '<td><button class="linkish" data-channel="' + esc(c.id) + '">' + esc(c.name) + '</button></td>' +
      '<td><span class="tag"><span class="dot ' + dotClass + '"></span>' + state + '</span></td>' +
      '<td class="num">' + (c.locked ? '&mdash;' : num.format(stats.total || 0)) + '</td>' +
      '<td class="num">' + (c.locked ? '&mdash;' : num.format(stats.members || 0)) + '</td>' +
      '<td class="num">' + (c.locked ? '&mdash;' : num.format(c.managerCount || 0)) + '</td>' +
      '<td class="act"><a class="btn ghost tiny" href="/channels">Manage</a></td>' +
    '</tr>';
  }).join('');
}

async function initAgreement(){
  const slot = $('agreement');
  if (!slot) return;

  function render(data){
    slot.classList.remove('hidden');
    if (data.required) {
      slot.innerHTML =
        '<div class="agree">' +
          '<div>' +
            '<p class="kicker">one thing first</p>' +
            '<h2>' + esc(data.title) + '</h2>' +
            '<p class="agree-body">' + esc(data.body) + '</p>' +
            '<p class="hint">' + esc(data.note) + '</p>' +
          '</div>' +
          '<div class="agree-actions">' +
            '<button class="btn" type="button" data-agree="1">Allow</button>' +
            '<button class="btn ghost" type="button" data-agree="0">No thanks</button>' +
          '</div>' +
        '</div>';
      return;
    }
    slot.innerHTML =
      '<div class="agree-row">' +
        '<span>' + esc(data.title) + ':</span>' +
        '<span class="tag ' + (data.agreed ? 'ok' : '') + '">' + (data.agreed ? 'allowed' : 'off') + '</span>' +
        '<button class="linkish small" type="button" data-agree="' + (data.agreed ? '0' : '1') + '">' +
          (data.agreed ? 'Turn off' : 'Turn on') +
        '</button>' +
      '</div>';
  }

  slot.addEventListener('click', function (event) {
    const button = event.target.closest('button[data-agree]');
    if (!button) return;
    const agreed = button.dataset.agree === '1';
    button.disabled = true;
    api('/api/me/agreement', { method: 'POST', body: JSON.stringify({ agreed: agreed }) })
      .then(render)
      .catch(function () { button.disabled = false; });
  });

  api('/api/me/agreement').then(render).catch(function () {});
}

async function initMyPoints(){
  const slot = $('my-points');
  if (!slot) return;
  const data = await api('/api/me/points');
  if (!data.items || !data.items.length) return;
  slot.classList.remove('hidden');
  slot.innerHTML =
    '<p class="label">Your ' + num.format(data.total) + ' points</p>' +
    '<ul class="mine-list">' +
      data.items.map(function (item) {
        return '<li><span>' + esc(item.label) + '</span><span class="mono">' + num.format(item.points) + '</span></li>';
      }).join('') +
    '</ul>';
}

async function initDashboard(){
  const set = function (id, text) { const el = $(id); if (el) el.textContent = text; };

  api('/api/overview').then(function (data) {
    set('k-active', num.format(data.active));
    set('k-24h', num.format(data.ended24h));
    set('k-people', num.format(data.people));
    set('k-points', num.format(data.points));
    set('k-channels', num.format(data.channels));
    const state = data.uptime.state;
    const dot = $('state-dot');
    if (dot) dot.className = 'dot ' + (state === 'ok' || state === 'operational' ? 'on' : '');
    set('state-text', state);
    set('foot-updated', 'updated ' + new Date(data.generatedAt).toISOString().slice(11, 19) + 'Z');
    set('foot-status', 'up ' + dur(data.uptime.seconds) + ' · longest ' + (data.longestSeconds ? dur(data.longestSeconds) : 'none') + ' · average ' + (data.averageSeconds ? dur(data.averageSeconds) : 'none'));
  }).catch(function () {});

  api('/api/leaderboard').then(function (data) {
    $('board').innerHTML = boardRows(data.rows, data.viewer);
    set('board-scope', data.rows.length + ' people');
    const slot = $('optin-slot');
    if (!slot) return;
    if (!data.viewer || !data.viewer.signedIn) { slot.innerHTML = ''; return; }
    slot.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding-bottom:10px;margin-bottom:4px;border-bottom:1px solid var(--line)">' +
      '<span class="small muted">' + (data.viewer.isOwner ? 'You see every score' : 'Hide yourself from the board') + '</span>' +
      '<label class="sw"><input type="checkbox" id="optin"' + (data.viewer.leaderboardOptIn ? ' checked' : '') + '><i></i></label></div>';
    const input = $('optin');
    if (input) input.addEventListener('change', function () {
      api('/api/me/opt-in', { method: 'POST', body: JSON.stringify({ optedIn: input.checked }) })
        .then(function () { initDashboard(); })
        .catch(function () { input.checked = !input.checked; });
    });
  }).catch(function () {});

  api('/api/huddles?limit=8').then(function (data) {
    $('recent-body').innerHTML = huddleRows(data.huddles);
  }).catch(function () {
    const body = $('recent-body');
    if (body) body.innerHTML = '<tr><td colspan="6" class="empty-cell">Could not load huddles.</td></tr>';
  });

  api('/api/channels').then(function (data) {
    $('channels-body').innerHTML = channelRows(data.channels);
    set('channels-tag', data.channels.length + ' channels');
  }).catch(function () {});

  setInterval(function () {
    api('/api/overview').then(function (data) {
      set('k-active', num.format(data.active));
      set('k-24h', num.format(data.ended24h));
      set('k-people', num.format(data.people));
      set('k-points', num.format(data.points));
      set('k-channels', num.format(data.channels));
    }).catch(function () {});
  }, 10000);
}

async function initHuddles(){
  let channelsReady = false;
  async function load(){
    const sort = $('f-sort').value;
    const channel = $('f-channel').value;
    let path = '/api/huddles?limit=60&sort=' + encodeURIComponent(sort);
    if (channel) path += '&channel=' + encodeURIComponent(channel);
    const data = await api(path);
    $('huddle-body').innerHTML = huddleRows(data.huddles);
    $('huddle-count').textContent = data.huddles.length + ' of ' + data.total;
    if (!channelsReady) {
      channelsReady = true;
      $('f-channel').innerHTML = '<option value="">All channels</option>' + data.channels
        .slice().sort(function (a, b) { return a.name.localeCompare(b.name); })
        .map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>'; }).join('');
    }
  }
  $('f-sort').addEventListener('change', function () { load().catch(function () {}); });
  $('f-channel').addEventListener('change', function () { load().catch(function () {}); });
  load().catch(function () {
    $('huddle-body').innerHTML = '<tr><td colspan="6" class="empty-cell">Could not load huddles.</td></tr>';
  });
}

function slug(name){
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

async function initChannels(){
  const saved = $('ch-saved');
  function flash(){ if (!saved) return; saved.classList.add('on'); setTimeout(function () { saved.classList.remove('on'); }, 1200); }

  async function load(){
    const data = await api('/api/huddles/config');
    const rows = data.channels.map(function (c) {
      const managers = (c.owners || []).map(function (o) {
        return '<span class="chip">' + (o.name ? esc(o.name) : '') +
          '<img src="/avatar?u=' + encodeURIComponent(o.id) + '" alt="" onerror="this.style.display=\\'none\\'">' +
          '<button type="button" data-remove="' + esc(c.channelId) + ':' + esc(o.id) + '" aria-label="Remove manager">&times;</button></span>';
      }).join('');
      return '<tr data-channel="' + esc(c.channelId) + '">' +
        '<td><div class="stack"><span class="name">' + esc(c.name || c.channelId) + '</span><span class="sub mono">' + esc(c.channelId) + '</span></div></td>' +
        ['enabled', 'auto_replies', 'restrict_triggers', 'condensed_review', 'paused'].map(function (flag) {
          const checked = flag === 'paused' ? c.paused : c[flag] === true || c[flag] === 1 || c[flag] === '1' || c[flag];
          return '<td><label class="sw"><input type="checkbox" data-flag="' + flag + '"' + (checked ? ' checked' : '') + '><i></i></label></td>';
        }).join('') +
        '<td><div class="chips">' + managers +
          '<input class="input" style="width:96px;height:24px;font-size:11px" placeholder="U0ABC123" data-add="' + esc(c.channelId) + '"></div></td>' +
      '</tr>';
    }).join('');
    $('channels-config').innerHTML = rows || '<tr><td colspan="7" class="empty-cell">No channels configured.</td></tr>';

    const available = data.available || [];
    const section = $('available-section');
    if (section) {
      section.innerHTML = available.length
        ? '<div class="section-head"><h2>Not tracked yet</h2><span class="tag">' + available.length + '</span></div>' +
          '<div class="panel flush"><div class="table-wrap"><table><thead><tr><th>Channel</th><th></th></tr></thead><tbody>' +
          available.map(function (c) {
            return '<tr><td>' + esc(c.name || c.channelId) + '</td><td class="act"><button class="btn ghost tiny" data-track="' + esc(c.channelId) + '">Track</button></td></tr>';
          }).join('') + '</tbody></table></div></div>'
        : '';
    }
  }

  $('channels-config').addEventListener('change', function (event) {
    const input = event.target.closest('input[data-flag]');
    if (!input) return;
    const row = input.closest('tr');
    const channelId = row.dataset.channel;
    const flag = input.dataset.flag;
    const body = { channelId: channelId };
    body[flag] = input.checked ? 1 : 0;
    api('/api/huddles/config', { method: 'POST', body: JSON.stringify(body) })
      .then(flash)
      .catch(function () { input.checked = !input.checked; });
  });

  $('channels-config').addEventListener('click', function (event) {
    const remove = event.target.closest('button[data-remove]');
    if (remove) {
      const parts = remove.dataset.remove.split(':');
      api('/api/huddles/owners', { method: 'POST', body: JSON.stringify({ channelId: parts[0], remove: parts[1] }) })
        .then(load).catch(function () {});
      return;
    }
  });

  $('channels-config').addEventListener('keydown', function (event) {
    const input = event.target.closest('input[data-add]');
    if (!input || event.key !== 'Enter') return;
    event.preventDefault();
    const value = input.value.trim().toUpperCase();
    if (!value) return;
    api('/api/huddles/owners', { method: 'POST', body: JSON.stringify({ channelId: input.dataset.add, add: value }) })
      .then(load).catch(function () {});
  });

  document.addEventListener('click', function (event) {
    const track = event.target.closest('button[data-track]');
    if (!track) return;
    api('/api/huddles/config', { method: 'POST', body: JSON.stringify({ channelId: track.dataset.track, enabled: 1 }) })
      .then(load).catch(function () {});
  });

  load().catch(function () {
    $('channels-config').innerHTML = '<tr><td colspan="7" class="empty-cell">Could not load channels.</td></tr>';
  });
}

async function initRecaps(){
  const data = await api('/api/huddles/config');
  $('recap-channels').innerHTML = data.channels.map(function (c) {
    const s = slug(c.name || c.channelId) || c.channelId;
    return '<tr><td><div class="stack"><span class="name">' + esc(c.name || c.channelId) + '</span><span class="sub mono">/' + esc(s) + '/recaps</span></div></td>' +
      '<td class="num">' + num.format(c.recapCount || 0) + '</td>' +
      '<td><a class="linkish small" href="/' + encodeURIComponent(s) + '/recaps" target="_blank" rel="noopener">Open page</a></td>' +
      '<td class="act"><button class="btn ghost tiny" data-view="' + esc(c.channelId) + '" data-name="' + esc(c.name || c.channelId) + '">Review</button></td></tr>';
  }).join('') || '<tr><td colspan="4" class="empty-cell">No channels yet.</td></tr>';

  $('recap-channels').addEventListener('click', async function (event) {
    const button = event.target.closest('button[data-view]');
    if (!button) return;
    const channelId = button.dataset.view;
    $('recap-view-title').textContent = 'Submissions · ' + button.dataset.name;
    $('recap-view-section').classList.remove('hidden');
    $('recap-view').innerHTML = '<tr><td colspan="4" class="empty-cell">loading</td></tr>';
    try {
      const submissions = await api('/api/recaps?channelId=' + encodeURIComponent(channelId));
      $('recap-view').innerHTML = submissions.recaps.length
        ? submissions.recaps.map(function (entry) {
            return '<tr><td class="nowrap">' + esc(String(entry.created_at || '').slice(0, 16)) + '</td>' +
              '<td class="mono small">' + esc(entry.user_id) + '</td>' +
              '<td style="white-space:normal">' + esc(entry.body) + '</td>' +
              '<td class="small">' + (entry.links || []).map(function (link) {
                return '<a href="' + esc(link) + '" target="_blank" rel="noopener">' + esc(link.replace(/^https:\\/\\//, '')) + '</a>';
              }).join('<br>') + '</td></tr>';
          }).join('')
        : '<tr><td colspan="4" class="empty-cell">No submissions.</td></tr>';
    } catch (error) {
      $('recap-view').innerHTML = '<tr><td colspan="4" class="empty-cell">Could not load submissions.</td></tr>';
    }
  });
}

async function initUsers(){
  const data = await api('/api/admin/users');
  const counts = data.counts || {};
  $('u-owner').textContent = counts.owner || 0;
  $('u-manager').textContent = counts.manager || 0;
  $('u-user').textContent = counts.user || 0;
  $('u-total').textContent = data.users.length;
  $('users-body').innerHTML = data.users.map(function (user) {
    return '<tr>' +
      '<td>' + personCell(user.name, '/avatar?u=' + encodeURIComponent(user.id), user.id) + '</td>' +
      '<td><span class="tag' + (user.role === 'owner' ? ' ok' : '') + '">' + esc(user.role) + '</span></td>' +
      '<td class="nowrap small muted">' + (user.lastLoginAt ? esc(String(user.lastLoginAt).slice(0, 16)) : 'never') + '</td>' +
      '<td>' + (user.optedIn ? 'on' : 'off') + '</td>' +
      '<td class="act"><button class="btn ghost tiny" data-fake="' + esc(user.id) + '" data-on="' + (user.fakeAdmin ? '1' : '0') + '">Admin: ' + (user.fakeAdmin ? 'on' : 'off') + '</button></td>' +
    '</tr>';
  }).join('') || '<tr><td colspan="5" class="empty-cell">No users.</td></tr>';

  $('users-body').addEventListener('click', function (event) {
    const button = event.target.closest('button[data-fake]');
    if (!button) return;
    button.disabled = true;
    api('/api/admin/fake-admins', { method: 'POST', body: JSON.stringify({ userId: button.dataset.fake, enabled: button.dataset.on !== '1' }) })
      .then(initUsers)
      .catch(function () { button.disabled = false; });
  });
}

async function initMessages(){
  try {
    const data = await api('/api/admin/users');
    $('m-people').innerHTML = data.users.map(function (user) {
      return '<option value="' + esc(user.id) + '">' + esc(user.name || user.id) + '</option>';
    }).join('');
  } catch (error) {}

  const preview = function () {
    const text = $('m-text').value.trim();
    $('m-preview').innerHTML = esc(text || 'Your message') + '<br><br><span class="muted">from @jacob</span>';
  };
  $('m-text').addEventListener('input', preview);
  $('m-send').addEventListener('click', function () {
    const userId = $('m-user').value.trim().toUpperCase();
    const text = $('m-text').value.trim();
    const status = $('m-status');
    if (!userId || !text) { status.textContent = 'need a person and a message'; return; }
    $('m-send').disabled = true;
    status.textContent = '';
    api('/api/admin/messages', { method: 'POST', body: JSON.stringify({ userId: userId, text: text }) })
      .then(function () { status.textContent = 'sent'; $('m-text').value = ''; preview(); })
      .catch(function () { status.textContent = 'not sent'; })
      .finally(function () { $('m-send').disabled = false; });
  });
}

async function initAdmin(){
  const data = await api('/api/admin');
  $('admin-permissions').innerHTML = data.permissions.map(function (p) {
    return '<tr><td>' + esc(p.label) + '</td><td><span class="tag ' + (p.granted ? 'ok' : 'bad') + '">' + (p.granted ? 'granted' : 'missing') + '</span></td><td class="small muted">' + esc(p.detail) + '</td></tr>';
  }).join('');
  const o = data.orphans;
  $('admin-orphans').innerHTML = '<tr><td class="num">' + o.total + '</td><td class="num">' + o.noChannel + '</td><td class="num">' + o.noThread + '</td><td class="num">' + o.active + '</td><td class="num">' + o.ended + '</td></tr>';
  $('admin-membership').innerHTML = Object.keys(data.membership).map(function (key) {
    return '<tr><td>' + esc(key) + '</td><td class="small muted" style="white-space:normal">' + esc(data.membership[key]) + '</td></tr>';
  }).join('');
}

async function initJLog(){
  const data = await api('/api/j-log');
  const s = data.settings;
  $('j-main').value = data.draft ? data.draft.main_update_text : '';
  $('j-song').value = data.draft ? data.draft.song_text : '';
  $('j-event').value = data.draft ? data.draft.event_text : '';
  $('q-prompt').value = s.daily_question_prompt || '';
  $('q-time').value = s.daily_question_send_time || '09:00';
  $('q-enabled').value = Number(s.daily_question_enabled) ? '1' : '0';
  $('q-reply').value = s.daily_question_reply_text || '';
  $('q-history').innerHTML = (data.recentQuestions || []).map(function (q) {
    return '<li><span class="n">' + esc(q) + '</span></li>';
  }).join('') || '<li><span class="empty">Nothing yet.</span></li>';

  $('j-save').addEventListener('click', function () {
    api('/api/j-log/draft', { method: 'POST', body: JSON.stringify({ main_update_text: $('j-main').value, song_text: $('j-song').value, event_text: $('j-event').value }) })
      .then(function () { $('j-saved').classList.add('on'); setTimeout(function () { $('j-saved').classList.remove('on'); }, 1200); })
      .catch(function () {});
  });
  $('j-clear').addEventListener('click', function () {
    api('/api/j-log/draft', { method: 'POST', body: JSON.stringify({ clear: true }) })
      .then(function () { $('j-main').value = ''; $('j-song').value = ''; $('j-event').value = ''; })
      .catch(function () {});
  });
  $('q-save').addEventListener('click', function () {
    api('/api/j-log/settings', { method: 'POST', body: JSON.stringify({
      daily_question_prompt: $('q-prompt').value,
      daily_question_send_time: $('q-time').value,
      daily_question_enabled: Number($('q-enabled').value),
      daily_question_reply_text: $('q-reply').value,
    }) }).catch(function () {});
  });
}

if (view === 'dashboard') { initAgreement(); initMyPoints().catch(function () {}); initDashboard(); }
else if (view === 'huddles') initHuddles().catch(function () {});
else if (view === 'channels') initChannels().catch(function () {});
else if (view === 'recaps') initRecaps().catch(function () {});
else if (view === 'users') initUsers().catch(function () {});
else if (view === 'messages') initMessages().catch(function () {});
else if (view === 'admin') initAdmin().catch(function () {});
else if (view === 'j-log') initJLog().catch(function () {});
`;

function icon(name) {
  const paths = {
    users:
      '<circle cx="9" cy="8" r="3.2"/><path d="M3 19a6 6 0 0112 0"/><path d="M16 5.5a3 3 0 010 5.8M17 19a5.5 5.5 0 00-2-4.3"/>',
    chart: '<path d="M4 19V5M4 19h16M8 16v-5M12 16V8M16 16v-3"/>',
    sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
    pen: '<path d="M4 20l4-1 10-10-3-3L5 16z"/><path d="M13 6l3 3"/>',
    send: '<path d="M21 3L10 14"/><path d="M21 3l-7 18-4-7-7-4z"/>',
    shield: '<path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z"/><path d="M9 12l2 2 4-4"/>',
  };
  return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function escapeAttr(value) {
  return escapeHtml(value);
}

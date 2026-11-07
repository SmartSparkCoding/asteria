import { ORBIT_FAVICON, ORBIT_MARK_SVG, THEME_TOKENS } from './theme.js';

export const RECAP_POLICY = (channelName) =>
  `I allow this message to be recorded and stored by Orbit, shown to the admins of #${channelName}, and used in a recap. I confirm it is my own message and that linking it is fine.`;

/** Turn a channel name into the slug used in /<slug>/recaps. */
export function channelSlug(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * A Slack permalink for a message in this channel. We only need to know that
 * the link points at this channel; the admins review the content later.
 */
export function parseRecapLink(link, channelId) {
  const text = String(link || '').trim();
  const match = /^https:\/\/[a-z0-9.-]+\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10,})/i.exec(text);
  if (!match) {
    return null;
  }
  if (channelId && match[1] !== channelId) {
    return null;
  }
  return text;
}

export function renderRecapPage({ channel, submissions = [], error = '', notice = '' }) {
  const policy = RECAP_POLICY(channel.name || channel.id);
  const items = submissions.length
    ? submissions
        .map(
          (entry) => `<li class="sub">
  <p>${escapeHtml(entry.body)}</p>
  ${(entry.links || []).map((link) => `<a class="lnk" href="${escapeAttr(link)}" target="_blank" rel="noopener">${escapeHtml(link.replace(/^https:\/\//, ''))}</a>`).join(' ')}
  <span class="when">${escapeHtml(String(entry.created_at || '').slice(0, 16))}</span>
</li>`,
        )
        .join('')
    : '<li class="none">Nothing submitted yet.</li>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Recaps · #${escapeHtml(channel.name || channel.id)} · Jacob's Orbit</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(ORBIT_FAVICON)}" type="image/svg+xml">
<style>
${THEME_TOKENS}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;color:var(--ink);font-family:var(--sans);font-size:15px;line-height:1.55;
  background:radial-gradient(900px 420px at 60% -10%,var(--glow),transparent 65%),var(--bg)}
.topbar{display:flex;align-items:center;gap:10px;padding:16px clamp(16px,4vw,32px);border-bottom:1px solid var(--hair)}
.brand{display:flex;align-items:center;gap:10px;color:var(--ink);font-weight:680;text-decoration:none}
.mark{display:grid;place-items:center;width:32px;height:32px;border-radius:10px;color:var(--accent);
  background:var(--tint);box-shadow:inset 0 0 0 1px var(--ring)}
main{max-width:760px;margin:0 auto;padding:clamp(22px,4vw,40px) clamp(16px,4vw,32px) 64px}
.kicker{margin:0 0 8px;font-size:9.5px;letter-spacing:.22em;text-transform:uppercase;color:var(--accent);font-weight:750}
h1{margin:0 0 8px;font-size:clamp(26px,4vw,38px);letter-spacing:-.03em;line-height:1.05}
.sub{color:var(--ink-3);margin:0 0 22px;max-width:60ch}
.panel{background:linear-gradient(170deg,var(--stage-top),var(--stage-bottom));border-radius:18px;
  box-shadow:inset 0 0 0 1px var(--hair),var(--lift);padding:20px}
label{display:block;font-size:12px;font-weight:650;color:var(--ink-2);margin:0 0 6px}
textarea,input[type=text]{width:100%;background:var(--bg);color:var(--ink);border:1px solid var(--hair);
  border-radius:10px;padding:10px 12px;font:inherit;font-size:14px}
textarea{min-height:120px;resize:vertical;font-family:var(--mono);font-size:13px}
textarea:focus,input[type=text]:focus{outline:none;border-color:var(--accent)}
.field{margin-bottom:16px}
.hint{display:block;margin-top:6px;font-size:11.5px;color:var(--ink-3)}
.policy{display:flex;gap:10px;align-items:flex-start;background:var(--raised);border-radius:12px;padding:12px 14px;
  font-size:12.5px;color:var(--ink-2);margin-bottom:16px}
.policy input{margin-top:3px}
.btn{display:inline-flex;align-items:center;justify-content:center;font:inherit;font-size:14px;font-weight:680;
  color:var(--ctp-crust);background:var(--accent);border:0;border-radius:999px;padding:10px 18px;cursor:pointer}
.btn:hover{background:var(--accent-bright)}
.btn[disabled]{opacity:.5;cursor:not-allowed}
.status{margin-left:10px;font-size:12.5px;color:var(--ink-3)}
.err{background:var(--red-tint);box-shadow:inset 0 0 0 1px var(--red-ring);color:var(--ink);border-radius:12px;
  padding:12px 14px;font-size:13px;margin-bottom:16px}
.notice{background:var(--tint);box-shadow:inset 0 0 0 1px var(--ring);border-radius:12px;padding:12px 14px;
  font-size:13px;margin-bottom:16px}
h2{font-size:10px;letter-spacing:.17em;text-transform:uppercase;color:var(--ink-3);margin:26px 0 10px;font-weight:750}
.list{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.sub{background:var(--surface);box-shadow:inset 0 0 0 1px var(--hair);border-radius:12px;padding:12px 14px}
.sub p{margin:0 0 6px;font-size:13.5px}
.sub .lnk{display:inline-block;font-family:var(--mono);font-size:11.5px;color:var(--accent-bright);margin-right:8px}
.sub .when{display:block;font-size:11px;color:var(--ink-3);margin-top:6px}
.none{color:var(--ink-3);font-size:13px}
</style>
</head>
<body>
<header class="topbar">
  <a class="brand" href="/"><span class="mark">${ORBIT_MARK_SVG}</span><span>Jacob's Orbit</span></a>
</header>
<main>
  <p class="kicker">orbit recaps</p>
  <h1>Recap #${escapeHtml(channel.name || channel.id)}</h1>
  <p class="sub">Funny moments from this channel's huddles. Paste the moment, and link your own messages if you have them. Submitted to the channel admins for a recap.</p>
  ${error ? `<div class="err">${escapeHtml(error)}</div>` : ''}
  ${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ''}
  <section class="panel">
    <form id="recap-form">
      <div class="field">
        <label for="recap-body">What happened</label>
        <textarea id="recap-body" maxlength="2000" placeholder="the bit where..."></textarea>
        <span class="hint">One moment per submission. Keep it to things you are happy to see in a recap.</span>
      </div>
      <div class="field">
        <label for="recap-links">Links to your messages (optional)</label>
        <textarea id="recap-links" placeholder="https://hackclub.slack.com/archives/${escapeHtml(channel.id)}/p..." style="min-height:64px"></textarea>
        <span class="hint">One Slack permalink per line. They must be messages in #${escapeHtml(channel.name || channel.id)}.</span>
      </div>
      <label class="policy">
        <input type="checkbox" id="recap-policy">
        <span>${escapeHtml(policy)}</span>
      </label>
      <button class="btn" type="submit" id="recap-send">Submit</button>
      <span class="status" id="recap-status"></span>
    </form>
  </section>
  <h2>Your submissions</h2>
  <ul class="list" id="recap-list">${items}</ul>
</main>
<script>
(function () {
  var channelId = ${JSON.stringify(channel.id)};
  var form = document.getElementById('recap-form');
  var status = document.getElementById('recap-status');
  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    var body = document.getElementById('recap-body').value.trim();
    var links = document.getElementById('recap-links').value.split(/\\s+/).map(function (v) { return v.trim(); }).filter(Boolean);
    var accepted = document.getElementById('recap-policy').checked;
    if (!body) { status.textContent = 'write something first'; return; }
    if (!accepted) { status.textContent = 'tick the policy box first'; return; }
    var button = document.getElementById('recap-send');
    button.disabled = true;
    status.textContent = 'sending...';
    try {
      var response = await fetch('/api/recaps', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channelId: channelId, body: body, links: links, accepted: accepted }),
      });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok) { throw new Error(data.error || 'could not submit'); }
      status.textContent = 'submitted';
      document.getElementById('recap-body').value = '';
      document.getElementById('recap-links').value = '';
      document.getElementById('recap-policy').checked = false;
      window.location.reload();
    } catch (error) {
      status.textContent = error.message;
      button.disabled = false;
    }
  });
})();
</script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}
function escapeAttr(value) {
  return escapeHtml(value);
}

import { ORBIT_FAVICON, ORBIT_MARK_SVG, THEME_TOKENS } from './theme.js';

const SITE = (process.env.ORBIT_SITE_URL || 'https://orbit.navaratne.uk').replace(/\/+$/, '');

/**
 * Hosts that used to be the product and now only carry the rebrand notice.
 * Kept in env-shaped form so a future move does not need a code change, and
 * defaulted to the two names this bot actually answered on.
 */
function legacyHosts() {
  return (process.env.ORBIT_LEGACY_HOSTS || 'asteria.navaratne.uk,asteria.mini-jacob.hackclub.app')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

export function isLegacyHost(hostHeader) {
  const host = String(hostHeader || '')
    .split(':')[0]
    .trim()
    .toLowerCase();
  return Boolean(host) && legacyHosts().includes(host);
}

/**
 * The one page served on the old host.
 *
 * It keeps the path, so a saved huddle link or an App Home link still lands on
 * the same page after the move. Nothing needs JavaScript to get there, and the
 * redirect is slow enough to read the sentence but happens even if the button is
 * ignored.
 */
export function renderRebrandPage({ path = '/', search = '' } = {}) {
  const target = `${SITE}${path === '/' ? '/' : path}${search}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>We have moved to Orbit</title>
<meta name="robots" content="noindex,follow">
<meta name="color-scheme" content="dark">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(ORBIT_FAVICON)}" type="image/svg+xml">
<style>
${THEME_TOKENS}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;
  background:radial-gradient(820px 380px at 50% 0%,var(--glow),transparent 70%),var(--bg);
  color:var(--ink);font-family:var(--sans);font-size:15px;line-height:1.55;
  -webkit-font-smoothing:antialiased}
main{width:100%;max-width:520px;background:var(--surface);border-radius:var(--r-lg);
  box-shadow:0 0 0 1px var(--line),0 24px 60px var(--shadow);padding:28px 28px 24px}
.mark{display:grid;place-items:center;width:44px;height:44px;border-radius:var(--r);
  color:var(--accent);background:var(--raised);box-shadow:0 0 0 1px var(--line);margin-bottom:18px}
.kicker{margin:0 0 8px;font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--accent);font-weight:600}
h1{margin:0 0 10px;font-size:27px;line-height:1.15;letter-spacing:-.02em;font-weight:650}
h1 span{color:var(--accent)}
p{margin:0 0 10px;color:var(--ink-2)}
p.small{margin:18px 0 0;font-size:12.5px;color:var(--ink-3)}
.btn{display:inline-flex;align-items:center;gap:8px;margin-top:14px;font:inherit;font-size:14px;
  font-weight:650;color:var(--ctp-crust);background:var(--accent);border:0;border-radius:var(--r-sm);
  padding:10px 16px;text-decoration:none}
.btn:hover{background:var(--accent-bright)}
.btn:focus-visible{outline:2px solid var(--accent-bright);outline-offset:2px}
.host{font-family:var(--mono);font-size:12.5px;color:var(--ink-3)}
</style>
</head>
<body>
<main>
  <div class="mark">${ORBIT_MARK_SVG}</div>
  <p class="kicker">jacob's orbit</p>
  <h1>Hi! We have rebranded to <span>Orbit</span>.</h1>
  <p>You are on the old address. All your points and access have been moved over, and it is the same bot, just with a new name, new features and a new style.</p>
  <p>Nothing to sign in again for. The link below takes you to the same page on the new site.</p>
  <a class="btn" href="${escapeAttr(target)}">Take me to Orbit</a>
  <p class="small">Taking you to <span class="host">${escapeAttr(SITE.replace(/^https?:\/\//, ''))}</span> in <span id="count">10</span> seconds.</p>
</main>
<script>
(function () {
  var target = ${JSON.stringify(target)};
  var el = document.getElementById('count');
  var left = 10;
  setInterval(function () {
    left -= 1;
    if (el) el.textContent = String(Math.max(0, left));
    if (left <= 0) window.location.replace(target);
  }, 1000);
})();
</script>
</body>
</html>`;
}

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

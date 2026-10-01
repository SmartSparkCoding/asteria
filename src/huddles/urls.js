/**
 * The one place a huddle page URL is built.
 *
 * It exists because the URL was wrong in two places at once. The page lives at
 * the root, `/R0123ABCDEF`, but both the Slack summary and the App Home built
 * `/huddle/R0123ABCDEF`, which the server does not route, so every link the bot
 * has ever posted in a channel was a hard 404. Tests asserted the broken string
 * too, so nothing caught it: they checked that a URL was produced, not that it
 * resolved.
 *
 * The route is served from `^\/(R[0-9A-Z]{6,20})$` in dashboard/server.js. If
 * that route ever moves, change it here and nowhere else.
 */
export function huddlePageUrl(baseUrl, callId) {
  if (!baseUrl || !callId) {
    return '';
  }
  return `${baseUrl}/${encodeURIComponent(callId)}`;
}

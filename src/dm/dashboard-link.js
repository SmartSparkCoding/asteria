/**
 * DM the bot "dashboard" and it replies with a one-time sign in link.
 *
 * Slack's own OAuth round trip is the nicer door when it works, but it depends
 * on app configuration Jacob has to apply by hand, and it failed silently for a
 * while. A link the bot sends into a DM it controls proves the same thing
 * without any of that: whoever can read the bot's DM can open the link, and the
 * link drops them straight onto a signed in dashboard.
 *
 * The reply only ever goes back to the person who messaged the bot, in their own
 * DM. Nothing here can start a conversation with anyone else.
 */

const TRIGGERS = new Set(['dashboard', 'signin', 'sign in', 'login', 'log in', 'website', 'site']);

// Phrases that are only ever a request for the link. Kept separate from the
// triggers above so that a message merely *about* the dashboard, such as "the
// dashboard looks broken", does not get answered with a sign in link.
const REQUESTS = [
  'asteria dashboard',
  'sign me in',
  'let me in',
  'send me the link',
  'magic link',
  'one-time code',
  'where is the site',
  'where is the dashboard',
];

function isDirectMessage(payload) {
  const message = payload.message ?? payload.event ?? {};
  return message.channel_type === 'im' || String(message.channel || '').startsWith('D');
}

function requestedLink(text) {
  const normalized = String(text || '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) {
    return false;
  }
  if ([...TRIGGERS].some((trigger) => normalized === trigger || normalized.startsWith(`${trigger} `))) {
    return true;
  }
  return REQUESTS.some((phrase) => normalized.includes(phrase));
}

export function registerDmDashboardLink({ app, client, auth, store, logger, baseUrl }) {
  async function handleDirectMessage(payload) {
    const message = payload.message ?? payload.event ?? {};
    if (!isDirectMessage(payload) || message.subtype || message.bot_id || message.user === undefined) {
      return;
    }
    if (!requestedLink(message.text)) {
      return;
    }
    const slackUserId = message.user;
    let link;
    try {
      link = auth.issueMagicLink(slackUserId, baseUrl);
    } catch (error) {
      logger.error('Could not issue a dashboard sign in link', error);
      return;
    }
    try {
      await client.chat.postMessage({
        channel: message.channel,
        text: `Here is your Orbit dashboard link: ${link} It signs you in straight away and expires in 10 minutes. If you did not ask for it, ignore this message and nothing happens.`,
      });
      store?.recordTriggerLog?.({
        userId: slackUserId,
        action: 'dashboard_link_sent',
        detail: message.channel,
        channelId: message.channel,
      });
    } catch (error) {
      logger.error('Could not DM a dashboard sign in link', error);
    }
  }

  app.message(async ({ message, event }) => {
    try {
      await handleDirectMessage({ message: message ?? event });
    } catch (error) {
      logger.error('Handle dashboard link DM', error);
    }
  });
}

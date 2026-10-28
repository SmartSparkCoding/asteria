import {
  contentToMrkdwn,
  formatDailyQuestionMessage,
  formatDailyUpdateMessage,
  formatUserGroupMention,
  replaceWelcomePlaceholders,
} from '../utils/messages.js';

const USER_GROUP_CACHE_TTL_MS = 5 * 60 * 1000;
const OWNER_PROFILE_CACHE_TTL_MS = 5 * 60 * 1000;
const DISPLAY_NAME_CACHE_TTL_MS = 60 * 60 * 1000;

let cachedUserGroups = [];
let cachedUserGroupsAt = 0;

let cachedOwnerIdentity = null;
let cachedOwnerIdentityAt = 0;
let cachedOwnerUserId = '';

/**
 * Slack id -> display name, for the many ids in a huddle review.
 *
 * Slack's `display_name` is what people set for themselves and is usually the
 * friendliest thing to call them. The fallbacks exist because display_name is
 * often blank and may be restricted from bots.
 */
const displayNameCache = new Map();

function pickDisplayName(profile = {}) {
  return profile.display_name || profile.real_name || profile.real_name_normalized || '';
}

/**
 * Resolve display names for a set of Slack ids, keyed by id.
 *
 * Used to name people in messages without mentioning them, so reading a huddle
 * review does not notify everyone who was in the call. Unknown ids are simply
 * absent from the result: the caller decides how to label them, and a lookup
 * failure must never fail the message.
 */
export async function resolveDisplayNames(client, slackUserIds, { forceRefresh = false } = {}) {
  const unique = [...new Set(ensureArray(slackUserIds).filter(Boolean))];
  const now = Date.now();
  const byId = {};

  const missing = [];
  for (const id of unique) {
    const cached = displayNameCache.get(id);
    if (!forceRefresh && cached && now - cached.fetchedAt < DISPLAY_NAME_CACHE_TTL_MS) {
      if (cached.name) {
        byId[id] = cached.name;
      }
    } else {
      missing.push(id);
    }
  }

  const results = await Promise.all(
    missing.map(async (id) => {
      try {
        const response = await client.users.info({ user: id });
        const name = pickDisplayName(response?.user?.profile || {});
        // Cache misses too, so a deactivated or unknown id cannot be re-requested
        // on every single huddle.
        displayNameCache.set(id, { name, fetchedAt: Date.now() });
        return { id, name };
      } catch {
        displayNameCache.set(id, { name: '', fetchedAt: Date.now() });
        return { id, name: '' };
      }
    }),
  );

  for (const { id, name } of results) {
    if (name) {
      byId[id] = name;
    }
  }
  return byId;
}

export function clearDisplayNameCache() {
  displayNameCache.clear();
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

export function normalizeUserGroups(responseBody) {
  return ensureArray(responseBody?.usergroups).map((group) => ({
    id: group.id,
    name: group.name,
    handle: group.handle,
    description: group.description || '',
  }));
}

export async function fetchUserGroups(client, { forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && cachedUserGroups.length > 0 && now - cachedUserGroupsAt < USER_GROUP_CACHE_TTL_MS) {
    return cachedUserGroups;
  }

  try {
    const response = await client.usergroups.list({ include_users: false });
    cachedUserGroups = normalizeUserGroups(response);
    cachedUserGroupsAt = now;
    return cachedUserGroups;
  } catch {
    return cachedUserGroups;
  }
}

export async function resolveOwnerIdentity(client, ownerUserId) {
  const response = await client.users.profile.get({ user: ownerUserId });
  const profile = response?.profile ?? {};
  return {
    displayName: profile.display_name || profile.real_name || '',
    iconUrl: profile.image_512 || profile.image_192 || profile.image_48 || '',
  };
}

export async function fetchOwnerIdentity(client, ownerUserId, { forceRefresh = false } = {}) {
  const now = Date.now();
  if (
    !forceRefresh &&
    cachedOwnerIdentity &&
    cachedOwnerUserId === ownerUserId &&
    now - cachedOwnerIdentityAt < OWNER_PROFILE_CACHE_TTL_MS
  ) {
    return cachedOwnerIdentity;
  }

  try {
    const identity = await resolveOwnerIdentity(client, ownerUserId);
    cachedOwnerIdentity = identity;
    cachedOwnerUserId = ownerUserId;
    cachedOwnerIdentityAt = now;
    return identity;
  } catch {
    if (cachedOwnerUserId === ownerUserId && cachedOwnerIdentity) {
      return cachedOwnerIdentity;
    }
    return { displayName: '', iconUrl: '' };
  }
}

export async function ensureDirectMessageChannel(client, userId) {
  const response = await client.conversations.open({ users: userId });
  return response.channel.id;
}

/**
 * The only sanctioned way for this bot to DM a person. Members complained about
 * unsolicited DMs, so the policy is enforced here rather than at each call site:
 *
 * - `reminder`: the bot is nudging somebody who did not ask. Owner only, and the
 *   owner is the configured personal-channel owner, so reminders can only ever
 *   reach Jacob.
 * - `reply`: the person already started the conversation or clicked the button
 *   that asked for this (sign-in code, "why are you quiet?", "yes, review my
 *   huddle"). Never used for anything the bot decides on its own.
 *
 * Anything that would DM somebody unprompted must not call this at all.
 */
export async function sendDirectMessage(
  client,
  userId,
  text,
  { kind = 'reply', ownerUserId = null, logger = null } = {},
) {
  if (!userId) {
    logger?.warn?.('Refusing to send a DM without a recipient');
    return { ok: false, skipped: 'no-recipient' };
  }
  if (kind === 'reminder' && ownerUserId && userId !== ownerUserId) {
    logger?.warn?.(`Refusing to DM ${userId}: reminders are owner-only`);
    return { ok: false, skipped: 'not-owner' };
  }
  try {
    const channelId = await ensureDirectMessageChannel(client, userId);
    const response = await client.chat.postMessage({ channel: channelId, text });
    return { ok: true, channel: channelId, ts: response?.ts, kind };
  } catch (error) {
    logger?.error?.(`Failed to DM ${userId} (${kind})`, error);
    throw error;
  }
}

export async function addUserToUserGroup(client, userGroupId, userId) {
  const currentUsers = await fetchUserGroupUsers(client, userGroupId);
  if (currentUsers.includes(userId)) {
    return { users: currentUsers };
  }
  return client.usergroups.users.update({ usergroup: userGroupId, users: [...currentUsers, userId].join(',') });
}

export async function removeUserFromUserGroup(client, userGroupId, userId) {
  const currentUsers = await fetchUserGroupUsers(client, userGroupId);
  if (!currentUsers.includes(userId)) {
    return { users: currentUsers };
  }
  return client.usergroups.users.update({
    usergroup: userGroupId,
    users: currentUsers.filter((member) => member !== userId).join(','),
  });
}

export async function fetchUserGroupUsers(client, userGroupId) {
  const response = await client.usergroups.users.list({ usergroup: userGroupId });
  return response.users || [];
}

export function buildDailyUpdateText(settings, draft, questionText, stepsText = '') {
  return formatDailyUpdateMessage({
    userGroupId: settings.daily_update_ping_user_group_id,
    mainUpdateText: draft.main_update_text,
    songText: draft.song_text,
    eventText: draft.event_text,
    questionText,
    stepsText,
    includeQuestion: settings.daily_question_include_in_daily_update,
  });
}

function buildDailyUpdateIdentity(ownerIdentity, botName) {
  if (ownerIdentity.displayName && ownerIdentity.iconUrl) {
    return {
      username: ownerIdentity.displayName,
      icon_url: ownerIdentity.iconUrl,
    };
  }

  if (ownerIdentity.displayName) {
    return {
      username: ownerIdentity.displayName,
    };
  }

  return {
    username: botName || "Jacob's Orbit",
  };
}

export async function sendDailyUpdate(client, settings, draft, questionText, { sentByUserId, stepsText = '' }) {
  const text = buildDailyUpdateText(settings, draft, questionText, stepsText);
  const botName = settings.bot_display_name || "Jacob's Orbit";
  const ownerIdentity = await fetchOwnerIdentity(client, settings.personal_channel_owner_id);
  const dailyUpdateIdentity = buildDailyUpdateIdentity(ownerIdentity, botName);

  const response = await client.chat.postMessage({
    channel: settings.personal_channel_id,
    text,
    ...dailyUpdateIdentity,
  });

  let threadTs = null;
  const followUpMessage = contentToMrkdwn(settings.daily_update_thread_message).trim();
  if (settings.daily_update_thread_enabled && followUpMessage) {
    const followUpResponse = await client.chat.postMessage({
      channel: settings.personal_channel_id,
      text: followUpMessage,
      username: botName,
    });

    threadTs = followUpResponse.ts || response.ts;
  }

  return {
    messageTs: response.ts,
    threadTs,
    text,
    sentByUserId,
    userGroupMention: formatUserGroupMention(settings.daily_update_ping_user_group_id),
  };
}

export async function sendDailyQuestion(client, settings, questionText) {
  const text = formatDailyQuestionMessage(questionText, settings.daily_question_reply_text);
  const response = await client.chat.postMessage({
    channel: settings.personal_channel_id,
    text,
    username: settings.bot_display_name || "Jacob's Orbit",
  });

  return {
    messageTs: response.ts,
    text,
  };
}

export async function sendWelcomeMessage(client, settings, { userId }) {
  const welcomeText = replaceWelcomePlaceholders(contentToMrkdwn(settings.welcome_message_content), { userId });
  const messageParts = [welcomeText];

  if (settings.rules_canvas_url?.trim()) {
    messageParts.push(`📖 Please read the rules here:\n${settings.rules_canvas_url.trim()}`);
  }

  const response = await client.chat.postMessage({
    channel: settings.personal_channel_id,
    text: messageParts.join('\n\n'),
    username: settings.bot_display_name || "Jacob's Orbit",
  });

  return response;
}

const CACHE_MS = 5 * 60 * 1000;
const MEMBERSHIP_PAGE_SIZE = 999;

function isMissingScope(error) {
  return error?.data?.error === 'missing_scope' || /missing_scope/.test(String(error?.message || ''));
}

/**
 * The channels the bot itself is a member of.
 *
 * Huddle and trigger events are workspace-wide, so anything user-facing has to be
 * filtered down to these. The membership list is read through `users.conversations`
 * for the bot's own user id: `conversations.list` would walk every channel in the
 * workspace (1700+ here, ~3.7s and rate limited) and its `is_member` field is not
 * populated for bot tokens, which made the filter silently match nothing.
 */
export function createBotChannelDirectory({ client, logger }) {
  let botUserId = '';
  let teamId = '';
  const nameCache = new Map();
  // Channel and DM memberships are cached separately: the logs only want real
  // channels, while point awards also need to recognise huddles held in a DM.
  const caches = {
    channels: { ids: [], fetchedAt: 0, ok: true },
    withDms: { ids: [], fetchedAt: 0, ok: true },
  };

  async function resolveBotUserId() {
    if (botUserId) {
      return botUserId;
    }
    const startedAt = Date.now();
    const auth = await client.auth.test();
    botUserId = auth?.user_id || '';
    logger?.info?.(`Resolved bot user id ${botUserId || '(none)'} in ${Date.now() - startedAt}ms`);
    if (!botUserId) {
      throw new Error('auth.test did not return a user_id');
    }
    return botUserId;
  }

  /**
   * Channel ids the bot is in, or an empty list when membership could not be
   * verified. Callers must treat the empty list as "show nothing" rather than
   * falling back to every channel we have ever seen a huddle in — that fallback
   * is what put unrelated channels and people in the logs.
   */
  async function list({ maxAgeMs = CACHE_MS, includeDms = false } = {}) {
    const key = includeDms ? 'withDms' : 'channels';
    const cache = caches[key];
    const now = Date.now();
    if (now - cache.fetchedAt < maxAgeMs) {
      return cache.ok ? cache.ids : [];
    }
    const startedAt = Date.now();
    const fetchIds = async (types) => {
      const user = await resolveBotUserId();
      const ids = [];
      let cursor = '';
      do {
        const page = await client.users.conversations({
          user,
          types,
          exclude_archived: true,
          limit: MEMBERSHIP_PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        });
        for (const conversation of page?.channels || []) {
          if (conversation?.id) {
            ids.push(conversation.id);
          }
        }
        cursor = page?.response_metadata?.next_cursor || '';
      } while (cursor);
      return ids;
    };

    try {
      const types = includeDms ? 'public_channel,private_channel,mpim,im' : 'public_channel,private_channel';
      let ids;
      try {
        ids = await fetchIds(types);
      } catch (error) {
        // Reading DM membership needs im:read and mpim:read, which this app does
        // not have, so Slack rejects the whole request. Letting that empty the
        // cache made every huddle look unverifiable and silently scored it zero,
        // including the channel huddles that have nothing to do with DMs. Channels
        // are the common case and readable, so fall back to those and say why.
        if (!includeDms || !isMissingScope(error)) {
          throw error;
        }
        logger?.warn?.(
          'App cannot read DM or group-DM membership (needs im:read and mpim:read), so huddles held in a DM cannot be verified for points; continuing with channels only',
        );
        ids = await fetchIds('public_channel,private_channel');
      }
      caches[key] = { ids, fetchedAt: now, ok: true };
      logger?.info?.(
        `Bot is in ${ids.length} ${includeDms ? 'channel(s) or DMs' : 'channel(s)'}; membership lookup took ${Date.now() - startedAt}ms`,
      );
      return ids;
    } catch (error) {
      caches[key] = { ids: [], fetchedAt: now, ok: false };
      logger?.error?.('Failed to resolve the channels the bot is in', error);
      return [];
    }
  }

  /**
   * Display names for channel ids, resolved from Slack and cached for the
   * process lifetime. Configured channels can be saved with a blank name (they
   * were seeded from ids), and the huddle rows only carry a name if something
   * happened to record one, so without this the dashboard prints raw `C…` ids.
   *
   * `conversations.info` is called with form encoding on purpose: this workspace
   * answers a JSON body with `invalid_arguments` and silently loses the `channel`
   * argument, which looks like the channel does not exist.
   */
  async function names(channelIds) {
    const wanted = [...new Set((channelIds || []).filter(Boolean))].filter((id) => !nameCache.has(id));
    for (const id of wanted) {
      try {
        const response = await client.apiCall('conversations.info', {
          method: 'POST',
          body: new URLSearchParams({ channel: id }),
        });
        if (response?.ok && response.channel?.name) {
          nameCache.set(id, response.channel.name.replace(/^#/, ''));
        } else if (response?.error) {
          logger?.info?.(`Could not resolve a name for ${id}: ${response.error}`);
        }
      } catch (error) {
        logger?.info?.(`Could not resolve a name for ${id}: ${error?.data?.error || error?.message || error}`);
      }
    }
    const resolved = {};
    for (const id of channelIds || []) {
      if (nameCache.has(id)) {
        resolved[id] = nameCache.get(id);
      }
    }
    return resolved;
  }

  /** Workspace team id, needed to build working slack:// profile links. */
  async function team() {
    if (teamId) {
      return teamId;
    }
    try {
      const auth = await client.auth.test();
      teamId = auth?.team_id || '';
    } catch (error) {
      logger?.warn?.(`Could not resolve the workspace team id: ${error?.data?.error || error?.message || error}`);
      teamId = '';
    }
    return teamId;
  }

  return {
    list,
    names,
    team,
    invalidate: () => {
      caches.channels = { ids: [], fetchedAt: 0, ok: true };
      caches.withDms = { ids: [], fetchedAt: 0, ok: true };
      nameCache.clear();
    },
  };
}

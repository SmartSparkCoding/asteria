const CACHE_MS = 5 * 60 * 1000;
const MEMBERSHIP_PAGE_SIZE = 999;

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
  let cache = { ids: [], fetchedAt: 0, ok: true };

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
  async function list({ maxAgeMs = CACHE_MS } = {}) {
    const now = Date.now();
    if (now - cache.fetchedAt < maxAgeMs) {
      return cache.ok ? cache.ids : [];
    }
    const startedAt = Date.now();
    try {
      const user = await resolveBotUserId();
      const ids = [];
      let cursor = '';
      do {
        const page = await client.users.conversations({
          user,
          types: 'public_channel,private_channel',
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
      cache = { ids, fetchedAt: now, ok: true };
      logger?.info?.(`Bot is in ${ids.length} channel(s); membership lookup took ${Date.now() - startedAt}ms`);
      return ids;
    } catch (error) {
      cache = { ids: [], fetchedAt: now, ok: false };
      logger?.error?.('Failed to resolve the channels the bot is in', error);
      return [];
    }
  }

  return {
    list,
    invalidate: () => {
      cache = { ids: [], fetchedAt: 0, ok: true };
    },
  };
}

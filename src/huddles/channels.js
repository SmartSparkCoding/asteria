import { parseOwnerIds } from '../permissions.js';

/**
 * The one channel list both surfaces use.
 *
 * Before this, the dashboard only listed channels with a settings row that the
 * bot was still in, while App Home listed every configured channel plus any
 * channel with a recorded huddle, including ones the bot had left. The same
 * channel could therefore be visible in one place and missing in the other, and
 * the two screens disagreed about what "tracked" meant.
 *
 * The rule is now explicit and shared:
 *   - only channels the bot is currently in are listed, because it cannot track
 *     or announce anywhere else;
 *   - a channel with no settings row is not silently dropped, it is offered as
 *     `available` (owner only) so it can be adopted;
 *   - a manager sees exactly the channels they own; the owner sees all of them.
 *
 * `names` comes from Slack so a channel never renders as a raw C… id when the
 * settings row was created without one.
 */
export async function describeHuddleChannels({ store, botChannels, userId = '' }) {
  const viewerId = String(userId || '');
  const isOwner = Boolean(viewerId) && viewerId === store.getSettings().personal_channel_owner_id;

  let botIds = null;
  let names = {};
  if (botChannels?.list) {
    try {
      botIds = await botChannels.list();
    } catch {
      // Unknown membership is treated as "nothing to show", never as every
      // channel we have ever heard of.
      botIds = [];
    }
    if (botChannels.names && Array.isArray(botIds) && botIds.length > 0) {
      names = await botChannels.names(botIds).catch(() => ({}));
    }
  }
  const inBot = Array.isArray(botIds) ? new Set(botIds) : null;

  const rows = store.listHuddleChannels();
  const configuredIds = new Set(rows.map((row) => row.channel_id));
  const now = Math.floor(Date.now() / 1000);

  const channels = rows
    .filter((row) => !inBot || inBot.has(row.channel_id))
    .filter((row) => isOwner || parseOwnerIds(row.owner_ids).includes(viewerId))
    .map((row) => {
      const pausedUntil = Number(row.paused_until) || 0;
      return {
        channelId: row.channel_id,
        name: row.name || names[row.channel_id] || '',
        enabled: Number(row.enabled) === 1,
        autoReplies: Number(row.auto_replies) === 1,
        restrictTriggers: Number(row.restrict_triggers) === 1,
        condensed: Number(row.condensed_review) === 1,
        ownerIds: parseOwnerIds(row.owner_ids),
        pausedUntil,
        paused: pausedUntil > now,
        configured: true,
      };
    })
    .sort((a, b) => (a.name || a.channelId).localeCompare(b.name || b.channelId));

  const available =
    isOwner && inBot
      ? botIds
          .filter((id) => !configuredIds.has(id))
          .map((id) => ({ channelId: id, name: names[id] || '' }))
          .sort((a, b) => (a.name || a.channelId).localeCompare(b.name || b.channelId))
      : [];

  return { channels, available, isOwner, membershipKnown: Boolean(inBot) };
}

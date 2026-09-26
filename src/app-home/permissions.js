const SLACK_USER_ID_PATTERN = /^[UW][0-9A-Z]{2,}$/;

/** Accepts "U123, U456", "<@U123>", whitespace — keeps only plausible Slack IDs, in order. */
export function parseOwnerIdList(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.filter((id) => typeof id === 'string' && SLACK_USER_ID_PATTERN.test(id)))];
  }
  const text = typeof value === 'string' ? value : '';
  const found = text.match(/[UW][0-9A-Z]{2,}/g) || [];
  return [...new Set(found)];
}

/**
 * Who may touch what, in one place.
 *
 * The app owner may do everything. Everyone else may only configure the channels
 * they are listed as an owner of in the huddle channel settings. Random users get
 * the read-only leaderboard.
 */
export function createChannelPermissions({ store }) {
  function isOwner(userId) {
    return userId === store.getSettings().personal_channel_owner_id;
  }

  function configuredChannelOwnerIds() {
    return new Set(store.listHuddleChannels().flatMap((row) => parseOwnerIdList(row.owner_ids)));
  }

  function isChannelOwner(userId) {
    return configuredChannelOwnerIds().has(userId);
  }

  function mayConfigureChannel(userId, channelId) {
    if (isOwner(userId)) {
      return true;
    }
    return parseOwnerIdList(store.getHuddleChannel(channelId)?.owner_ids).includes(userId);
  }

  return { isOwner, isChannelOwner, configuredChannelOwnerIds, mayConfigureChannel };
}

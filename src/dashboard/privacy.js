/**
 * Decides whether a channel's huddle detail may be shown on a surface that
 * anyone can load.
 *
 * The rule the product actually agreed on is narrow: a public surface may show
 * a channel's Flaron metadata and its aggregate time and points, and nothing
 * that identifies a person. A name, a face, or a per-person row is the thing
 * that turns "this channel has huddles" into "these people were in it".
 *
 * `huddle_channels.is_private` is the stored answer and is deliberately
 * tri-state, because a channel we have never asked Slack about must not be
 * assumed public:
 *
 *   0  public
 *   1  private
 *  -1  never checked, or the check failed
 *
 * Anything other than 0 is treated as private. That is the whole point of the
 * -1 default: an unanswered lookup hides detail rather than publishing it.
 */

/**
 * A channel counts as public only when Slack has positively said so.
 *
 * Deliberately not `Number(isPrivate) === 0`. That coerces `null`, `''` and
 * `false` to 0, so an unanswered lookup would read as a positive "public" and
 * publish a private channel's detail. Only the real number counts.
 */
export function isChannelPublic(isPrivate) {
  return isPrivate === 0;
}

/**
 * Whether an anonymous viewer may see a channel at all.
 *
 * Private and unchecked channels stay visible as a card, because hiding them
 * would make the dashboard lie about how much huddling is happening. What they
 * do not get is the name or anything per-person.
 */
export function channelIsVisible() {
  return true;
}

/**
 * The label to show a channel that a given viewer is allowed to identify.
 *
 * Unidentified channels fall back to the raw id rather than a Slack link,
 * which would render as "#unknown" in some contexts.
 */
export function channelLabel({ name, channelId, isPrivate, canIdentify }) {
  if (!canIdentify || !isChannelPublic(isPrivate)) {
    return channelId;
  }
  return name || channelId;
}

/**
 * Per-person data is the sharp edge, so it is gated on its own rather than
 * riding along with the channel being visible.
 *
 * Only a public channel on a surface whose viewer is trusted gets names. That
 * covers the owner and a channel manager looking at their own channel, and
 * excludes the anonymous dashboard, which is served to anyone with the URL.
 */
export function canShowPeople({ isPrivate, isOwner, isManager, permissions, channelId }) {
  if (!isChannelPublic(isPrivate)) {
    return false;
  }
  if (isOwner) {
    return true;
  }
  return Boolean(
    isManager && Array.isArray(permissions?.managedChannelIds) && permissions.managedChannelIds.includes(channelId),
  );
}

/**
 * Reduce a leaderboard row to what a public surface may show.
 *
 * Public surfaces get the number and nothing else, so a person cannot be
 * re-identified by joining their points to a name elsewhere on the page.
 */
export function anonymiseRow(row) {
  return { userId: '', displayName: 'Someone', realName: '', pronouns: '', imageUrl: '', points: row.points ?? 0 };
}

const IN_HUDDLE = 'in_a_huddle';

/**
 * Pure reducer for `user_huddle_changed` events.
 *
 * Resolves the follow-up actions for a single user's huddle state transition.
 * `prev` is the last state we persisted for that user, or null on first boot.
 * `event` is the relevant slice of the event payload.
 *
 * Returns an array of actions, each `{ type: 'join' | 'leave', callId }`.
 * A user switching straight from one huddle to another (rare) yields both a
 * leave and a join so both membership windows are recorded.
 */
export function nextUserHuddleAction(prev, { huddleState, callId }) {
  const isInHuddle = huddleState === IN_HUDDLE;

  if (isInHuddle) {
    if (!callId) {
      return [];
    }
    if (prev?.is_in && prev.call_id && prev.call_id !== callId) {
      return [
        { type: 'leave', callId: prev.call_id },
        { type: 'join', callId },
      ];
    }
    return [{ type: 'join', callId }];
  }

  const previousCallId = callId || prev?.call_id;
  if (prev?.is_in && previousCallId) {
    return [{ type: 'leave', callId: previousCallId }];
  }
  return [];
}

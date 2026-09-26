import { parseMessageLink } from '../utils/messages.js';

/**
 * DM the bot a Slack message link and it deletes that message.
 *
 * Only the app owner and the channel managers (the owners configured for that
 * channel) may do this. Any attempt from anyone else is refused in the DM and
 * written to the trigger log, so it is visible in the Logs tab.
 */
export function registerDmDeleteByLink({ app, store, client, logger, permissions }) {
  function isDirectMessage(payload) {
    const message = payload.message ?? payload.event ?? {};
    return (message.channel_type === 'im' || String(message.channel || '').startsWith('D')) === true;
  }

  function firstMessageLink(text) {
    for (const candidate of String(text || '').match(/https?:\/\/\S+/g) || []) {
      const parsed = parseMessageLink(candidate);
      if (parsed) {
        return parsed;
      }
    }
    return null;
  }

  async function handleDirectMessage(payload) {
    const message = payload.message ?? payload.event ?? {};
    if (!isDirectMessage(payload) || message.subtype || message.bot_id) {
      return;
    }
    const userId = message.user || '';
    const parsed = firstMessageLink(message.text);
    if (!parsed) {
      return;
    }

    if (!permissions.mayConfigureChannel(userId, parsed.channel)) {
      store.recordTriggerLog({
        userId,
        action: 'delete_message_denied',
        detail: `not a manager of ${parsed.channel}`,
        channelId: parsed.channel,
      });
      logger.info(`Refused a DM delete from ${userId} for ${parsed.channel}: not a manager`);
      await reply(
        client,
        message.channel,
        `Sorry <@${userId}> — you are not a manager of <#${parsed.channel}>, so I did not delete anything.`,
      );
      return;
    }

    store.recordTriggerLog({
      userId,
      action: 'delete_message',
      detail: `${parsed.channel}/${parsed.ts}`,
      channelId: parsed.channel,
    });
    try {
      await client.chat.delete({ channel: parsed.channel, ts: parsed.ts });
      await reply(client, message.channel, `Deleted the message in <#${parsed.channel}> (\`${parsed.ts}\`).`);
    } catch (error) {
      const reason = String(error?.data?.error || error?.message || error);
      logger.error('Failed to delete a message requested over DM', error);
      store.recordTriggerLog({
        userId,
        action: 'delete_message_failed',
        detail: `${parsed.channel}/${parsed.ts}: ${reason}`,
        channelId: parsed.channel,
      });
      await reply(
        client,
        message.channel,
        `I could not delete that message: ${reason}. Make sure I am in <#${parsed.channel}> and that the message is still there.`,
      );
    }
  }

  async function reply(replyClient, channel, text) {
    try {
      await (replyClient || client).chat.postMessage({ channel, text });
    } catch (error) {
      logger.error('Failed to answer a DM', error);
    }
  }

  app.message((payload) => {
    void handleDirectMessage(payload);
  });

  return { handleDirectMessage };
}

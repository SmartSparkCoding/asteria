import assert from 'node:assert';
import { describe, it } from 'node:test';
import { buildHomeView } from '../src/app-home/views.js';
import {
  formatDailyQuestionMessage,
  formatDailyUpdateMessage,
  formatUserGroupMention,
  isRepeatedQuestion,
  parseMessageLink,
  replaceWelcomePlaceholders,
} from '../src/utils/messages.js';
import { getLocalDateKey, isValidTimeZone } from '../src/utils/time.js';

describe('Asteria core helpers', () => {
  it('formats the Daily Update with optional song and event sections', () => {
    const message = formatDailyUpdateMessage({
      userGroupId: 'S123ABC',
      mainUpdateText: 'Ship it',
      songText: 'Never Gonna Give You Up',
      eventText: '',
      includeQuestion: false,
    });

    assert(message.includes('<!subteam^S123ABC>'));
    assert(message.includes('*DAILY UPDATE*'));
    assert(message.includes('Ship it'));
    assert(message.includes('Song of the Day: Never Gonna Give You Up'));
    assert(!message.includes('Event of the Day:'));
  });

  it('formats the Daily Question and user group mention syntax', () => {
    assert.equal(formatUserGroupMention('S123ABC'), '<!subteam^S123ABC>');
    assert.equal(
      formatDailyQuestionMessage('What is your favorite build this week?'),
      '❓ Daily Question\n\nWhat is your favorite build this week?\n\nReply to this message in a thread!',
    );
  });

  it('replaces welcome placeholders and detects repeated questions', () => {
    assert.equal(replaceWelcomePlaceholders('Welcome {user}!', { userId: 'U123' }), 'Welcome <@U123>!');
    assert.equal(isRepeatedQuestion('What is your favorite snack?', ['What is your favorite snack?']), true);
    assert.equal(isRepeatedQuestion('What is your favorite snack?', ['What is your favorite color?']), false);
  });

  it('validates time zones and derives a local date key', () => {
    assert.equal(isValidTimeZone('Europe/London'), true);
    assert.equal(isValidTimeZone('Definitely/NotAZone'), false);
    assert.match(getLocalDateKey(new Date('2026-08-03T12:00:00Z'), 'UTC'), /^2026-08-03$/);
  });

  it('shows the Leaderboard to non-owners on the App Home', () => {
    const view = buildHomeView({
      tab: 'leaderboard',
      settings: {
        personal_channel_owner_id: 'UOWNER',
        timezone: 'UTC',
        daily_question_enabled: true,
        welcomer_enabled: true,
        daily_update_reminder_enabled: true,
      },
      draft: { main_update_text: '', song_text: '', event_text: '' },
      questionPreview: '',
      recentQuestions: [],
      notice: '',
      userGroups: [],
      isOwner: false,
      leaderboard: [
        { user_id: 'UFRED', points: 42 },
        { user_id: 'UJAC', points: 17 },
      ],
    });

    assert.equal(view.type, 'home');
    assert.equal(view.callback_id, 'asteria_home_leaderboard');
    assert(view.blocks.some((block) => block.type === 'section' && block.text?.text.includes('<@UFRED> · *42 pts*')));
    assert(!view.blocks.some((block) => String(block.block_id || '').startsWith('navigation')));
  });

  it('parses Slack message permalinks into channel and ts', () => {
    assert.deepEqual(parseMessageLink('https://hackclub.slack.com/archives/C09RQFJCJ4U/p1790380910506989'), {
      channel: 'C09RQFJCJ4U',
      ts: '1790380910.506989',
    });
    assert.deepEqual(
      parseMessageLink('https://hackclub.slack.com/archives/D01234567/p1800000000000001?thread_ts=1.2'),
      {
        channel: 'D01234567',
        ts: '1800000000.000001',
      },
    );
    assert.equal(parseMessageLink('https://example.com/not-a-slack-link'), null);
    assert.equal(parseMessageLink(''), null);
  });
});

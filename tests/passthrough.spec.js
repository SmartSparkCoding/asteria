import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { DateTime } from 'luxon';
import { buildPassthroughChannelModal, buildPassthroughRequestModal } from '../src/app-home/modals.js';
import { buildPassthroughView } from '../src/app-home/views.js';
import { createStore } from '../src/database/store.js';
import {
  buildAnchorMessage,
  buildAnswersBlocks,
  buildDecisionMessage,
  buildDecisionResult,
  buildJoinMessage,
  buildRequestAnnouncement,
  buildVoteMessage,
  encodeOpenValue,
  encodeRequestMeta,
  formatQuestionLines,
  parseOpenValue,
  parseQuestionLines,
  parseRequestMeta,
  reapplyAt,
  resolveMainChannel,
  tallyText,
} from '../src/passthrough/requests.js';

let createdPaths = [];

afterEach(() => {
  for (const databasePath of createdPaths) {
    fs.rmSync(path.dirname(databasePath), { recursive: true, force: true });
  }
  createdPaths = [];
});

async function createTestStore() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-passthrough-'));
  const databasePath = path.join(tempDir, 'asteria.sqlite');
  createdPaths.push(databasePath);
  return createStore(databasePath);
}

describe('passthrough questions', () => {
  it('reads one question per line and marks the required ones', () => {
    const questions = parseQuestionLines('Why do you want in?\nWhat do you build? | required\n\n');
    assert.deepEqual(questions, [
      { id: 'q1', label: 'Why do you want in?', required: false },
      { id: 'q2', label: 'What do you build?', required: true },
    ]);
  });

  it('round-trips through the textarea format', () => {
    const questions = parseQuestionLines('One\nTwo | required');
    assert.equal(formatQuestionLines(questions), 'One\nTwo | required');
  });

  it('caps the form at ten questions', () => {
    const lines = Array.from({ length: 14 }, (_, index) => `Question ${index + 1}`).join('\n');
    assert.equal(parseQuestionLines(lines).length, 10);
  });

  it('drops blank lines instead of making empty questions', () => {
    assert.deepEqual(parseQuestionLines('\n\n   \n'), []);
  });
});

describe('passthrough messages', () => {
  it('puts the entry form button in the channel with the channel id as its value', () => {
    const message = buildAnchorMessage({ channelId: 'C123', label: 'Builders', questionCount: 2 });
    const actions = message.blocks.find((block) => block.type === 'actions');
    assert.equal(actions.elements[0].action_id, 'passthrough_request_open');
    assert.equal(actions.elements[0].value, 'C123');
    assert.match(message.blocks[0].text.text, /2 questions/);
  });

  it('announces the request in the main channel and leaves the voting to the thread', () => {
    const message = buildRequestAnnouncement({ userId: 'U1', channelId: 'C123' });
    assert.equal(
      message.blocks.some((block) => block.type === 'actions'),
      false,
    );
    assert.match(message.text, /<@U1> wants to join <#C123>/);
    assert.match(message.text, /thread/);
  });

  it('shows the tally without naming a voter', () => {
    const text = tallyText({ yes: 3, no: 1 });
    assert.equal(text, 'Yes *3* · No *1* · 4 votes so far');
    const message = buildVoteMessage({
      request: { id: 7, user_id: 'U1', channel_id: 'C123' },
      counts: { yes: 3, no: 1 },
    });
    const actions = message.blocks.find((block) => block.type === 'actions');
    assert.deepEqual(
      actions.elements.map((element) => element.value),
      ['7:yes', '7:no'],
    );
    assert.equal(actions.elements[0].action_id, 'passthrough_vote');
    assert.doesNotMatch(JSON.stringify(message), /U2|U3|U4/);
  });

  it('keeps approve and deny on the manager-only decision message', () => {
    const message = buildDecisionMessage({ request: { id: 7, user_id: 'U1', channel_id: 'C123' }, ownerId: 'U9' });
    const actions = message.blocks.find((block) => block.type === 'actions');
    assert.deepEqual(
      actions.elements.map((element) => element.value),
      ['7:approve', '7:deny'],
    );
    assert.match(message.blocks[0].text.text, /<@U9>/);
  });

  it('says who decided once the request is settled', () => {
    const message = buildDecisionResult({
      request: { id: 7, user_id: 'U1', channel_id: 'C123' },
      decision: 'deny',
      byUserId: 'U9',
    });
    assert.match(message.text, /<@U9> denied <@U1>/);
  });

  it('waits ten days before a denied requester can fill it in again', () => {
    const decidedAt = '2026-11-15 11:00:00';
    const now = DateTime.fromSQL(decidedAt, { zone: 'utc' }).plus({ days: 3 });
    const wait = reapplyAt({ request: { status: 'denied', decided_at: decidedAt }, now });
    assert.equal(wait.toFormat('yyyy-LL-dd'), '2026-11-25');
    assert.equal(reapplyAt({ request: { status: 'approved', decided_at: decidedAt }, now }), null);
    assert.equal(reapplyAt({ request: { status: 'open' }, now }), null);
    assert.equal(
      reapplyAt({ request: { status: 'denied', decided_at: decidedAt }, now: now.plus({ days: 11 }) }),
      null,
    );
  });

  it('renders every answer, and says so when one was skipped', () => {
    const blocks = buildAnswersBlocks({
      request: {
        user_id: 'U1',
        created_at: '2026-11-15 11:00:00',
        answers: [
          { question: 'Why?', answer: 'I build robots' },
          { question: 'Where?', answer: '' },
        ],
      },
    });
    const text = blocks.map((block) => block.text?.text || '').join('\n');
    assert.match(text, /I build robots/);
    assert.match(text, /_not answered_/);
  });

  it('announces in the channel choice, then the main channel', () => {
    assert.equal(
      resolveMainChannel({ channel: { main_channel_id: 'Cmain' }, settings: { personal_channel_id: 'Cother' } }),
      'Cmain',
    );
    assert.equal(resolveMainChannel({ channel: {}, settings: { personal_channel_id: 'Cother' } }), 'Cother');
    assert.equal(resolveMainChannel({ channel: {}, settings: {} }), '');
  });

  it('names the person a join message is for, and only their button opens it', () => {
    const message = buildJoinMessage({ channelId: 'C123', userId: 'U1', label: 'Builders', questionCount: 2 });
    const text = message.blocks.map((block) => block.text?.text || '').join('\n');
    assert.match(text, /Welcome, <@U1>/);
    assert.match(text, /2 questions/);
    const button = message.blocks.find((block) => block.type === 'actions').elements[0];
    assert.equal(button.action_id, 'passthrough_request_open');
    assert.deepEqual(parseOpenValue(button.value), { channelId: 'C123', targetUserId: 'U1', test: false });
  });

  it('round-trips the button value and the modal metadata', () => {
    assert.deepEqual(parseOpenValue(encodeOpenValue({ channelId: 'C1', targetUserId: 'U2', test: true })), {
      channelId: 'C1',
      targetUserId: 'U2',
      test: true,
    });
    // A button posted before join messages existed only carried the channel id.
    assert.deepEqual(parseOpenValue('C1'), { channelId: 'C1', targetUserId: '', test: false });
    assert.deepEqual(parseRequestMeta(encodeRequestMeta({ channelId: 'C1', targetUserId: 'U2', test: true })), {
      channelId: 'C1',
      targetUserId: 'U2',
      test: true,
    });
    assert.deepEqual(parseRequestMeta('C1'), { channelId: 'C1', targetUserId: '', test: false });
    assert.deepEqual(parseRequestMeta('not json'), { channelId: 'not json', targetUserId: '', test: false });
  });

  it('marks a test form as a test rather than a request', () => {
    const message = buildJoinMessage({ channelId: 'C123', userId: 'U1', questionCount: 1, test: true });
    const text = message.blocks.map((block) => block.text?.text || '').join('\n');
    assert.match(text, /Test entry form/);
    assert.match(text, /1 question\b/);
    const button = message.blocks.find((block) => block.type === 'actions').elements[0];
    assert.equal(parseOpenValue(button.value).test, true);
  });
});

describe('passthrough store', () => {
  it('keeps the questions with the channel and updates them in place', async () => {
    const store = await createTestStore();
    store.upsertPassthroughChannel({
      channelId: 'C123',
      label: 'Builders',
      questions: parseQuestionLines('Why? | required'),
      mainChannelId: 'Cmain',
    });
    const saved = store.getPassthroughChannel('C123');
    assert.equal(saved.label, 'Builders');
    assert.deepEqual(saved.questions, [{ id: 'q1', label: 'Why?', required: true }]);

    store.upsertPassthroughChannel({
      channelId: 'C123',
      label: 'Builders 2',
      questions: parseQuestionLines('Why?\nWhat?'),
      mainChannelId: 'Cmain',
    });
    assert.equal(store.listPassthroughChannels().length, 1);
    assert.equal(store.getPassthroughChannel('C123').questions.length, 2);
  });

  it('remembers the anchor message so the button is edited, not reposted', async () => {
    const store = await createTestStore();
    store.upsertPassthroughChannel({ channelId: 'C123', questions: parseQuestionLines('Why?') });
    assert.equal(store.getPassthroughChannel('C123').anchor_ts, '');
    store.setPassthroughAnchor('C123', '1700000000.000100');
    assert.equal(store.getPassthroughChannel('C123').anchor_ts, '1700000000.000100');
  });

  it('counts one vote per person and lets them change their mind', async () => {
    const store = await createTestStore();
    store.upsertPassthroughChannel({ channelId: 'C123', questions: parseQuestionLines('Why?') });
    const request = store.createPassthroughRequest({
      channelId: 'C123',
      userId: 'U1',
      answers: [{ question: 'Why?', answer: 'robots' }],
      mainChannelId: 'Cmain',
    });
    store.recordPassthroughVote(request.id, 'U2', 'yes');
    store.recordPassthroughVote(request.id, 'U3', 'yes');
    store.recordPassthroughVote(request.id, 'U4', 'no');
    assert.deepEqual(store.countPassthroughVotes(request.id), { yes: 2, no: 1 });

    store.recordPassthroughVote(request.id, 'U4', 'yes');
    assert.deepEqual(store.countPassthroughVotes(request.id), { yes: 3, no: 0 });

    store.recordPassthroughVote(request.id, 'U4', '');
    assert.deepEqual(store.countPassthroughVotes(request.id), { yes: 2, no: 0 });
  });

  it('finds a request from the vote message it was posted on', async () => {
    const store = await createTestStore();
    store.upsertPassthroughChannel({ channelId: 'C123', questions: parseQuestionLines('Why?') });
    const request = store.createPassthroughRequest({
      channelId: 'C123',
      userId: 'U1',
      answers: [],
      mainChannelId: 'Cmain',
    });
    store.setPassthroughRequestMessages(request.id, { messageTs: '1.1', threadTs: '1.1', voteTs: '1.2' });
    assert.equal(store.getPassthroughRequestByVoteTs('1.2').id, request.id);
    assert.equal(store.getPassthroughRequestByVoteTs('9.9'), null);
  });

  it('lists open requests and closes them out', async () => {
    const store = await createTestStore();
    store.upsertPassthroughChannel({ channelId: 'C123', questions: parseQuestionLines('Why?') });
    const request = store.createPassthroughRequest({
      channelId: 'C123',
      userId: 'U1',
      answers: [],
      mainChannelId: 'Cmain',
    });
    assert.equal(store.listPassthroughRequests({ status: 'open' }).length, 1);
    store.setPassthroughRequestStatus(request.id, 'approved');
    assert.equal(store.listPassthroughRequests({ status: 'open' }).length, 0);
    assert.equal(store.getPassthroughRequest(request.id).status, 'approved');
  });
});

describe('passthrough modals and view', () => {
  it('asks the owner for a channel, a label and the questions', () => {
    const modal = buildPassthroughChannelModal({});
    assert.equal(modal.callback_id, 'passthrough_channel_submit');
    const ids = modal.blocks.map((block) => block.block_id);
    assert.ok(ids.includes('passthrough_channel_block'));
    assert.ok(ids.includes('passthrough_questions_block'));
  });

  it('prefills the form when editing an existing channel', () => {
    const modal = buildPassthroughChannelModal({
      channel: {
        channel_id: 'C123',
        label: 'Builders',
        questions: parseQuestionLines('Why? | required'),
      },
    });
    assert.equal(modal.private_metadata, 'C123');
    const questions = modal.blocks.find((block) => block.block_id === 'passthrough_questions_block');
    assert.equal(questions.element.initial_value, 'Why? | required');
  });

  it('gives the requester one input per question', () => {
    const modal = buildPassthroughRequestModal({
      channel: { channel_id: 'C123', questions: parseQuestionLines('Why? | required\nWhat?') },
    });
    assert.equal(modal.callback_id, 'passthrough_request_submit');
    assert.equal(modal.private_metadata, 'C123');
    const inputs = modal.blocks.filter((block) => block.type === 'input');
    assert.equal(inputs.length, 2);
    assert.equal(inputs[0].optional, false);
    assert.equal(inputs[1].optional, true);
  });

  it('lists the configured channels and the open requests', () => {
    const view = buildPassthroughView({
      channels: [
        {
          channel_id: 'C123',
          label: 'Builders',
          questions: parseQuestionLines('Why?'),
          anchor_ts: '1.1',
          main_channel_id: 'Cmain',
        },
      ],
      requests: [{ id: 1, user_id: 'U1', channel_id: 'C123', status: 'open', created_at: '2026-11-15 11:00:00' }],
      navigation: [],
    });
    const text = JSON.stringify(view);
    assert.match(text, /C123/);
    assert.match(text, /passthrough_add/);
    assert.match(text, /passthrough_edit_C123/);
    assert.match(text, /passthrough_post_C123/);
    assert.match(text, /passthrough_remove_C123/);
    assert.match(text, /Open requests \(1\)/);
  });
});

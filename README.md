# Asteria

Asteria is a cloneable personal channel companion bot for Slack. Fork this repository, create your own Slack app, and run an independent instance that posts Daily Updates, Daily Questions, and welcome messages to your own personal channel.

> **Designed to be hosted on [Hack Club Nest](https://hackclub.com/nest/).** It runs as a plain Node.js process with Socket Mode (no public webhook URL needed) and persists everything to a SQLite file, so it fits perfectly on a Nest server.

## What Is Asteria?

Asteria manages one specific Slack channel: your personal channel. You write a Daily Update in App Home, optionally add a song and an event, and send it to the channel with a single button press. The update posts under your own name and avatar. Asteria can also generate a daily question with Hack Club AI, ping a Slack user group in the Daily Update, remind you if you have not posted by the deadline, and welcome people who join the channel.

## Features

- Daily Updates sent manually from App Home.
- Daily Updates appear in the personal channel under your own name and avatar.
- Markdown-friendly update text with links, mentions, bullets, and line breaks.
- Optional Song of the Day and Event of the Day fields.
- Slack user group mentions for the Daily Update ping.
- Optional thread starter reply after posting the Daily Update.
- AI-powered Daily Question generation with Hack Club AI.
- **Fully editable AI prompt** — write the exact prompt sent to the model, with no tags or variables.
- Daily Question scheduling in your timezone.
- Optional inclusion of the Daily Question inside the Daily Update.
- Asteria generates a fresh AI question every time a Daily Update is sent, even when the automatic Daily Question is disabled.
- Test the Daily Question: preview the output or send it to the channel.
- Daily Update reminder DM if you have not posted by the deadline (automatically retried until it is delivered).
- Welcomer messages when people join the configured personal channel.
- Optional rules Canvas link in welcome messages.
- App Home configuration with Daily Update, Daily Question, Welcomer, Sync, and Settings tabs.
- Owner-only configuration access with restricted views for everyone else.
- Two-way Todoist ⇄ Slack List sync: list additions become Todoist tasks, completing a Todoist task marks the list item done and posts a message.
- Huddle stats: when a huddle in your workspace ends, Asteria DMs for an optional review with total duration, attendance, and the longest / shortest message in the huddle chat.
- SQLite persistence for settings, drafts, send history, question history, reminder state, and welcome deduplication.
- Socket Mode operation with no public webhook server.
- Optional status RSS feed for your bot (great for a Nest uptime monitor).

## Requirements

- Node.js 20 or newer.
- A Slack workspace where you can create and install apps.
- A Slack app created from the manifest in this repository.
- A Slack Bot User OAuth Token.
- A Slack App-Level Token with the `connections:write` scope.
- A Hack Club AI API key.
- A valid Hack Club AI model name, such as `qwen/qwen3-32b`.
- A Hack Club Nest server (or any Debian-based server) to run it on.

## Quick Start

1. **Fork or copy this repository** and clone it to your Nest server:

   ```sh
   git clone <your-repository-url>
   cd asteria
   npm install
   cp .env.example .env
   ```

2. **Create a Slack app** from `manifest.json` (see [Slack App Setup](#slack-app-setup)) and fill in your tokens in `.env`.
3. **Start the bot** and add it to your personal channel:

   ```sh
   npm start
   ```

4. Open Asteria's App Home, and you are ready to configure everything from there.

## Slack App Setup

1. Open the Slack app manifest flow at https://api.slack.com/apps and create a new app **from a manifest**.
2. Paste the contents of [manifest.json](manifest.json) into the manifest editor. Feel free to rename `Asteria` to something else — the display name in App Home and chat is just a label.
3. Create the app in your workspace.
4. Open the app's Basic Information page and enable Socket Mode.
5. Create an App-Level Token with the `connections:write` scope and copy it into `SLACK_APP_TOKEN`.
6. Install the app to your workspace and copy the Bot User OAuth Token into `SLACK_BOT_TOKEN`.
7. Copy your Slack user ID into `PERSONAL_CHANNEL_OWNER_ID`.
8. Copy your personal channel ID into `PERSONAL_CHANNEL_ID`.
9. Create or choose a Slack user group for the Daily Update ping and select it later in App Home.
10. **Add the bot to your personal channel** (open the channel, go to Details → More → Add apps, and pick your app). The bot needs to be in the channel to post messages and fire the welcomer.
11. Start Asteria.

If you change scopes in the manifest later, reinstall the app in Slack so the new scopes take effect.

## Environment Variables

| Variable                        | Required | Purpose                                                   | Default                            |
| ------------------------------- | -------- | --------------------------------------------------------- | ---------------------------------- |
| `SLACK_BOT_TOKEN`               | Yes      | Bot token used for Web API calls and message posting.     | None                               |
| `SLACK_APP_TOKEN`               | Yes      | App-level token used for Socket Mode.                     | None                               |
| `SLACK_SIGNING_SECRET`          | Yes      | Loaded for Bolt configuration consistency.                | None                               |
| `PERSONAL_CHANNEL_OWNER_ID`     | Yes      | Slack user ID of the only person allowed to edit Asteria. | None                               |
| `PERSONAL_CHANNEL_ID`           | Yes      | The Slack channel Asteria manages.                        | None                               |
| `HACKCLUB_AI_KEY`               | Yes      | Hack Club AI API key.                                     | None                               |
| `HACKCLUB_AI_MODEL`             | No       | Hack Club AI model to use for Daily Questions.            | `qwen/qwen3-32b`                   |
| `HACKCLUB_AI_BASE_URL`          | No       | OpenAI-compatible Hack Club AI base URL.                  | `https://ai.hackclub.com/proxy/v1` |
| `ASTERIA_DB_PATH`               | No       | Path to the SQLite database file.                         | `./data/asteria.sqlite`            |
| `ASTERIA_LOG_LEVEL`             | No       | Bolt log level.                                           | `info`                             |
| `ASTERIA_POLL_INTERVAL_SECONDS` | No       | How often the scheduler checks for due jobs.              | `60`                               |
| `ASTERIA_STATUS_PORT`           | No       | Port for the optional status RSS server.                  | `8787`                             |
| `ASTERIA_STATUS_FILE`           | No       | Where the status server reads/writes events.              | `./data/status-events.json`        |
| `ASTERIA_STATUS_URL`            | No       | Public base URL used in the status RSS feed.              | `http://localhost`                 |

### Todoist ⇄ Slack List sync

Asteria can two-way sync a Slack List with a Todoist project. Everything below is also
configurable at runtime from the **Sync** tab in App Home, but these env vars provide the
initial defaults on first boot.

| Variable                          | Required | Purpose                                                                  | Default                         |
| --------------------------------- | -------- | ------------------------------------------------------------------------ | ------------------------------- |
| `TODOIST_API_TOKEN`               | No       | Todoist REST API token (App Management, read/write scopes).              | None                            |
| `TODOIST_SYNC_ENABLED`            | No       | Set `true` to enable the sync poller at startup.                         | `false`                         |
| `SLACK_SYNC_LIST_ID`              | No       | ID of the Slack List to sync (from the list URL, e.g. `F0C37D72NNM`).    | None                            |
| `TODOIST_PROJECT_NAME`            | No       | Todoist project where synced tasks are created.                          | `Public Slack To Do List`       |
| `SLACK_NOTIFICATION_CHANNEL_ID`   | No       | Channel that receives "Task Completed" messages from Todoist.            | None                            |
| `TODOIST_SYNC_POLL_INTERVAL_SECONDS` | No    | How often Asteria polls the Slack List for additions/changes.            | `300`                           |
| `TODOIST_API_BASE_URL`            | No       | Todoist API root to use.                                                 | `https://api.todoist.com/api/v1` |
| `ASTERIA_WEBHOOK_PORT`            | No       | Local port for the webhook server (`/webhooks/todoist`).                 | `8792`                          |
| `TODOIST_WEBHOOK_SECRET`          | No       | HMAC secret used to verify Todoist webhook signatures.                   | None                            |

How it works:

- New items added to the Slack List are created as Todoist tasks (title, due date, and a
  description noting who added them and when), under `TODOIST_PROJECT_NAME`.
- Unchecking/checking the list item's checkbox completes or reopens the matching Todoist task.
- When a Todoist task is marked complete, the Slack List checkbox is checked and a
  `Task Completed: <task> (originally added by <user>)` message is posted to
  `SLACK_NOTIFICATION_CHANNEL_ID`.
- Sync runs on the poll interval above; for instant completion messages, create a Todoist
  webhook that POSTs to `https://<your-public-url>/webhooks/todoist` and set the webhook's
  HMAC secret (under the webhook settings, "Secret" field) to `TODOIST_WEBHOOK_SECRET`.
  Asteria verifies the `X-Todoist-Hmac-SHA256` header on every request.

These webhook JSON payloads are signed with HMAC-SHA256 using your secret; requests without
a configured secret (or with an invalid signature) are rejected. The webhook server also
serves a `/health` endpoint.

## Running Locally

```sh
npm start
```

Asteria starts in Socket Mode and keeps running as a long-lived Node.js process.

## Running On Hack Club Nest

Asteria is designed for a Hack Club Nest server. Nest servers are reachable at `*.hackclub.app`-style URLs (such as `asteria.sammy.hackclub.app`) and auto-forward traffic from your subdomain to a port of your choosing.

1. Copy the repository to your Nest server (for example `~/asteria` or `/opt/asteria`).
2. Install Node.js 20 or newer.
3. Create a dedicated user for the service (optional but recommended).
4. Place the `.env` file somewhere safe and readable by that user.
5. Install dependencies with `npm install`.
6. Start the app with `npm start`, or install the systemd services below.

The SQLite database persists on disk at the path in `ASTERIA_DB_PATH`, so restarts do not wipe settings, drafts, or history.

## systemd

This repository includes example unit files:

- [deploy/asteria.service](deploy/asteria.service) — the bot itself.
- [deploy/asteria-status.service](deploy/asteria-status.service) — the optional status RSS server.

Typical deployment steps:

1. Copy the units to `/etc/systemd/system/`:

   ```sh
   sudo cp deploy/asteria.service deploy/asteria-status.service /etc/systemd/system/
   ```

2. Edit both units so `WorkingDirectory`, `EnvironmentFile`, `ExecStart`, `User`, and `Group` match your server.
3. Reload systemd and start both services:

   ```sh
   sudo systemctl daemon-reload
   sudo systemctl enable --now asteria
   sudo systemctl enable --now asteria-status
   ```

4. Check the logs with `journalctl -u asteria -f`.

The main unit records an `up`/`down` event every time the bot starts or stops via [scripts/record-status.js](scripts/record-status.js). Point your Nest subdomain at `ASTERIA_STATUS_PORT` (default `8787`) and set `ASTERIA_STATUS_URL` to your public subdomain URL, then subscribe to `/rss.xml` in your uptime monitor of choice.

## App Home Setup

Open Asteria's App Home as the owner. The default tab is Daily Update.

### Daily Update

- Write the day's update in the main text field.
- Optionally add a Song of the Day.
- Optionally add an Event of the Day.
- Optionally enable a thread starter reply and edit its text.
- Press Send Daily Update to post to the configured personal channel.
- The update is posted under your Slack display name and avatar using Slack's `chat.postMessage`/`chat:write.customize` behaviour.
- A fresh AI question is generated each time you send, and is embedded in the update when the "Include in Daily Update" toggle is on. This happens even when the automatic Daily Question is disabled.

### Daily Question

- Enable or disable the generated Daily Question.
- **Write the AI prompt** in the "AI prompt" field. This text is sent to the model exactly as written — there are no tags, placeholders, or injected topics. A sensible default is pre-filled; replace it with anything you like.
- Choose whether the question should also appear inside the Daily Update.
- Set the approximate send time in your timezone.
- Press **Test Daily Question** to generate a question now. You will be asked whether you want to **preview the output** (nothing is posted) or **send it to the personal channel** (it is posted and recorded).

### Welcomer

- Enable or disable welcome messages.
- Edit the welcome text.
- Use `{user}` where the new member mention should appear.
- Add an optional rules Canvas URL.

### Settings

- Set the bot name used when Asteria posts its own messages.
- Set the timezone using a valid IANA timezone such as `Europe/London` or `America/New_York`.
- Configure the Daily Update reminder deadline.
- Pick the personal channel.
- Pick the Slack user group that the Daily Update should mention.

Only the Slack user ID in `PERSONAL_CHANNEL_OWNER_ID` can save these settings. Everyone else sees a restricted App Home view.

## Usage

1. Open Asteria's App Home.
2. Write the Daily Update.
3. Add an optional song and event.
4. Press Send Daily Update.
5. Asteria posts the message to your personal channel under your name and avatar and, if enabled, adds a thread reply. A fresh AI question is generated for every send and embedded when inclusion is enabled.
6. If the automatic Daily Question is enabled, Asteria also posts it separately on its own schedule, using your AI prompt.
7. If you have not posted by the reminder deadline, Asteria sends you a DM reminder (and retries if the send fails).
8. If someone joins your personal channel, Asteria sends the configured welcome message.

When Daily Question inclusion is enabled, a freshly generated question is embedded inside the Daily Update. The Daily Question is also still posted separately on its own schedule when the automatic Daily Question is enabled.

## Slack Permissions

Asteria only requests the scopes it actually uses:

- `chat:write` for posting Daily Updates, Daily Questions, reminders, and welcome messages.
- `chat:write.customize` for posting the Daily Update with your name and avatar.
- `users.profile:read` for reading your display name and avatar so the Daily Update can appear as you.
- `channels:read` and `groups:read` for loading the personal channel picker in App Home.
- `im:write` for opening a DM channel to you and sending reminder DMs.
- `usergroups:read` for loading Slack user groups into the App Home selector.
- `users:read` for the `user_huddle_changed` event that powers huddle presence tracking.
- `channels:history`, `groups:history`, `im:history`, and `mpim:history` for reading a huddle's chat thread when a review is requested.

The manifest enables the `user_huddle_changed` and `message.*` event subscriptions; these only deliver once the app is reinstalled with the updated manifest.

If you change the manifest scopes, reinstall the Slack app in your workspace.

## Huddle Stats

When a huddle starts, Asteria tracks attendance through Slack's workspace-wide `user_huddle_changed` event and enriches it with room metadata from `huddle_thread` messages. When the last participant leaves (or a stale huddle times out), the huddle's starter is DMed with an optional "huddle review" button. The review shows total duration, who attended for how long, and — if requested — the longest and shortest messages sent in the huddle's chat thread. The review is only fetched after you press the button; **message text is never stored**, only used once to compute the lengths shown in that review.

Presence is tracked per (call, user); per-session gaps are approximated from first/last seen timestamps.

- The huddle starter gets the review prompt, falling back to the owner, then to the first person who joined.
- The App Home has a **Huddles** tab listing every huddle Asteria has seen (channel + local date), most recent first.
- Messages only count towards the longest/shortest stats if they were sent by a known participant inside the huddle's time window.
- A `user_huddle_changed` event requires `users:read`; reading a huddle's chat thread requires the `*:history` scopes and the `message.*` event subscriptions enabled in the app manifest. Reinstall the app from the updated `manifest.json` for these to take effect.
- Huddles left open longer than 12 hours with no active members are finalized automatically.

## Hack Club AI

Asteria uses the OpenAI-compatible Hack Club AI endpoint at `https://ai.hackclub.com/proxy/v1` by default.

- The API key comes from `HACKCLUB_AI_KEY`.
- The model comes from `HACKCLUB_AI_MODEL`.
- The Daily Question generator runs on its own schedule and whenever a Daily Update is sent. Its prompt is the one you write in the Daily Question tab.
- Song of the Day, Event of the Day, and welcome text are always manually configured.

## Troubleshooting

- Socket Mode not connecting: confirm `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`, and `SLACK_SIGNING_SECRET` are set, and make sure the app has Socket Mode enabled.
- Bot not responding: confirm the bot was installed to the workspace and has the right scopes.
- Bot cannot post: add the bot to your personal channel (Details → More → Add apps).
- Daily Question not sending: check `daily_question_enabled`, the send time, the timezone, and the Hack Club AI key/model.
- User group not pinging: verify the selected Slack user group still exists and reinstall the app if scopes changed.
- Welcome message not firing: confirm the bot is in the personal channel and `welcomer_enabled` is on.
- Huddle review prompt not arriving: confirm the app was reinstalled after adding `users:read`, the history scopes, and the `user_huddle_changed` / `message.*` event subscriptions — the bot only sees huddles once its own event subscriptions are live.
- Owner sees the restricted view: verify `PERSONAL_CHANNEL_OWNER_ID` matches the Slack user who is opening App Home.
- AI errors: verify `HACKCLUB_AI_KEY` and `HACKCLUB_AI_MODEL`, and check the server logs for the request failure.
- Timezone issues: use a valid IANA timezone and save the setting again.
- Permissions or scope errors: reinstall the app after changing the manifest.
- Status feed is empty: confirm `asteria-status` is running, `ASTERIA_STATUS_URL` is your public URL, and your Nest subdomain points at `ASTERIA_STATUS_PORT`.

## Files Of Interest

- [manifest.json](manifest.json) — the Slack app manifest.
- [.env.example](.env.example) — environment template.
- [deploy/asteria.service](deploy/asteria.service) — example systemd unit for the bot.
- [deploy/asteria-status.service](deploy/asteria-status.service) — example systemd unit for the status RSS server.
- [scripts/record-status.js](scripts/record-status.js) — records up/down events for the status feed.
- [app.js](app.js) — entry point.

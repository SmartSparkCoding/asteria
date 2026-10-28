/**
 * One-off: score ended huddles that never got award rows.
 *
 * The database lives in a single file and the bot keeps the whole thing in
 * memory, so this must NOT run while asteria.service is up: a second process
 * would overwrite the live copy on close. Stop the service, run this, start it.
 *
 *   systemctl stop asteria.service
 *   node scripts/recompute-awards.js            # dry run, prints what it would do
 *   node scripts/recompute-awards.js --apply
 *   systemctl start asteria.service
 */

import { recomputeMissingHuddleAwards } from '../src/database/recompute-awards.js';
import { createStore } from '../src/database/store.js';

const apply = process.argv.includes('--apply');
const dbArg = process.argv.find((arg) => arg.startsWith('--db='));
const databasePath = dbArg ? dbArg.slice('--db='.length) : process.env.ASTERIA_DB_PATH || './data/asteria.sqlite';

const store = await createStore(databasePath);
try {
  const result = recomputeMissingHuddleAwards(store, { logger: console, dryRun: !apply });
  console.log(
    `${apply ? 'Applied' : 'Dry run'}: ${result.huddles} huddle(s), ${result.users} award row(s), ${result.points} point(s)`,
  );
  for (const detail of result.details) {
    console.log(`  ${detail.callId} ${detail.channelId} ${detail.points}pt`, detail.users);
  }
  if (!apply) {
    console.log('Nothing written. Re-run with --apply to keep this.');
  }
} finally {
  store.close();
}

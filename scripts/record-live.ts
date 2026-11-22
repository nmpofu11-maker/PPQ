/**
 * Records live matches (stats, events AND bookmaker odds) to a JSONL log so +EV alerts can
 * later be evaluated against what the market really offered at the time. Historical odds are
 * not available from the scoreboard feed, so this is the only honest way to test the edge claim.
 *
 *   npm run record:live -- --interval 120 --out data/live-log.jsonl
 *
 * Leave it running through match days. Size grows quickly; ~2 minute intervals are plenty.
 */
import fs from 'node:fs';
import path from 'node:path';
import { scrapeScoreboardMatches } from '../server/scraper';
import { numArg, parseArgs } from './lib/dataset';

const args = parseArgs(process.argv.slice(2));
const intervalSec = Math.max(30, numArg(args, 'interval', 120));
const out = typeof args.out === 'string' ? args.out : 'data/live-log.jsonl';
const finalised = new Set<string>();

async function tick() {
  const { matches } = await scrapeScoreboardMatches({ enrichLimit: 40 });
  const capturedAt = new Date().toISOString();
  const lines: string[] = [];
  for (const m of matches) {
    if (m.state === 'in' && m.scrapedOdds) {
      lines.push(JSON.stringify({ capturedAt, match: m }));
    } else if (m.state === 'post' && !finalised.has(m.id)) {
      // one terminal record per match carries the final score used for settlement
      finalised.add(m.id);
      lines.push(JSON.stringify({ capturedAt, match: { ...m, events: [] } }));
    }
  }
  if (lines.length) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.appendFileSync(out, lines.join('\n') + '\n');
  }
  console.log(`${capturedAt} recorded ${lines.length} records (${matches.filter((m) => m.state === 'in').length} live)`);
}

async function loop() {
  for (;;) {
    try {
      await tick();
    } catch (err) {
      console.warn('tick failed:', err instanceof Error ? err.message : err);
    }
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
}

void loop();

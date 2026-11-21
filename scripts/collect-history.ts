/**
 * Collects finished matches (with event flow and stats) into a JSON dataset for backtesting
 * and fitting.
 *
 *   npm run collect:history -- --days 90 --out data/history.json
 *
 * Needs outbound access to site.api.espn.com. Re-running merges into the existing file.
 */
import { scrapeScoreboardMatches } from '../server/scraper';
import { isUsableHistoricalMatch } from '../src/engine/evaluation';
import type { ScrapedMatch } from '../src/types/soccer';
import { loadHistory, numArg, parseArgs, writeJsonFile } from './lib/dataset';

const args = parseArgs(process.argv.slice(2));
const days = Math.max(1, Math.min(400, numArg(args, 'days', 60)));
const out = typeof args.out === 'string' ? args.out : 'data/history.json';
const pauseMs = numArg(args, 'pause-ms', 1500);

function yyyymmdd(d: Date) {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const byId = new Map<string, ScrapedMatch>(loadHistory(out).map((m) => [m.id, m]));
  console.log(`Starting with ${byId.size} matches already in ${out}`);

  for (let i = 1; i <= days; i++) {
    const date = yyyymmdd(new Date(Date.now() - i * 86_400_000));
    try {
      const { matches } = await scrapeScoreboardMatches({ dateYyyymmdd: date, onlyFinished: true, enrichLimit: 400 });
      let added = 0;
      for (const m of matches) {
        if (isUsableHistoricalMatch(m) && !byId.has(m.id)) {
          // scoreboard odds are post-match closing prices; drop them, history is odds-free
          byId.set(m.id, { ...m, scrapedOdds: null });
          added += 1;
        }
      }
      console.log(`${date}: ${matches.length} finished, +${added} usable (total ${byId.size})`);
      writeJsonFile(out, Array.from(byId.values()));
    } catch (err) {
      console.warn(`${date}: failed (${err instanceof Error ? err.message : err}); continuing`);
    }
    await sleep(pauseMs);
  }
  console.log(`Done. ${byId.size} matches in ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

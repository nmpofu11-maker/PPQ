/**
 * Backtests the flow model against honest baselines on a chronological hold-out.
 *
 *   npm run backtest -- --history data/history.json [--live-log data/live-log.jsonl]
 *       [--minutes 20,35,50,65,80] [--test-fraction 0.3] [--no-learn] [--out data/backtest-report.json]
 */
import { loadHistory, loadLiveLog, numArg, parseArgs, writeJsonFile } from './lib/dataset';
import { evaluateLiveLog, learnedModelState, runBacktest } from './lib/backtestCore';
import { splitChronological } from '../src/engine/evaluation';
import { getModelParams } from '../src/engine/modelParams';

const args = parseArgs(process.argv.slice(2));
const historyPath = typeof args.history === 'string' ? args.history : 'data/history.json';
const minutes = (typeof args.minutes === 'string' ? args.minutes : '20,35,50,65,80')
  .split(',')
  .map(Number)
  .filter((n) => Number.isFinite(n) && n > 0 && n < 90);
const testFraction = numArg(args, 'test-fraction', 0.3);
const learn = !args['no-learn'];

const history = loadHistory(historyPath);
if (history.length === 0) {
  console.error(`No matches in ${historyPath}. Run \`npm run collect:history\` first.`);
  process.exit(1);
}

const report = runBacktest(history, { minutes, testFraction, learn });
const f = (n: number) => n.toFixed(4);

console.log(`\nMatches: ${report.matches.total} usable-or-not loaded; train ${report.matches.train}, held-out test ${report.matches.test}`);
console.log(`Snapshots at minutes ${minutes.join(', ')}; online learning replayed on train: ${learn ? 'yes' : 'no'}`);
console.log(`Using fitted params: ${report.usingFittedParams ? 'yes' : 'NO (hand-chosen defaults)'}\n`);
console.log('method        Brier(std)  RPS      LogLoss  O2.5-Brier  homeWin-ECE');
for (const [name, m] of Object.entries(report.methods)) {
  console.log(`${name.padEnd(13)} ${f(m.brier).padEnd(11)} ${f(m.rps).padEnd(8)} ${f(m.logLoss).padEnd(8)} ${f(m.over25Brier).padEnd(11)} ${f(m.homeWinEce)}`);
}
const ci = report.modelVsScoreState.logLoss;
console.log(`\nModel − score-state log-loss diff: ${f(ci.meanDiff)}  95% CI [${f(ci.lo)}, ${f(ci.hi)}]  (negative = model better; ${ci.clusters} matches)`);
console.log(`VERDICT: ${report.verdictText}\n`);

let evReport = null;
const liveLogPath = typeof args['live-log'] === 'string' ? args['live-log'] : null;
if (liveLogPath) {
  const { train } = splitChronological(history, testFraction);
  const state = learnedModelState(train, learn);
  evReport = evaluateLiveLog(loadLiveLog(liveLogPath), state, getModelParams(), numArg(args, 'min-ev', 3));
  console.log('Live-log +EV evaluation (verified-live odds only):');
  console.log(JSON.stringify(evReport, null, 2));
}

const out = typeof args.out === 'string' ? args.out : 'data/backtest-report.json';
writeJsonFile(out, { generatedAt: new Date().toISOString(), report, evReport });
console.log(`\nWrote ${out}`);

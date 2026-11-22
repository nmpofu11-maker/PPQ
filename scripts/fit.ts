/**
 * Fits the model's structural parameters on a chronological TRAIN split and keeps them only
 * if they beat the defaults AND the score-and-clock baseline on the held-out TEST split.
 *
 *   npm run fit -- --history data/history.json [--write] [--passes 3] [--minutes 20,35,50,65,80]
 *
 * Without --write it only reports. With --write it updates src/engine/fittedParams.json, and
 * only if every acceptance check passes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHistory, numArg, parseArgs } from './lib/dataset';
import { acceptFit, fitParams } from './lib/fitCore';
import { splitChronological } from '../src/engine/evaluation';
import { DEFAULT_PARAMS } from '../src/engine/modelParams';

const args = parseArgs(process.argv.slice(2));
const historyPath = typeof args.history === 'string' ? args.history : 'data/history.json';
const minutes = (typeof args.minutes === 'string' ? args.minutes : '20,35,50,65,80')
  .split(',')
  .map(Number)
  .filter((n) => Number.isFinite(n) && n > 0 && n < 90);
const testFraction = numArg(args, 'test-fraction', 0.3);
const passes = Math.max(1, Math.min(6, numArg(args, 'passes', 3)));
const write = Boolean(args.write);

const history = loadHistory(historyPath);
if (history.length === 0) {
  console.error(`No matches in ${historyPath}. Run \`npm run collect:history\` first.`);
  process.exit(1);
}

const { train } = splitChronological(history, testFraction);
console.log(`Fitting on ${train.length} training matches (this can take several minutes)...`);
const fit = fitParams(train, { minutes, passes, onProgress: (m) => console.log(m) });
console.log(`Train log loss: ${fit.startLogLoss.toFixed(5)} -> ${fit.fittedLogLoss.toFixed(5)} (${fit.evaluations} evaluations)`);

console.log('\nParameter           default   fitted');
for (const k of Object.keys(DEFAULT_PARAMS) as (keyof typeof DEFAULT_PARAMS)[]) {
  console.log(`${k.padEnd(18)} ${DEFAULT_PARAMS[k].toFixed(3).padEnd(9)} ${fit.params[k].toFixed(3)}`);
}

const decision = acceptFit(history, fit.params, { minutes, testFraction });
console.log(`\nHeld-out log loss: defaults ${decision.defaultReport.methods.model.logLoss.toFixed(5)}  fitted ${decision.fittedReport.methods.model.logLoss.toFixed(5)}  score-state baseline ${decision.fittedReport.methods.scoreState.logLoss.toFixed(5)}`);
console.log(decision.fittedReport.verdictText);

if (!decision.accept) {
  console.log(`\nNOT accepting the fit: ${decision.reasons.join('; ')}.`);
  process.exit(write ? 2 : 0);
}
console.log('\nFit passes all held-out checks.');
if (!write) {
  console.log('Re-run with --write to save it to src/engine/fittedParams.json.');
} else {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/engine/fittedParams.json');
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        fitted: true,
        fittedAt: new Date().toISOString(),
        trainMatches: train.length,
        testMatches: decision.fittedReport.matches.test,
        heldOutLogLoss: decision.fittedReport.methods.model.logLoss,
        scoreStateBaselineLogLoss: decision.fittedReport.methods.scoreState.logLoss,
        params: fit.params,
      },
      null,
      2
    ) + '\n'
  );
  console.log(`Wrote ${file}`);
}

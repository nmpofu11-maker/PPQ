import React, { useState } from 'react';
import type { User } from 'firebase/auth';
import type {
  ModelIntelligencePayload,
  PaperBetRecord,
  PaperLedgerSummary,
} from '../types/soccer';

const EquityCurveSvg: React.FC<{
  data: { index: number; label: string; cumulativeProfit: number }[];
}> = ({ data }) => {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const w = 720;
  const h = 160;
  const padL = 44;
  const padR = 16;
  const padT = 16;
  const padB = 24;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const vals = data.map((d) => d.cumulativeProfit);
  const minVal = Math.min(0, ...vals);
  const maxVal = Math.max(0.5, ...vals);
  const range = Math.max(0.5, maxVal - minVal);

  const toX = (idx: number) =>
    padL + (data.length <= 1 ? plotW / 2 : (idx / (data.length - 1)) * plotW);
  const toY = (val: number) => padT + ((maxVal - val) / range) * plotH;

  const zeroY = toY(0);
  const pts = data.map((d, i) => ({ ...d, x: toX(i), y: toY(d.cumulativeProfit) }));
  const linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L ${pts[pts.length - 1].x.toFixed(1)} ${zeroY.toFixed(1)} L ${pts[0].x.toFixed(1)} ${zeroY.toFixed(1)} Z`;
  const lastProfit = data[data.length - 1]?.cumulativeProfit ?? 0;
  const strokeColor = lastProfit >= 0 ? '#10B981' : '#F87171';
  const activePt = hoverIdx !== null ? pts[hoverIdx] : pts[pts.length - 1];

  return (
    <div className="bg-[#0E141F] border border-white/8 rounded-lg p-3 space-y-1.5">
      <div className="flex items-center justify-between text-[11px] font-mono tabular-nums text-slate-400">
        <span>Cumulative Paper-Bet Equity Curve</span>
        <span className={activePt.cumulativeProfit >= 0 ? 'text-emerald-400' : 'text-red-400'}>
          {activePt.label}: {activePt.cumulativeProfit >= 0 ? '+' : ''}
          {activePt.cumulativeProfit.toFixed(2)}u
        </span>
      </div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="w-full h-36 block select-none"
        role="img"
        aria-label="Cumulative paper-bet equity curve"
        onMouseLeave={() => setHoverIdx(null)}
      >
        <line
          x1={padL}
          y1={zeroY}
          x2={w - padR}
          y2={zeroY}
          stroke="rgba(148,163,184,0.3)"
          strokeDasharray="3 3"
          strokeWidth="1"
        />
        <text
          x={padL - 6}
          y={padT + 4}
          textAnchor="end"
          fill="#64748B"
          fontSize="10"
          fontFamily="JetBrains Mono, monospace"
        >
          +{maxVal.toFixed(1)}u
        </text>
        <text
          x={padL - 6}
          y={zeroY + 3}
          textAnchor="end"
          fill="#94A3B8"
          fontSize="10"
          fontFamily="JetBrains Mono, monospace"
        >
          0u
        </text>
        {minVal < 0 && (
          <text
            x={padL - 6}
            y={h - padB}
            textAnchor="end"
            fill="#64748B"
            fontSize="10"
            fontFamily="JetBrains Mono, monospace"
          >
            {minVal.toFixed(1)}u
          </text>
        )}
        <path d={areaPath} fill={strokeColor} fillOpacity="0.16" />
        <path d={linePath} fill="none" stroke={strokeColor} strokeWidth="2" />
        {pts.map((pt, i) => (
          <g key={pt.index} onMouseEnter={() => setHoverIdx(i)} className="cursor-crosshair">
            <circle cx={pt.x} cy={pt.y} r="8" fill="transparent" />
            <circle
              cx={pt.x}
              cy={pt.y}
              r={hoverIdx === i ? 4 : 2.5}
              fill={pt.cumulativeProfit >= 0 ? '#10B981' : '#F87171'}
            />
          </g>
        ))}
      </svg>
    </div>
  );
};

interface LearningDashboardProps {
  modelState: ModelIntelligencePayload;
  user: User | null;
  firestoreStatus: 'connected' | 'offline' | 'error' | 'checking';
  isCalibrating: boolean;
  calibrationStatusMsg: string | null;
  onRunHistoricalCalibration: (days: number, snapshotMinute: number) => void;
  onSignIn: () => void;
  onSignOut: () => void;
  paperBets: PaperBetRecord[];
  paperSummary: PaperLedgerSummary;
  capturedSnapshotCount: number;
  onResetPaperLedger: () => void;
}

export const LearningDashboard: React.FC<LearningDashboardProps> = ({
  modelState,
  user,
  firestoreStatus,
  isCalibrating,
  calibrationStatusMsg,
  onRunHistoricalCalibration,
  onSignIn,
  onSignOut,
  paperBets,
  paperSummary,
  capturedSnapshotCount,
  onResetPaperLedger,
}) => {
  const [daysBack, setDaysBack] = useState(2);
  const [snapshotMin, setSnapshotMin] = useState(65);
  const [teamQuery, setTeamQuery] = useState('');

  const teamEntries = Object.entries(modelState.team_intelligence_matrices)
    .filter(([key]) =>
      key.toLowerCase().includes(teamQuery.trim().toLowerCase().replace(/\s+/g, '_'))
    )
    .sort((a, b) => b[1].sample_size_matches - a[1].sample_size_matches);

  const exportIntelligenceJson = () => {
    const payload = {
      sync_timestamp: modelState.sync_timestamp,
      model_engine: modelState.model_engine,
      meta_improvement_notes: modelState.meta_improvement_notes,
      team_intelligence_matrices: modelState.team_intelligence_matrices,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pitchpulse_intelligence_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      {/* Calibration Controls & Firestore Sync */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-[#131A26] border border-white/8 rounded-xl p-5 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-lg font-semibold text-white">
                Online Mathematical Learning &amp; Historical Calibration
              </h1>
              <p className="text-xs text-slate-400 mt-1">
                Prefers exact live-captured mid-match snapshots ({capturedSnapshotCount} recorded at 30&apos;/45&apos;/60&apos;/75&apos; milestones) and falls back to strictly causal event reconstruction (zero odds, zero future leakage).
              </p>
            </div>
            <button
              type="button"
              onClick={exportIntelligenceJson}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-white/12 bg-[#1A2333] text-slate-200 hover:bg-[#243044] transition-colors whitespace-nowrap shrink-0"
            >
              Export Intelligence JSON
            </button>
          </div>

          <div className="flex flex-wrap items-end gap-4 pt-2">
            <div>
              <label htmlFor="calib-days" className="block text-xs text-slate-400 mb-1">
                Historical Window
              </label>
              <select
                id="calib-days"
                value={daysBack}
                onChange={(e) => setDaysBack(Number(e.target.value))}
                className="bg-[#0E141F] border border-white/12 rounded-lg px-3 py-2 text-xs text-slate-100"
              >
                <option value={1}>Past 24 Hours</option>
                <option value={2}>Past 2 Days</option>
                <option value={3}>Past 3 Days</option>
                <option value={5}>Past 5 Days</option>
              </select>
            </div>

            <div>
              <label htmlFor="calib-min" className="block text-xs text-slate-400 mb-1">
                Causal Snapshot Minute
              </label>
              <select
                id="calib-min"
                value={snapshotMin}
                onChange={(e) => setSnapshotMin(Number(e.target.value))}
                className="bg-[#0E141F] border border-white/12 rounded-lg px-3 py-2 text-xs font-mono text-slate-100"
              >
                <option value={45}>45&apos; (Halftime)</option>
                <option value={60}>60&apos; (Hour Mark)</option>
                <option value={65}>65&apos; (Mid-2nd Half)</option>
                <option value={75}>75&apos; (Late Surge)</option>
              </select>
            </div>

            <button
              type="button"
              onClick={() => onRunHistoricalCalibration(daysBack, snapshotMin)}
              disabled={isCalibrating}
              className="px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-500 text-slate-950 hover:bg-emerald-400 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
            >
              {isCalibrating
                ? 'Scraping & Calibrating...'
                : 'Run Historical Calibration Batch'}
            </button>
          </div>

          {calibrationStatusMsg && (
            <div className="text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">
              {calibrationStatusMsg}
            </div>
          )}
        </div>

        {/* Firestore Cloud Sync Panel */}
        <div className="bg-[#131A26] border border-white/8 rounded-xl p-5 space-y-4 flex flex-col justify-between">
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-slate-200">Firestore Persistence</span>
              <span
                className={`font-mono ${
                  firestoreStatus === 'connected' ? 'text-emerald-400' : 'text-amber-400'
                }`}
              >
                {firestoreStatus === 'connected' ? 'Reachable' : firestoreStatus}
              </span>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">
              {user
                ? `Signed in as ${user.email || user.displayName}. Model weights, live milestone captures, audit logs, and paper-bet ROI sync automatically to Cloud Firestore.`
                : 'Sign in with Google to persist calibrated weights, live captures, paper-bet ledger, and audit history across sessions.'}
            </p>
          </div>

          {user ? (
            <button
              type="button"
              onClick={onSignOut}
              className="w-full px-4 py-2 text-xs font-medium rounded-lg border border-white/12 bg-[#1A2333] text-slate-200 hover:bg-[#243044] transition-colors"
            >
              Sign Out ({user.email?.split('@')[0]})
            </button>
          ) : (
            <button
              type="button"
              onClick={onSignIn}
              className="w-full px-4 py-2 text-xs font-semibold rounded-lg bg-slate-100 text-slate-950 hover:bg-white transition-colors"
            >
              Sign In with Google to Sync Cloud DB
            </button>
          )}
        </div>
      </div>

      {/* KPI Metrics Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-[#131A26] border border-white/8 rounded-xl p-4">
          <div className="text-xs text-slate-400">Matches Evaluated (Out-of-Sample)</div>
          <div className="mt-1 text-2xl font-mono font-semibold tabular-nums text-white">
            {modelState.metrics.totalEvaluated}
          </div>
          <div className="mt-1 text-[11px] font-mono tabular-nums text-slate-500">
            {capturedSnapshotCount} exact live snapshots saved
          </div>
        </div>
        <div className="bg-[#131A26] border border-white/8 rounded-xl p-4">
          <div className="text-xs text-slate-400">1X2 Accuracy</div>
          <div className="mt-1 text-2xl font-mono font-semibold tabular-nums text-emerald-400">
            {modelState.metrics.accuracyPct !== null
              ? `${modelState.metrics.accuracyPct.toFixed(1)}%`
              : '—'}
          </div>
        </div>
        <div className="bg-[#131A26] border border-white/8 rounded-xl p-4">
          <div className="text-xs text-slate-400">Mean Brier Score (Lower = Better)</div>
          <div className="mt-1 text-2xl font-mono font-semibold tabular-nums text-slate-100">
            {modelState.metrics.meanBrierScore !== null
              ? modelState.metrics.meanBrierScore.toFixed(4)
              : '—'}
          </div>
        </div>
        <div className="bg-[#131A26] border border-white/8 rounded-xl p-4">
          <div className="text-xs text-slate-400">Mean Log-Loss</div>
          <div className="mt-1 text-2xl font-mono font-semibold tabular-nums text-slate-100">
            {modelState.metrics.meanLogLoss !== null
              ? modelState.metrics.meanLogLoss.toFixed(4)
              : '—'}
          </div>
        </div>
      </div>

      {/* Automated Paper-Bet Ledger & Realized ROI */}
      <div className="bg-[#131A26] border border-white/8 rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">
              Automated Paper-Bet Ledger &amp; Realized ROI ({paperSummary.totalBets} Positions)
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Logs every Strong/Moderate live +EV edge at ¼-Kelly units automatically and settles strictly on full-time scraped scorelines.
            </p>
          </div>
          {paperBets.length > 0 && (
            <button
              type="button"
              onClick={onResetPaperLedger}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-white/12 bg-[#0E141F] text-slate-300 hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              Reset Ledger
            </button>
          )}
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-xs font-mono tabular-nums">
          <div className="p-3 rounded-lg bg-[#0E141F] border border-white/8">
            <div className="text-slate-400 font-sans">Net Profit (Units)</div>
            <div
              className={`text-lg font-semibold mt-1 ${
                paperSummary.netProfitUnits > 0
                  ? 'text-emerald-400'
                  : paperSummary.netProfitUnits < 0
                  ? 'text-red-400'
                  : 'text-slate-100'
              }`}
            >
              {paperSummary.netProfitUnits >= 0 ? '+' : ''}
              {paperSummary.netProfitUnits.toFixed(2)}u
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5">
              {paperSummary.openBets} open · {paperSummary.settledBets} settled
            </div>
          </div>

          <div className="p-3 rounded-lg bg-[#0E141F] border border-white/8">
            <div className="text-slate-400 font-sans">Realized ROI</div>
            <div
              className={`text-lg font-semibold mt-1 ${
                (paperSummary.roiPct ?? 0) > 0
                  ? 'text-emerald-400'
                  : (paperSummary.roiPct ?? 0) < 0
                  ? 'text-red-400'
                  : 'text-slate-100'
              }`}
            >
              {paperSummary.roiPct !== null
                ? `${paperSummary.roiPct >= 0 ? '+' : ''}${paperSummary.roiPct.toFixed(1)}%`
                : '—'}
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5">
              {paperSummary.totalStakedUnits.toFixed(2)}u risked
            </div>
          </div>

          <div className="p-3 rounded-lg bg-[#0E141F] border border-white/8">
            <div className="text-slate-400 font-sans">Hit Rate (W-L-P)</div>
            <div className="text-lg font-semibold text-white mt-1">
              {paperSummary.hitRatePct !== null ? `${paperSummary.hitRatePct.toFixed(1)}%` : '—'}
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5">
              {paperSummary.wins}W – {paperSummary.losses}L – {paperSummary.pushes}P
            </div>
          </div>

          <div className="p-3 rounded-lg bg-[#0E141F] border border-white/8">
            <div className="text-slate-400 font-sans">Max Drawdown / Tiers</div>
            <div className="text-lg font-semibold text-amber-300 mt-1">
              -{paperSummary.maxDrawdownUnits.toFixed(2)}u
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5">
              Strong {paperSummary.strongTierProfitUnits >= 0 ? '+' : ''}
              {paperSummary.strongTierProfitUnits.toFixed(1)}u · Mod{' '}
              {paperSummary.moderateTierProfitUnits >= 0 ? '+' : ''}
              {paperSummary.moderateTierProfitUnits.toFixed(1)}u
            </div>
          </div>
        </div>

        {/* Cumulative Equity Curve */}
        {paperSummary.equityCurve.length > 1 && (
          <EquityCurveSvg data={paperSummary.equityCurve} />
        )}

        {paperBets.length === 0 ? (
          <div className="text-xs text-slate-400 py-5 text-center border border-white/8 rounded-lg bg-[#0E141F]">
            No paper positions logged yet. Whenever live matches produce verified Strong or Moderate +EV edges, positions auto-record here and settle at full-time.
          </div>
        ) : (
          <div className="overflow-x-auto border border-white/8 rounded-lg">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-white/8 text-xs text-slate-400 font-medium bg-[#0E141F]">
                  <th className="py-2.5 px-3">Fixture &amp; Entry</th>
                  <th className="py-2.5 px-3">Market &amp; Selection</th>
                  <th className="py-2.5 px-3 text-right">Odds / EV</th>
                  <th className="py-2.5 px-3 text-right">Stake</th>
                  <th className="py-2.5 px-3 text-right">Final</th>
                  <th className="py-2.5 px-3 text-right">P&amp;L</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/8 text-xs">
                {paperBets.slice(0, 40).map((bet) => (
                  <tr key={bet.id} className="hover:bg-white/[0.02]">
                    <td className="py-2 px-3">
                      <div className="font-medium text-slate-200">{bet.matchTitle}</div>
                      <div className="text-slate-500 font-mono tabular-nums">
                        {bet.minutePlaced}&apos; ({bet.scoreAtPlacement}) ·{' '}
                        {bet.oddsVerifiedLive ? 'Verified Live' : 'Pre-Match Odds'}
                      </div>
                    </td>
                    <td className="py-2 px-3">
                      <div className="text-slate-200">{bet.selection}</div>
                      <div className="text-slate-500">{bet.market} · {bet.confidenceTier}</div>
                    </td>
                    <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-300">
                      {bet.bookmakerOddsAmerican}
                      <div className="text-emerald-400">+{bet.evPct.toFixed(1)}%</div>
                    </td>
                    <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-200">
                      {bet.stakeUnits.toFixed(2)}u
                    </td>
                    <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-300">
                      {bet.finalScore || 'In-Play'}
                    </td>
                    <td className="py-2 px-3 text-right font-mono tabular-nums font-semibold">
                      {bet.status === 'open' ? (
                        <span className="text-sky-400">Open</span>
                      ) : bet.status === 'push' ? (
                        <span className="text-slate-400">Push (0.00u)</span>
                      ) : (
                        <span className={bet.profitUnits >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                          {bet.profitUnits >= 0 ? '+' : ''}
                          {bet.profitUnits.toFixed(2)}u
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Global Learned Weights */}
      <div className="bg-[#131A26] border border-white/8 rounded-xl p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-100">
            Active Global Flow Parameters
          </h2>
          <span className="text-xs font-mono text-slate-400">
            {modelState.model_engine} · Synced {new Date(modelState.sync_timestamp).toLocaleString()}
          </span>
        </div>
        <p className="text-xs text-slate-300 bg-[#0E141F] border border-white/8 rounded-lg px-3 py-2">
          {modelState.meta_improvement_notes}
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 text-xs font-mono tabular-nums">
          <div className="p-3 rounded-lg bg-[#0E141F] border border-white/8">
            <div className="text-slate-400 font-sans">Momentum β</div>
            <div className="text-sm text-white mt-1">{modelState.globalWeights.momentumSensitivity}</div>
          </div>
          <div className="p-3 rounded-lg bg-[#0E141F] border border-white/8">
            <div className="text-slate-400 font-sans">SoT Weight</div>
            <div className="text-sm text-white mt-1">{modelState.globalWeights.shotOnTargetWeight}</div>
          </div>
          <div className="p-3 rounded-lg bg-[#0E141F] border border-white/8">
            <div className="text-slate-400 font-sans">Possession Wt</div>
            <div className="text-sm text-white mt-1">{modelState.globalWeights.possessionWeight}</div>
          </div>
          <div className="p-3 rounded-lg bg-[#0E141F] border border-white/8">
            <div className="text-slate-400 font-sans">Corner Wt</div>
            <div className="text-sm text-white mt-1">{modelState.globalWeights.cornerPressureWeight}</div>
          </div>
          <div className="p-3 rounded-lg bg-[#0E141F] border border-white/8">
            <div className="text-slate-400 font-sans">Tempo Bias</div>
            <div className="text-sm text-white mt-1">{modelState.globalWeights.baseTempoBias}</div>
          </div>
          <div className="p-3 rounded-lg bg-[#0E141F] border border-white/8">
            <div className="text-slate-400 font-sans">Home Base</div>
            <div className="text-sm text-white mt-1">{modelState.globalWeights.homeAdvantageBase}</div>
          </div>
        </div>
      </div>

      {/* Team Intelligence Matrices */}
      <div className="bg-[#131A26] border border-white/8 rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">
              Learned Team Intelligence Matrices ({teamEntries.length})
            </h2>
            <p className="text-xs text-slate-400">
              Per-team parameters refined continuously from evaluated match outcomes.
            </p>
          </div>
          <input
            type="search"
            value={teamQuery}
            onChange={(e) => setTeamQuery(e.target.value)}
            placeholder="Filter team key..."
            aria-label="Filter team intelligence matrices"
            className="bg-[#0E141F] border border-white/12 rounded-lg px-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 w-56"
          />
        </div>

        {teamEntries.length === 0 ? (
          <div className="text-xs text-slate-400 py-6 text-center border border-white/8 rounded-lg bg-[#0E141F]">
            No team matrices calibrated yet. Click &ldquo;Run Historical Calibration Batch&rdquo; above to scrape and evaluate real finished matches.
          </div>
        ) : (
          <div className="overflow-x-auto border border-white/8 rounded-lg">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-white/8 text-xs text-slate-400 font-medium bg-[#0E141F]">
                  <th className="py-2.5 px-3">Team Key</th>
                  <th className="py-2.5 px-3 text-right">Sample Matches</th>
                  <th className="py-2.5 px-3 text-right">Home Adv Mult</th>
                  <th className="py-2.5 px-3 text-right">Form Weight</th>
                  <th className="py-2.5 px-3 text-right">Volatility Index</th>
                  <th className="py-2.5 px-3 text-right">Fatigue Mod</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/8 text-xs font-mono tabular-nums">
                {teamEntries.slice(0, 40).map(([key, mat]) => (
                  <tr key={key} className="hover:bg-white/[0.02]">
                    <td className="py-2 px-3 font-sans font-medium text-slate-200">
                      {key.replace(/_/g, ' ')}
                    </td>
                    <td className="py-2 px-3 text-right text-slate-300">
                      {mat.sample_size_matches}
                    </td>
                    <td className="py-2 px-3 text-right text-slate-200">
                      {mat.learned_coefficients.home_advantage_multiplier.toFixed(3)}
                    </td>
                    <td className="py-2 px-3 text-right text-slate-200">
                      {mat.learned_coefficients.form_momentum_weight.toFixed(3)}
                    </td>
                    <td className="py-2 px-3 text-right text-slate-200">
                      {mat.learned_coefficients.volatility_index.toFixed(3)}
                    </td>
                    <td className="py-2 px-3 text-right text-slate-200">
                      {mat.learned_coefficients.fatigue_penalty_modifier.toFixed(3)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Audit Ledger */}
      <div className="bg-[#131A26] border border-white/8 rounded-xl p-5 space-y-3">
        <h2 className="text-sm font-semibold text-slate-100">
          Verified Historical Audit Ledger ({modelState.recentAudits.length})
        </h2>
        {modelState.recentAudits.length === 0 ? (
          <div className="text-xs text-slate-400 py-6 text-center border border-white/8 rounded-lg bg-[#0E141F]">
            Zero evaluated match audits yet. Every entry here is strictly derived from real scraped full-time scores compared against causal mid-match predictions.
          </div>
        ) : (
          <div className="overflow-x-auto border border-white/8 rounded-lg">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-white/8 text-xs text-slate-400 font-medium bg-[#0E141F]">
                  <th className="py-2.5 px-3">Fixture</th>
                  <th className="py-2.5 px-3 text-right">Snapshot</th>
                  <th className="py-2.5 px-3">Model Pick</th>
                  <th className="py-2.5 px-3 text-right">Prob</th>
                  <th className="py-2.5 px-3 text-right">Final</th>
                  <th className="py-2.5 px-3 text-right">Result</th>
                  <th className="py-2.5 px-3 text-right">Brier</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/8 text-xs">
                {modelState.recentAudits.slice(0, 50).map((aud) => (
                  <tr key={aud.id} className="hover:bg-white/[0.02]">
                    <td className="py-2 px-3">
                      <div className="font-medium text-slate-200">
                        {aud.homeTeam} vs {aud.awayTeam}
                      </div>
                      <div className="text-slate-500">{aud.league}</div>
                    </td>
                    <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-300">
                      <div>{aud.snapshotMinute}&apos;</div>
                      <div
                        className={`text-[10px] font-sans ${
                          aud.snapshotSource === 'exact_live_capture'
                            ? 'text-emerald-400'
                            : 'text-slate-500'
                        }`}
                      >
                        {aud.snapshotSource === 'exact_live_capture'
                          ? 'Live Capture'
                          : 'Reconstructed'}
                      </div>
                    </td>
                    <td className="py-2 px-3 text-slate-200">{aud.selection}</td>
                    <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-200">
                      {(aud.modelProbability * 100).toFixed(1)}%
                    </td>
                    <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-100">
                      {aud.finalScore}
                    </td>
                    <td className="py-2 px-3 text-right font-medium">
                      <span className={aud.isCorrect ? 'text-emerald-400' : 'text-red-400'}>
                        {aud.isCorrect ? 'Hit' : 'Miss'}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-300">
                      {aud.brierScore.toFixed(4)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

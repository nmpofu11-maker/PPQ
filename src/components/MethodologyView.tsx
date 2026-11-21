import React from 'react';

export const MethodologyView: React.FC = () => {
  return (
    <div className="max-w-4xl space-y-6">
      <div className="bg-[#131A26] border border-white/8 rounded-xl p-6 space-y-3">
        <h1 className="text-xl font-semibold text-white">
          Mathematical Architecture &amp; Odds Firewall
        </h1>
        <p className="text-sm text-slate-300 leading-relaxed">
          PitchPulse Quant separates match-outcome inference from bookmaker market pricing through a strict two-stage pipeline. Prematch and live odds never enter momentum scoring, intensity estimation, or Poisson distribution math.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-[#131A26] border border-white/8 rounded-xl p-5 space-y-2.5">
          <h2 className="text-sm font-semibold text-emerald-400">
            01. Exponentially Decayed Match Flow
          </h2>
          <p className="text-xs text-slate-300 leading-relaxed">
            Every scraped play-by-play event at minute τ ≤ t is weighted by w(τ) = exp(-0.085 · (t - τ)), giving an ~8.15 minute half-life. Shots on target (+3.5), off-target attempts (+1.6), corners (+1.25), yellow cards (-0.9), and persistent red cards (-6.5) combine with time-normalized boxscore pressure (65% recency flow, 35% cumulative dominance).
          </p>
        </div>

        <div className="bg-[#131A26] border border-white/8 rounded-xl p-5 space-y-2.5">
          <h2 className="text-sm font-semibold text-emerald-400">
            02. Poisson-Flow Remaining Intensity
          </h2>
          <p className="text-xs text-slate-300 leading-relaxed">
            Remaining-time scoring intensities λ_H and λ_A scale with remaining match fraction (92 - t)/90, per-90 shot-on-target &amp; corner rates, real last-5-match form score, red-card manpower multipliers, team-specific home/fatigue coefficients, and exp(±β · tanh(M_net / 10)).
          </p>
        </div>

        <div className="bg-[#131A26] border border-white/8 rounded-xl p-5 space-y-2.5">
          <h2 className="text-sm font-semibold text-emerald-400">
            03. Multi-Market Joint Distribution
          </h2>
          <p className="text-xs text-slate-300 leading-relaxed">
            Evaluating the joint Poisson grid P(ΔG_H = i) · P(ΔG_A = j) added to the live scoreline (G_H, G_A) yields calibrated probabilities across Match Winner (1X2), Draw No Bet, Over/Under lines (0.5–4.5), Double Chance, and Asian Handicap, while competing hazard rates λ_H / (λ_H + λ_A) determine Next Team to Score.
          </p>
        </div>

        <div className="bg-[#131A26] border border-white/8 rounded-xl p-5 space-y-2.5">
          <h2 className="text-sm font-semibold text-emerald-400">
            04. Stage 2 +EV Firewall &amp; Online Learning
          </h2>
          <p className="text-xs text-slate-300 leading-relaxed">
            Bookmaker odds are compared strictly after Stage 1 probabilities lock, flagging positive Expected Value EV = p_model · O_dec - 1 and ¼-Kelly stake sizing. On completed matches, causal mid-match snapshots (t = 65&apos;) are replayed without future leakage to update global weights and team matrices via bounded Brier-loss gradient steps.
          </p>
        </div>
      </div>
    </div>
  );
};

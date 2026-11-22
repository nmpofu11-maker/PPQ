/** Persistent responsible-gambling / not-advice notice shown in the app footer. */
export function ResponsibleGamblingNotice() {
  return (
    <footer className="border-t border-white/8 bg-[#0E141F] px-6 py-4 text-[11px] leading-relaxed text-slate-400">
      <div className="max-w-[1440px] mx-auto space-y-1.5">
        <p>
          <span className="font-semibold text-slate-300">Information only, not betting advice.</span>{' '}
          PitchPulse Quant is an experimental statistical model. Its probabilities have not been
          shown to beat bookmaker prices, and a flagged "+EV" edge is a model estimate that is
          frequently wrong, especially when odds are stale or the model is miscalibrated. Betting
          carries real risk of loss; never stake money you cannot afford to lose.
        </p>
        <p>
          18+ only (21+ in some regions). If gambling is affecting you or someone you know, free
          confidential support is available, for example{' '}
          <a
            href="https://www.begambleaware.org"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-slate-200"
          >
            BeGambleAware
          </a>{' '}
          (UK) or the National Problem Gambling Helpline, 1-800-GAMBLER (US).
        </p>
      </div>
    </footer>
  );
}

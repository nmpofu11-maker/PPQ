import type { ValueAlert } from '../../types/soccer';

export function StatusBanners(props: {
  alertNoticeMsg: string | null;
  isEmbeddedIframe: boolean;
  onDismissNotice: () => void;
  scrapeError: string | null;
  onRetry: () => void;
  topAlert: ValueAlert | null;
  alertCount: number;
  showTopAlert: boolean;
  onInspectTop: (matchId: string) => void;
  onViewAlerts: () => void;
}) {
  const p = props;
  return (
    <>
      {p.alertNoticeMsg && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs text-amber-200">
          <span>{p.alertNoticeMsg}</span>
          <div className="flex items-center gap-3">
            {p.isEmbeddedIframe && (
              <a
                href={window.location.href}
                target="_blank"
                rel="noopener noreferrer"
                className="px-3 py-1.5 rounded-lg bg-amber-400 text-slate-950 font-semibold hover:bg-amber-300 transition-colors whitespace-nowrap shrink-0"
              >
                Open Standalone Tab
              </a>
            )}
            <button type="button" onClick={p.onDismissNotice} className="text-slate-300 hover:text-white whitespace-nowrap shrink-0">
              Dismiss
            </button>
          </div>
        </div>
      )}
      {p.scrapeError && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 flex items-center justify-between gap-4 text-xs text-red-200">
          <span>Scraping error: {p.scrapeError}</span>
          <button
            type="button"
            onClick={p.onRetry}
            className="px-3 py-1.5 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-white font-medium whitespace-nowrap shrink-0"
          >
            Retry Scrape
          </button>
        </div>
      )}
      {p.showTopAlert && p.topAlert && (
        <div className="bg-[#131A26] border border-emerald-500/30 rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-4">
          <div className="text-xs text-slate-200">
            <span className="font-semibold text-emerald-400">Model-flagged edge (unverified estimate):</span>{' '}
            {p.topAlert.matchTitle} · {p.topAlert.market} —{' '}
            <span className="font-semibold text-white">{p.topAlert.selection}</span>{' '}
            <span className="font-mono tabular-nums text-emerald-400 font-semibold">
              (+{p.topAlert.evPct.toFixed(1)}% model EV)
            </span>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => p.onInspectTop(p.topAlert!.matchId)}
              className="text-xs font-medium text-emerald-400 hover:text-emerald-300 whitespace-nowrap shrink-0"
            >
              Inspect Fixture
            </button>
            <button type="button" onClick={p.onViewAlerts} className="text-xs font-medium text-slate-300 hover:text-white whitespace-nowrap shrink-0">
              View All {p.alertCount} Alerts
            </button>
          </div>
        </div>
      )}
    </>
  );
}

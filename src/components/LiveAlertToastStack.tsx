import React from 'react';
import { X } from 'lucide-react';
import type { CrossPlatformAlertItem } from '../engine/alertNotifier';

interface LiveAlertToastStackProps {
  toasts: CrossPlatformAlertItem[];
  onInspectMatch: (matchId: string) => void;
  onDismissToast: (id: string) => void;
}

export const LiveAlertToastStack: React.FC<LiveAlertToastStackProps> = ({
  toasts,
  onInspectMatch,
  onDismissToast,
}) => {
  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      aria-label="Live value alert notifications"
      className="fixed bottom-4 right-4 z-50 flex flex-col gap-2.5 w-[calc(100vw-2rem)] max-w-sm pointer-events-none"
    >
      {toasts.map((item) => {
        const isEv = item.kind === 'ev_value';
        return (
          <div
            key={item.id}
            className={`pointer-events-auto rounded-xl border bg-[#131A26]/95 backdrop-blur-md p-3.5 shadow-2xl space-y-2 ${
              isEv ? 'border-emerald-500/45' : 'border-amber-500/45'
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[11px] font-medium text-slate-400 truncate">
                  {isEv ? 'Live +EV Value Alert' : 'Live Attack Trend'} · {item.league}
                </div>
                <div className="text-xs font-semibold text-white truncate mt-0.5">
                  {item.matchTitle} ({item.minute}&apos; · {item.scoreline})
                </div>
              </div>
              <button
                type="button"
                aria-label={`Dismiss alert for ${item.matchTitle}`}
                onClick={() => onDismissToast(item.id)}
                className="p-1 rounded-md text-slate-400 hover:text-white hover:bg-white/8 shrink-0"
              >
                <X className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </div>

            <div
              className={`text-xs font-mono font-semibold tabular-nums ${
                isEv ? 'text-emerald-400' : 'text-amber-300'
              }`}
            >
              {item.headline}
            </div>
            <div className="text-[11px] text-slate-300 leading-snug">
              {item.detail}
            </div>

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => onDismissToast(item.id)}
                className="px-2.5 py-1 text-[11px] font-medium text-slate-400 hover:text-slate-200 transition-colors"
              >
                Dismiss
              </button>
              <button
                type="button"
                onClick={() => {
                  onInspectMatch(item.matchId);
                  onDismissToast(item.id);
                }}
                className="px-3 py-1 text-[11px] font-semibold rounded-md bg-emerald-500 text-slate-950 hover:bg-emerald-400 transition-colors"
              >
                Inspect Match
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
};

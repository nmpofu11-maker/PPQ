import type { User } from 'firebase/auth';
import { Bell, BellOff, Volume2, VolumeX } from 'lucide-react';
import { getPlatformAlertLabel } from '../../engine/alertNotifier';
import type { AlertCapabilityStatus } from '../../services/notifications';
import type { SourcesMeta } from '../../hooks/useLiveFeed';
import { PWAInstallButton } from '../PWAInstallButton';

export function WorkspaceToolbar(props: {
  liveCount: number;
  matchCount: number;
  sourcesMeta: SourcesMeta | null;
  modelSamples: number;
  alertCapability: AlertCapabilityStatus;
  osAlertsEnabled: boolean;
  soundAlertsEnabled: boolean;
  autoPoll: boolean;
  user: User | null;
  onToggleOsAlerts: () => void;
  onToggleSound: () => void;
  onToggleAutoPoll: () => void;
  onSignIn: () => void;
  onSignOut: () => void;
}) {
  const p = props;
  const osOn = p.osAlertsEnabled && p.alertCapability.permission === 'granted';
  const platform = getPlatformAlertLabel(p.alertCapability.platform);

  return (
    <div className="border-b border-white/8 bg-[#0B0F17] px-6 py-3 flex flex-wrap items-center justify-between gap-4">
      <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
        <span className="font-mono tabular-nums text-slate-200">
          {p.liveCount} Live · {p.matchCount} Scraped Fixtures
        </span>
        {p.sourcesMeta && (
          <>
            <span aria-hidden="true">·</span>
            <span>BBC Cross-Checked: {p.sourcesMeta.bbcCrossCheckedCount}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">
              Updated {new Date(p.sourcesMeta.scrapedAt).toLocaleTimeString()}
            </span>
          </>
        )}
        <span aria-hidden="true">·</span>
        <span className="font-mono tabular-nums">Model Samples: {p.modelSamples}</span>
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        <button
          type="button"
          onClick={p.onToggleOsAlerts}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
            osOn
              ? 'bg-emerald-500/12 border-emerald-500/35 text-emerald-300'
              : 'bg-[#131A26] border-white/12 text-slate-200 hover:bg-[#1A2333]'
          }`}
        >
          {osOn ? <Bell className="w-3.5 h-3.5" aria-hidden="true" /> : <BellOff className="w-3.5 h-3.5" aria-hidden="true" />}
          <span>{osOn ? `${platform}: On` : `Enable ${platform}`}</span>
        </button>

        <button
          type="button"
          onClick={p.onToggleSound}
          aria-label={p.soundAlertsEnabled ? 'Mute alert chime' : 'Enable alert chime'}
          title={p.soundAlertsEnabled ? 'Alert chime enabled' : 'Alert chime muted'}
          className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
            p.soundAlertsEnabled
              ? 'bg-[#131A26] border-white/12 text-slate-200 hover:bg-[#1A2333]'
              : 'bg-[#131A26] border-white/8 text-slate-500'
          }`}
        >
          {p.soundAlertsEnabled ? <Volume2 className="w-3.5 h-3.5" aria-hidden="true" /> : <VolumeX className="w-3.5 h-3.5" aria-hidden="true" />}
          <span className="hidden sm:inline">{p.soundAlertsEnabled ? 'Chime' : 'Muted'}</span>
        </button>

        <PWAInstallButton />

        <button
          type="button"
          onClick={p.onToggleAutoPoll}
          className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
            p.autoPoll
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
              : 'bg-[#131A26] border-white/12 text-slate-400'
          }`}
        >
          {p.autoPoll ? 'Auto-Poll 30s: On' : 'Auto-Poll: Off'}
        </button>

        {p.user ? (
          <button
            type="button"
            onClick={p.onSignOut}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-white/12 bg-[#131A26] text-slate-300 hover:text-white transition-colors whitespace-nowrap shrink-0"
          >
            Synced ({p.user.email?.split('@')[0]})
          </button>
        ) : (
          <button
            type="button"
            onClick={p.onSignIn}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-white/12 bg-[#131A26] text-slate-200 hover:bg-[#1A2333] transition-colors whitespace-nowrap shrink-0"
          >
            Google Cloud Sync
          </button>
        )}
      </div>
    </div>
  );
}

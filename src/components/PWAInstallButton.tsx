import React, { useState } from 'react';
import { Download } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

export const PWAInstallButton: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={install}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-emerald-500/35 bg-emerald-500/12 text-emerald-300 hover:bg-emerald-500/20 transition-colors whitespace-nowrap shrink-0"
      >
        <Download className="w-3.5 h-3.5" aria-hidden="true" />
        <span>Install App</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-white/12 bg-[#131A26] text-slate-200 hover:bg-[#1A2333] transition-colors whitespace-nowrap shrink-0"
        >
          <Download className="w-3.5 h-3.5" aria-hidden="true" />
          <span>Install on iOS</span>
        </button>

        {showIOSGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
            <div className="w-full max-w-sm rounded-xl bg-[#131A26] border border-white/12 p-6 space-y-3">
              <h3 className="text-base font-semibold text-white">
                Install PitchPulse Quant on iPhone / iPad
              </h3>
              <p className="text-xs text-slate-300 leading-relaxed">
                1. Tap the <strong>Share</strong> button in Safari&apos;s toolbar.
                <br />
                2. Scroll down and tap <strong>Add to Home Screen</strong>.
                <br />
                3. Open the installed app to receive live alert notifications.
              </p>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="w-full rounded-lg bg-[#1F293B] hover:bg-[#2A364D] py-2 text-xs font-medium text-white transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};

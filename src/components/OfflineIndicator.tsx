import React from 'react';
import { useOnlineStatus } from '../hooks/useOnlineStatus';

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div
      role="status"
      className="fixed bottom-4 left-4 z-50 rounded-lg border border-amber-500/40 bg-[#131A26] px-3.5 py-2 text-xs font-medium text-amber-300 shadow-lg"
    >
      Offline — Live scraping paused until connection returns
    </div>
  );
};

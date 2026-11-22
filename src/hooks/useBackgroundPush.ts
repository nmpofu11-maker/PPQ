import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AlertScopeMode, ModelIntelligencePayload } from '../types/soccer';
import {
  getBackgroundPushSubscriptionState,
  sendBackgroundPushTest,
  subscribeToBackgroundWebPush,
  syncBackgroundPushPreferences,
  toBackgroundPushModel,
  unsubscribeFromBackgroundWebPush,
} from '../services/notifications';

/** Server-side (VAPID) background push: subscription state, handlers, and preference/model sync. */
export function useBackgroundPush(params: {
  minEvThreshold: number;
  verifiedLiveOnly: boolean;
  alertScope: AlertScopeMode;
  watchlistIds: string[];
  modelState: ModelIntelligencePayload;
}) {
  const { minEvThreshold, verifiedLiveOnly, alertScope, watchlistIds, modelState } = params;
  const [supported, setSupported] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getBackgroundPushSubscriptionState().then((st) => {
      if (!active) return;
      setSupported(st.supported);
      setSubscribed(st.subscribed);
    });
    return () => {
      active = false;
    };
  }, []);

  const preferences = useMemo(
    () => ({ minEvThreshold, verifiedLiveOnly, scope: alertScope, watchlistIds }),
    [minEvThreshold, verifiedLiveOnly, alertScope, watchlistIds]
  );
  const pushModel = useMemo(() => toBackgroundPushModel(modelState), [modelState]);

  // Keep the server's copy of filters AND the learned model in step with this browser.
  useEffect(() => {
    if (!subscribed) return;
    syncBackgroundPushPreferences(preferences, pushModel).catch(() => {});
  }, [subscribed, preferences, pushModel]);

  const toggle = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      if (subscribed) {
        await unsubscribeFromBackgroundWebPush();
        setSubscribed(false);
        setNotice('Background Web Push unsubscribed on this device.');
      } else {
        const res = await subscribeToBackgroundWebPush(preferences, pushModel);
        if (res.ok) {
          setSubscribed(true);
          setNotice(
            'Subscribed: the server checks live matches roughly every 45s and can alert this device while the tab is closed. Server alerts are only as good as the model and the odds feed, and are not betting advice.'
          );
        } else {
          setNotice(res.error || 'Could not enable background push notifications.');
        }
      }
    } finally {
      setBusy(false);
    }
  }, [subscribed, preferences, pushModel]);

  const sendTest = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await sendBackgroundPushTest();
      if (res.ok && res.sent > 0) {
        setNotice('Test push dispatched to this device.');
      } else if (res.reason === 'cooldown') {
        setNotice('Please wait a little before sending another test push.');
      } else if (res.reason === 'not_subscribed') {
        setNotice('This device is not subscribed. Enable background push first.');
      } else {
        setNotice('The server could not deliver a test push. Try re-subscribing.');
      }
    } finally {
      setBusy(false);
    }
  }, []);

  return { supported, subscribed, busy, notice, toggle, sendTest };
}

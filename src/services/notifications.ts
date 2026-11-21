import {
  detectAlertPlatform,
  formatOsNotificationPayload,
  type AlertPlatform,
  type CrossPlatformAlertItem,
} from '../engine/alertNotifier';

export type OsPermissionState = NotificationPermission | 'unsupported' | 'iframe-blocked';

export interface AlertCapabilityStatus {
  platform: AlertPlatform;
  permission: OsPermissionState;
  isEmbeddedIframe: boolean;
  hasServiceWorker: boolean;
}

export function getAlertCapabilityStatus(): AlertCapabilityStatus {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const platform = detectAlertPlatform(ua);

  let isEmbeddedIframe = false;
  try {
    isEmbeddedIframe = typeof window !== 'undefined' && window.self !== window.top;
  } catch {
    isEmbeddedIframe = true;
  }

  const hasServiceWorker =
    typeof navigator !== 'undefined' && 'serviceWorker' in navigator;

  if (typeof window === 'undefined' || !('Notification' in window)) {
    return {
      platform,
      permission: 'unsupported',
      isEmbeddedIframe,
      hasServiceWorker,
    };
  }

  const perm = Notification.permission;
  return {
    platform,
    permission:
      perm === 'denied' && isEmbeddedIframe ? 'iframe-blocked' : perm,
    isEmbeddedIframe,
    hasServiceWorker,
  };
}

export async function requestOsAlertPermission(): Promise<OsPermissionState> {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }
  let isEmbeddedIframe = false;
  try {
    isEmbeddedIframe = window.self !== window.top;
  } catch {
    isEmbeddedIframe = true;
  }

  try {
    const result = await Notification.requestPermission();
    if (result === 'denied' && isEmbeddedIframe) {
      return 'iframe-blocked';
    }
    return result;
  } catch {
    return isEmbeddedIframe ? 'iframe-blocked' : 'denied';
  }
}

export async function dispatchOsNotification(
  item: CrossPlatformAlertItem,
  onSelectMatch?: (matchId: string) => void
): Promise<boolean> {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return false;
  }
  if (Notification.permission !== 'granted') {
    return false;
  }

  const payload = formatOsNotificationPayload(item);

  // Path 1: ServiceWorkerRegistration.showNotification (mandatory on Android Chrome, also preferred on Windows PWA/desktop)
  if ('serviceWorker' in navigator) {
    try {
      const reg = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1200)),
      ]);
      if (reg && 'showNotification' in reg) {
        const options: NotificationOptions & {
          vibrate?: number[];
          renotify?: boolean;
        } = {
          body: payload.body,
          icon: payload.icon,
          badge: payload.badge,
          tag: payload.tag,
          renotify: true,
          vibrate: payload.vibrate,
          data: payload.data,
        };
        await reg.showNotification(payload.title, options);
        return true;
      }
    } catch {
      // Fall through to desktop Notification constructor
    }
  }

  // Path 2: Desktop Notification API fallback (Windows, macOS, Linux desktop browsers)
  try {
    const notif = new Notification(payload.title, {
      body: payload.body,
      icon: payload.icon,
      tag: payload.tag,
    });
    notif.onclick = () => {
      try {
        window.focus();
      } catch {
        // Ignore focus restrictions
      }
      notif.close();
      if (onSelectMatch && payload.data.matchId) {
        onSelectMatch(payload.data.matchId);
      }
    };
    return true;
  } catch {
    // Android Chrome forbids new Notification() if SW was not ready yet
    return false;
  }
}

export function playAlertChime(kind: CrossPlatformAlertItem['kind'] = 'ev_value'): void {
  if (typeof window === 'undefined') return;
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return;

  try {
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    const notes = kind === 'ev_value' ? [660, 880] : [523.25, 659.25];

    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + idx * 0.11);

      gain.gain.setValueAtTime(0.001, now + idx * 0.11);
      gain.gain.exponentialRampToValueAtTime(0.08, now + idx * 0.11 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.11 + 0.18);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + idx * 0.11);
      osc.stop(now + idx * 0.11 + 0.19);
    });

    setTimeout(() => {
      ctx.close().catch(() => {});
    }, 600);
  } catch {
    // Audio playback may be blocked until first user gesture
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export interface BackgroundPushPreferences {
  minEvThreshold: number;
  verifiedLiveOnly: boolean;
  scope: 'all' | 'watchlist' | 'top_leagues';
  watchlistIds: string[];
}

export async function getBackgroundPushSubscriptionState(): Promise<{
  supported: boolean;
  subscribed: boolean;
  endpoint: string | null;
}> {
  if (
    typeof window === 'undefined' ||
    !('serviceWorker' in navigator) ||
    !('PushManager' in window)
  ) {
    return { supported: false, subscribed: false, endpoint: null };
  }
  try {
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1200)),
    ]);
    if (!reg) return { supported: true, subscribed: false, endpoint: null };
    const sub = await reg.pushManager.getSubscription();
    return {
      supported: true,
      subscribed: Boolean(sub),
      endpoint: sub?.endpoint || null,
    };
  } catch {
    return { supported: false, subscribed: false, endpoint: null };
  }
}

export async function subscribeToBackgroundWebPush(
  preferences: BackgroundPushPreferences
): Promise<{
  ok: boolean;
  endpoint: string | null;
  error?: string;
}> {
  if (
    typeof window === 'undefined' ||
    !('serviceWorker' in navigator) ||
    !('PushManager' in window)
  ) {
    return { ok: false, endpoint: null, error: 'PushManager not supported in this browser.' };
  }

  const perm = await requestOsAlertPermission();
  if (perm !== 'granted') {
    return {
      ok: false,
      endpoint: null,
      error:
        perm === 'iframe-blocked'
          ? 'Open in a standalone browser tab to subscribe to background push notifications.'
          : 'Notification permission is required for background push alerts.',
    };
  }

  try {
    const keyRes = await fetch('/api/push/vapid-public-key');
    if (!keyRes.ok) throw new Error('Failed to fetch VAPID public key.');
    const { publicKey } = (await keyRes.json()) as { publicKey: string };

    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as unknown as BufferSource,
      });
    }

    const saveRes = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON(), preferences }),
    });
    if (!saveRes.ok) {
      const errBody = await saveRes.json().catch(() => ({}));
      throw new Error(errBody.error || 'Failed to register push subscription on server.');
    }

    return { ok: true, endpoint: sub.endpoint };
  } catch (err) {
    return {
      ok: false,
      endpoint: null,
      error: err instanceof Error ? err.message : 'Background Web Push setup failed.',
    };
  }
}

export async function syncBackgroundPushPreferences(
  preferences: BackgroundPushPreferences
): Promise<boolean> {
  const state = await getBackgroundPushSubscriptionState();
  if (!state.subscribed) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return false;
    const res = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON(), preferences }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function unsubscribeFromBackgroundWebPush(): Promise<boolean> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return true;

    const endpoint = sub.endpoint;
    await sub.unsubscribe();
    await fetch('/api/push/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    }).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

export async function sendBackgroundPushTest(): Promise<{
  ok: boolean;
  sent: number;
}> {
  try {
    const state = await getBackgroundPushSubscriptionState();
    const res = await fetch('/api/push/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: state.endpoint }),
    });
    if (!res.ok) return { ok: false, sent: 0 };
    const data = await res.json();
    return { ok: Boolean(data.ok), sent: Number(data.sent) || 0 };
  } catch {
    return { ok: false, sent: 0 };
  }
}


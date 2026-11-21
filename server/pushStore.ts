import fs from 'node:fs';
import path from 'node:path';
import type { PushSubscription } from 'web-push';
import type { AlertScopeMode, ModelIntelligencePayload } from '../src/types/soccer';

export interface SubscriberPreferences {
  minEvThreshold: number;
  verifiedLiveOnly: boolean;
  scope: AlertScopeMode;
  watchlistIds: string[];
}

export type ModelSnapshot = Pick<
  ModelIntelligencePayload,
  'globalWeights' | 'team_intelligence_matrices'
>;

export interface StoredSubscriber {
  subscription: PushSubscription;
  preferences: SubscriberPreferences;
  /** The subscriber's own learned model, synced from their browser. */
  model: ModelSnapshot | null;
  createdAt: string;
}

interface StoreFile {
  version: 1;
  subscribers: StoredSubscriber[];
}

/**
 * Tiny JSON-file persistence for push subscriptions so a server restart does not
 * silently drop every subscriber. Writes are debounced and atomic (tmp + rename).
 *
 * Note: on hosts with an ephemeral filesystem (e.g. Cloud Run) the file is lost on
 * redeploy. Point PUSH_STORE_PATH at a mounted volume for durable storage.
 */
export class PushStore {
  private readonly items = new Map<string, StoredSubscriber>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly filePath: string | null) {
    this.load();
  }

  private load() {
    if (!this.filePath) return;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as StoreFile;
      if (parsed?.version === 1 && Array.isArray(parsed.subscribers)) {
        for (const s of parsed.subscribers) {
          if (s?.subscription?.endpoint) this.items.set(s.subscription.endpoint, s);
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        console.warn('[push] could not read subscription store, starting empty:', err);
      }
    }
  }

  get size() {
    return this.items.size;
  }

  has(endpoint: string) {
    return this.items.has(endpoint);
  }

  get(endpoint: string) {
    return this.items.get(endpoint);
  }

  values() {
    return Array.from(this.items.values());
  }

  entries() {
    return Array.from(this.items.entries());
  }

  set(endpoint: string, value: StoredSubscriber) {
    this.items.set(endpoint, value);
    this.scheduleSave();
  }

  delete(endpoint: string) {
    const removed = this.items.delete(endpoint);
    if (removed) this.scheduleSave();
    return removed;
  }

  private scheduleSave() {
    if (!this.filePath || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 500);
    this.timer.unref();
  }

  flush() {
    if (!this.filePath) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      const body: StoreFile = { version: 1, subscribers: this.values() };
      fs.writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.error('[push] failed to persist subscription store:', err);
    }
  }
}

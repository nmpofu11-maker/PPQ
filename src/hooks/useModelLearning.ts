import { useCallback, useEffect, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import type { LiveCapturedSnapshot, ModelIntelligencePayload, ScrapedMatch } from '../types/soccer';
import { slugifyTeamKey } from '../engine/momentumMath';
import { createInitialModelState, evaluateAndUpdateModel } from '../engine/learningModel';
import { captureLiveMilestoneSnapshots } from '../engine/snapshotRecorder';
import {
  loadLiveSnapshotsFromFirestore,
  loadModelIntelligenceFromFirestore,
  saveCalibrationToFirestore,
  saveLiveSnapshotsToFirestore,
} from '../services/persistence';
import { loadStoredJson, saveStoredJson } from '../lib/storage';
import { parseJsonResponse } from '../lib/safeJson';

const SNAPSHOT_STORAGE_KEY = 'pitchpulse_live_snapshots';

/**
 * Owns the learned model, captured live snapshots and historical calibration.
 * Cloud data is loaded when the user's profile becomes ready.
 */
export function useModelLearning(params: {
  user: User | null;
  userRef: React.MutableRefObject<User | null>;
  profileReady: boolean;
}) {
  const { user, userRef, profileReady } = params;

  const [modelState, setModelState] = useState<ModelIntelligencePayload>(() => createInitialModelState());
  const [liveSnapshots, setLiveSnapshots] = useState<LiveCapturedSnapshot[]>(() =>
    loadStoredJson<LiveCapturedSnapshot[]>(SNAPSHOT_STORAGE_KEY, [])
  );
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [calibrationStatusMsg, setCalibrationStatusMsg] = useState<string | null>(null);

  const modelStateRef = useRef(modelState);
  modelStateRef.current = modelState;
  const liveSnapshotsRef = useRef(liveSnapshots);
  liveSnapshotsRef.current = liveSnapshots;

  useEffect(() => {
    if (!user || !profileReady) return;
    let active = true;
    (async () => {
      try {
        const [loadedModel, loadedSnaps] = await Promise.all([
          loadModelIntelligenceFromFirestore(user.uid),
          loadLiveSnapshotsFromFirestore(user.uid).catch(() => []),
        ]);
        if (!active) return;
        if (loadedModel) setModelState(loadedModel);
        if (loadedSnaps.length > 0) {
          setLiveSnapshots((prev) => {
            const merged = new Map<string, LiveCapturedSnapshot>();
            for (const s of prev) merged.set(s.id, s);
            for (const s of loadedSnaps) merged.set(s.id, s);
            return Array.from(merged.values()).slice(0, 200);
          });
        }
      } catch {
        // Handled via structured handleFirestoreError logging
      }
    })();
    return () => {
      active = false;
    };
  }, [user, profileReady]);

  const persistIfSignedIn = useCallback(
    async (
      nextModel: ModelIntelligencePayload,
      newAudits: ModelIntelligencePayload['recentAudits'],
      sourceMatches: ScrapedMatch[]
    ) => {
      const currentUser = userRef.current;
      if (!currentUser) return;
      const teamDisplayNames: Record<string, string> = {};
      for (const m of sourceMatches) {
        teamDisplayNames[slugifyTeamKey(m.homeTeam)] = m.homeTeam;
        teamDisplayNames[slugifyTeamKey(m.awayTeam)] = m.awayTeam;
      }
      await saveCalibrationToFirestore(currentUser, nextModel, newAudits, teamDisplayNames);
    },
    [userRef]
  );

  /** Called after every live scrape: capture milestone snapshots, then learn from finished matches. */
  const processScrape = useCallback(
    (scraped: ScrapedMatch[]) => {
      // 1. Capture authentic live milestone snapshots (30', 45', 60', 75') for unbiased learning
      const liveWithFlow = scraped.filter((m) => m.state === 'in' && m.hasDetailedFlow);
      let latestSnaps = liveSnapshotsRef.current;
      if (liveWithFlow.length > 0) {
        const cap = captureLiveMilestoneSnapshots({
          liveMatches: liveWithFlow,
          existingSnapshots: liveSnapshotsRef.current,
          modelState: modelStateRef.current,
        });
        if (cap.addedSnapshots.length > 0) {
          latestSnaps = cap.nextSnapshots;
          setLiveSnapshots(cap.nextSnapshots);
          saveStoredJson(SNAPSHOT_STORAGE_KEY, cap.nextSnapshots.slice(0, 120));
          if (userRef.current) {
            saveLiveSnapshotsToFirestore(userRef.current, cap.addedSnapshots).catch(() => {});
          }
        }
      }

      // 2. Continuous learning: evaluate newly finished matches, preferring exact live captures
      const finishedWithFlow = scraped.filter((m) => m.state === 'post' && m.hasDetailedFlow);
      if (finishedWithFlow.length > 0) {
        const { nextState, newAudits, processedCount } = evaluateAndUpdateModel(
          finishedWithFlow,
          modelStateRef.current,
          65,
          latestSnaps
        );
        if (processedCount > 0) {
          setModelState(nextState);
          persistIfSignedIn(nextState, newAudits, finishedWithFlow).catch(() => {});
        }
      }
    },
    [persistIfSignedIn, userRef]
  );

  const runHistoricalCalibration = useCallback(
    async (days: number, snapshotMinute: number) => {
      setIsCalibrating(true);
      setCalibrationStatusMsg(null);
      try {
        const res = await fetch(`/api/historical/finished?days=${encodeURIComponent(String(days))}`);
        const data = await parseJsonResponse<{ matches?: ScrapedMatch[]; datesScraped?: string[] }>(
          res,
          'Historical scrape'
        );
        const finished: ScrapedMatch[] = Array.isArray(data.matches) ? data.matches : [];
        const { nextState, newAudits, processedCount } = evaluateAndUpdateModel(
          finished,
          modelStateRef.current,
          snapshotMinute,
          liveSnapshotsRef.current
        );

        if (processedCount === 0) {
          setCalibrationStatusMsg(
            `Scraped ${finished.length} completed matches across ${data.datesScraped?.join(', ')} — all available matches were already evaluated.`
          );
        } else {
          setModelState(nextState);
          await persistIfSignedIn(nextState, newAudits, finished);
          setCalibrationStatusMsg(
            `Evaluated +${processedCount} real finished matches at ${snapshotMinute}' snapshot (${nextState.metrics.totalEvaluated} total). Mean Brier: ${nextState.metrics.meanBrierScore?.toFixed(4)} · Accuracy: ${nextState.metrics.accuracyPct?.toFixed(1)}%.`
          );
        }
      } catch (err) {
        setCalibrationStatusMsg(err instanceof Error ? err.message : 'Historical calibration failed.');
      } finally {
        setIsCalibrating(false);
      }
    },
    [persistIfSignedIn]
  );

  return {
    modelState,
    liveSnapshots,
    isCalibrating,
    calibrationStatusMsg,
    processScrape,
    runHistoricalCalibration,
  };
}

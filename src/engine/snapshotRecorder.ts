import type {
  LiveCapturedSnapshot,
  ModelIntelligencePayload,
  ScrapedMatch,
} from '../types/soccer';
import { predictMatchMarkets, toOddsFreeSnapshot } from './momentumMath';

export const SNAPSHOT_MILESTONES = [30, 45, 60, 75] as const;
export type MilestoneMinute = (typeof SNAPSHOT_MILESTONES)[number];

/**
 * Captures exact observed mid-match boxscore + play-by-play snapshots during live polling
 * whenever a match reaches a calibration milestone (30', 45', 60', 75' within +/- 4 min).
 * Strictly odds-free via `toOddsFreeSnapshot`.
 */
export function captureLiveMilestoneSnapshots(params: {
  liveMatches: ScrapedMatch[];
  existingSnapshots: LiveCapturedSnapshot[];
  modelState: Pick<ModelIntelligencePayload, 'globalWeights' | 'team_intelligence_matrices'>;
  nowIso?: string;
}): {
  nextSnapshots: LiveCapturedSnapshot[];
  addedSnapshots: LiveCapturedSnapshot[];
} {
  const {
    liveMatches,
    existingSnapshots,
    modelState,
    nowIso = new Date().toISOString(),
  } = params;
  const existingIds = new Set(existingSnapshots.map((s) => s.id));
  const addedSnapshots: LiveCapturedSnapshot[] = [];

  for (const m of liveMatches) {
    if (m.state !== 'in' || !m.hasDetailedFlow || m.minute < 28) continue;

    for (const milestone of SNAPSHOT_MILESTONES) {
      if (Math.abs(m.minute - milestone) > 4) continue;
      const snapId = `${m.id}_${milestone}`;
      if (existingIds.has(snapId)) continue;

      const oddsFree = toOddsFreeSnapshot(m);
      const pred = predictMatchMarkets(oddsFree, modelState);
      existingIds.add(snapId);
      addedSnapshots.push({
        id: snapId,
        matchId: m.id,
        milestoneMinute: milestone,
        capturedMinute: m.minute,
        snapshot: oddsFree,
        netMomentum: pred.netMomentum,
        capturedAt: nowIso,
      });
    }
  }

  if (addedSnapshots.length === 0) {
    return { nextSnapshots: existingSnapshots, addedSnapshots: [] };
  }

  return {
    nextSnapshots: [...addedSnapshots, ...existingSnapshots].slice(0, 200),
    addedSnapshots,
  };
}

/**
 * Looks up the closest authentic live-captured snapshot for a finished match
 * near `targetMinute` (within +/- 8 minutes). Returns null if no exact capture exists.
 */
export function findBestLiveCapturedSnapshot(
  matchId: string,
  targetMinute: number,
  capturedSnapshots: LiveCapturedSnapshot[]
): LiveCapturedSnapshot | null {
  const matchesForFixture = capturedSnapshots.filter((s) => s.matchId === matchId);
  if (matchesForFixture.length === 0) return null;

  let best: LiveCapturedSnapshot | null = null;
  let bestDist = Infinity;

  for (const snap of matchesForFixture) {
    const dist = Math.abs(snap.capturedMinute - targetMinute);
    if (dist <= 8 && dist < bestDist) {
      best = snap;
      bestDist = dist;
    }
  }
  return best;
}

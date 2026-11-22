import { useCallback, useEffect, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import type {
  DetectedTrendSignal,
  PureFlowPrediction,
  ScrapedMatch,
  TacticalAiBrief,
  ValueAlert,
} from '../types/soccer';
import { saveTrendAlertToFirestore } from '../services/persistence';

/** AI tactical briefs. The server requires a signed-in user's Firebase ID token and enforces a daily budget. */
export function useTacticalBriefs(params: {
  user: User | null;
  getIdToken: () => Promise<string | null>;
  matches: ScrapedMatch[];
  predictionsByMatch: Map<string, PureFlowPrediction>;
  allAlerts: ValueAlert[];
  allTrends: DetectedTrendSignal[];
  autoAiOnOverlap: boolean;
}) {
  const { user, getIdToken, matches, predictionsByMatch, allAlerts, allTrends, autoAiOnOverlap } = params;
  const [aiBriefs, setAiBriefs] = useState<Record<string, TacticalAiBrief>>({});
  const [loadingTrendIds, setLoadingTrendIds] = useState<Record<string, boolean>>({});
  const [trendErrors, setTrendErrors] = useState<Record<string, string>>({});
  const autoAttempted = useRef<Set<string>>(new Set());
  const userRef = useRef(user);
  userRef.current = user;

  const analyzeTrend = useCallback(
    async (trend: DetectedTrendSignal) => {
      const match = matches.find((m) => m.id === trend.matchId);
      const pred = predictionsByMatch.get(trend.matchId);
      if (!match || !pred) return;

      setTrendErrors((prev) => {
        const next = { ...prev };
        delete next[trend.id];
        return next;
      });

      const token = await getIdToken();
      if (!token) {
        setTrendErrors((prev) => ({
          ...prev,
          [trend.id]: 'Sign in with Google Cloud Sync to generate AI tactical briefs.',
        }));
        return;
      }

      setLoadingTrendIds((prev) => ({ ...prev, [trend.id]: true }));
      try {
        const res = await fetch('/api/alerts/tactical-brief', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            trend,
            homeTeam: match.homeTeam,
            awayTeam: match.awayTeam,
            possessionHome: match.homeStats.possessionPct,
            possessionAway: match.awayStats.possessionPct,
            shotsHome: `${match.homeStats.totalShots} (${match.homeStats.shotsOnTarget} SoT)`,
            shotsAway: `${match.awayStats.totalShots} (${match.awayStats.shotsOnTarget} SoT)`,
            nextGoalHomeProb: pred.markets.nextTeamToScore.homeProb,
            nextGoalAwayProb: pred.markets.nextTeamToScore.awayProb,
            winHomeProb: pred.markets.winner1X2.homeProb,
            drawProb: pred.markets.winner1X2.drawProb,
            winAwayProb: pred.markets.winner1X2.awayProb,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg =
            res.status === 401
              ? 'Your sign-in expired. Sign in again to use AI briefs.'
              : res.status === 429
              ? data.error || 'Daily AI brief limit reached. Try again tomorrow.'
              : data.error || `AI analysis failed (${res.status})`;
          throw new Error(msg);
        }
        const brief = data.brief as TacticalAiBrief;
        setAiBriefs((prev) => ({ ...prev, [trend.id]: brief }));
        if (userRef.current) {
          saveTrendAlertToFirestore(userRef.current, trend, brief).catch(() => {});
        }
      } catch (err) {
        setTrendErrors((prev) => ({
          ...prev,
          [trend.id]: err instanceof Error ? err.message : 'Unable to generate AI tactical brief.',
        }));
      } finally {
        setLoadingTrendIds((prev) => ({ ...prev, [trend.id]: false }));
      }
    },
    [matches, predictionsByMatch, getIdToken]
  );

  // Auto-brief when enabled, signed in, and a live match has both a >=5% +EV edge and an attack surge
  useEffect(() => {
    if (!user || !autoAiOnOverlap || allTrends.length === 0 || allAlerts.length === 0) return;
    const highEvMatchIds = new Set(allAlerts.filter((a) => a.evPct >= 5.0).map((a) => a.matchId));
    const target = allTrends.find(
      (tr) =>
        highEvMatchIds.has(tr.matchId) &&
        !aiBriefs[tr.id] &&
        !loadingTrendIds[tr.id] &&
        !autoAttempted.current.has(tr.id)
    );
    if (!target) return;
    autoAttempted.current.add(target.id);
    void analyzeTrend(target);
  }, [user, autoAiOnOverlap, allTrends, allAlerts, aiBriefs, loadingTrendIds, analyzeTrend]);

  return { aiBriefs, loadingTrendIds, trendErrors, analyzeTrend };
}

import type {
  DetectedTrendSignal,
  OddsFreeMatchSnapshot,
  PureFlowPrediction,
  TrendPatternType,
} from '../types/soccer';

/**
 * Deterministic rolling-window attack trend detector.
 * Strictly odds-free: inspects only real scraped match events and pure-flow momentum bars.
 */
export function detectAttackTrends(
  snapshot: OddsFreeMatchSnapshot,
  prediction: PureFlowPrediction,
  windowMinutes = 10
): DetectedTrendSignal[] {
  if (snapshot.state !== 'in' || snapshot.minute < 8) return [];

  const minFloor = Math.max(0, snapshot.minute - windowMinutes);
  const windowEvents = snapshot.events.filter(
    (e) => e.minute >= minFloor && e.minute <= snapshot.minute
  );

  const signals: DetectedTrendSignal[] = [];

  for (const side of ['home', 'away'] as const) {
    const teamName = side === 'home' ? snapshot.homeTeam : snapshot.awayTeam;
    const oppRedCards =
      side === 'home' ? snapshot.awayStats.redCards : snapshot.homeStats.redCards;

    const sideEvents = windowEvents.filter((e) => e.teamSide === side);
    const recentShotsOnTarget = sideEvents.filter(
      (e) => e.eventType === 'shot_on_target' || e.eventType === 'goal'
    ).length;
    const recentOffTarget = sideEvents.filter(
      (e) => e.eventType === 'shot_off_target'
    ).length;
    const recentTotalShots = recentShotsOnTarget + recentOffTarget;
    const recentCorners = sideEvents.filter((e) => e.eventType === 'corner').length;

    // Count consecutive minutes up to current minute with positive momentum for `side`
    let consecutiveMomentumMinutes = 0;
    for (let i = prediction.momentumTimeline.length - 1; i >= 0; i--) {
      const pt = prediction.momentumTimeline[i];
      const favorsSide =
        side === 'home' ? pt.netMomentum >= 1.1 : pt.netMomentum <= -1.1;
      if (favorsSide) consecutiveMomentumMinutes += 1;
      else break;
    }

    const patterns: TrendPatternType[] = [];
    if (
      consecutiveMomentumMinutes >= 6 &&
      (recentTotalShots >= 2 || recentCorners >= 2)
    ) {
      patterns.push('Persistent Attack Surge');
    }
    if (recentShotsOnTarget >= 2) {
      patterns.push('Shots-on-Goal Barrage');
    }
    if (recentCorners >= 3) {
      patterns.push('Set-Piece Siege');
    }
    if (oppRedCards >= 1 && (recentTotalShots >= 2 || consecutiveMomentumMinutes >= 5)) {
      patterns.push('Manpower Counter-Press');
    }

    if (patterns.length === 0) continue;

    // Also include cumulative stat check if play-by-play commentary is sparse
    const nextGoalProb =
      side === 'home'
        ? prediction.markets.nextTeamToScore.homeProb
        : prediction.markets.nextTeamToScore.awayProb;
    const winProb =
      side === 'home'
        ? prediction.markets.winner1X2.homeProb
        : prediction.markets.winner1X2.awayProb;

    const over15 = prediction.markets.overUnder.find((o) => o.line === 1.5);
    const over25 = prediction.markets.overUnder.find((o) => o.line === 2.5);
    const totalGoalsNow = snapshot.homeScore + snapshot.awayScore;
    const relevantOverProb =
      totalGoalsNow <= 1 ? over15?.overProb ?? 0.5 : over25?.overProb ?? 0.5;

    let recommendedMarket: DetectedTrendSignal['recommendedMarket'] = 'Next Team to Score';
    let recommendedSelection = `${teamName} Next Goal`;
    let modelProbability = nextGoalProb;

    if (snapshot.minute >= 70 && winProb >= 0.48) {
      recommendedMarket = 'Match Winner (1X2)';
      recommendedSelection = `${teamName} Win`;
      modelProbability = winProb;
    } else if (relevantOverProb >= 0.62 && recentShotsOnTarget >= 2) {
      recommendedMarket = 'Over / Under Goals';
      recommendedSelection = totalGoalsNow <= 1 ? 'Over 1.5 Goals' : 'Over 2.5 Goals';
      modelProbability = relevantOverProb;
    }

    const intensityScore = Number(
      (
        recentShotsOnTarget * 3.2 +
        recentOffTarget * 1.4 +
        recentCorners * 1.3 +
        consecutiveMomentumMinutes * 0.55
      ).toFixed(1)
    );

    const recentCommentary = windowEvents
      .filter((e) =>
        ['goal', 'shot_on_target', 'shot_off_target', 'corner', 'red_card', 'substitution'].includes(
          e.eventType
        )
      )
      .slice(-10)
      .map((e) => `${e.clockDisplay || `${e.minute}'`} ${e.text}`);

    signals.push({
      id: `${snapshot.id}_trend_${side}`,
      matchId: snapshot.id,
      league: snapshot.league,
      matchTitle: `${snapshot.homeTeam} vs ${snapshot.awayTeam}`,
      minute: snapshot.minute,
      scoreline: `${snapshot.homeScore}-${snapshot.awayScore}`,
      teamSide: side,
      teamName,
      patterns,
      patternLabel: patterns.join(' · '),
      windowMinutes,
      recentShots: recentTotalShots,
      recentShotsOnTarget,
      recentCorners,
      consecutiveMomentumMinutes,
      intensityScore,
      recommendedMarket,
      recommendedSelection,
      modelProbability: Number(modelProbability.toFixed(4)),
      recentCommentary,
    });
  }

  return signals.sort((a, b) => b.intensityScore - a.intensityScore);
}

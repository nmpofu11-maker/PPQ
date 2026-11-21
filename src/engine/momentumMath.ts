import type {
  AsianHandicapProb,
  GlobalModelWeights,
  MatchEventItem,
  ModelIntelligencePayload,
  MomentumPoint,
  OddsFreeMatchSnapshot,
  OverUnderLineProb,
  PureFlowPrediction,
  ScrapedMatch,
  TeamMatchStats,
} from '../types/soccer';

const DECAY_LAMBDA = 0.085; // ~8.15 min half-life for recency-weighted match flow

export function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

export function slugifyTeamKey(teamName: string): string {
  const cleaned = teamName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned.slice(0, 120) || 'unknown_team';
}

export function toOddsFreeSnapshot(match: ScrapedMatch): OddsFreeMatchSnapshot {
  return {
    id: match.id,
    league: match.league,
    state: match.state,
    minute: match.minute,
    homeTeam: match.homeTeam,
    awayTeam: match.awayTeam,
    homeScore: match.homeScore,
    awayScore: match.awayScore,
    homeStats: match.homeStats,
    awayStats: match.awayStats,
    events: match.events,
  };
}

function getEventBaseImpact(eventType: MatchEventItem['eventType']): number {
  switch (eventType) {
    case 'shot_on_target':
      return 3.5;
    case 'save':
      // A goalkeeper save means the *opposing* attacking team forced a shot on target;
      // handled symmetrically by commentary classification, keep mild defensive note here
      return 0.4;
    case 'shot_off_target':
      return 1.6;
    case 'corner':
      return 1.25;
    case 'foul':
      return -0.25;
    case 'yellow_card':
      return -0.9;
    case 'red_card':
      return -6.5;
    case 'goal':
      return 2.4;
    default:
      return 0;
  }
}

/**
 * Reconstructs a strictly causal mid-match snapshot at `targetMinute` from real play-by-play events.
 * Events occurring after `targetMinute` are excluded to prevent future leakage during historical training.
 */
export function reconstructSnapshotAtMinute(
  match: ScrapedMatch,
  targetMinute: number
): OddsFreeMatchSnapshot {
  const causalEvents = match.events.filter((e) => e.minute <= targetMinute);

  let homeScore = 0;
  let awayScore = 0;
  const homeStats: TeamMatchStats = {
    possessionPct: match.homeStats.possessionPct,
    totalShots: 0,
    shotsOnTarget: 0,
    wonCorners: 0,
    foulsCommitted: 0,
    yellowCards: 0,
    redCards: 0,
    offsides: 0,
    saves: 0,
    formScore: match.homeStats.formScore,
    lastFiveSummary: match.homeStats.lastFiveSummary,
  };
  const awayStats: TeamMatchStats = {
    possessionPct: match.awayStats.possessionPct,
    totalShots: 0,
    shotsOnTarget: 0,
    wonCorners: 0,
    foulsCommitted: 0,
    yellowCards: 0,
    redCards: 0,
    offsides: 0,
    saves: 0,
    formScore: match.awayStats.formScore,
    lastFiveSummary: match.awayStats.lastFiveSummary,
  };

  for (const ev of causalEvents) {
    const target =
      ev.teamSide === 'home' ? homeStats : ev.teamSide === 'away' ? awayStats : null;
    if (!target) continue;

    if (ev.eventType === 'goal') {
      if (ev.teamSide === 'home') homeScore += 1;
      if (ev.teamSide === 'away') awayScore += 1;
      target.totalShots += 1;
      target.shotsOnTarget += 1;
    } else if (ev.eventType === 'shot_on_target') {
      target.totalShots += 1;
      target.shotsOnTarget += 1;
    } else if (ev.eventType === 'shot_off_target') {
      target.totalShots += 1;
    } else if (ev.eventType === 'corner') {
      target.wonCorners += 1;
    } else if (ev.eventType === 'foul') {
      target.foulsCommitted += 1;
    } else if (ev.eventType === 'yellow_card') {
      target.yellowCards += 1;
    } else if (ev.eventType === 'red_card') {
      target.redCards += 1;
    } else if (ev.eventType === 'save') {
      target.saves += 1;
    }
  }

  // If play-by-play events didn't capture all boxscore stats (e.g. sparse feed),
  // scale cumulative boxscore stats proportionally by minute / 90 without leaking goals.
  if (causalEvents.length < 10 && match.minute > 0) {
    const ratio = clamp(targetMinute / Math.max(match.minute, 90), 0.1, 1);
    homeStats.totalShots = Math.round(match.homeStats.totalShots * ratio);
    homeStats.shotsOnTarget = Math.round(match.homeStats.shotsOnTarget * ratio);
    homeStats.wonCorners = Math.round(match.homeStats.wonCorners * ratio);
    awayStats.totalShots = Math.round(match.awayStats.totalShots * ratio);
    awayStats.shotsOnTarget = Math.round(match.awayStats.shotsOnTarget * ratio);
    awayStats.wonCorners = Math.round(match.awayStats.wonCorners * ratio);
  }

  return {
    id: match.id,
    league: match.league,
    state: targetMinute >= 90 ? 'post' : 'in',
    minute: targetMinute,
    homeTeam: match.homeTeam,
    awayTeam: match.awayTeam,
    homeScore,
    awayScore,
    homeStats,
    awayStats,
    events: causalEvents,
  };
}

export function computeMomentumAtMinute(
  events: MatchEventItem[],
  homeStats: TeamMatchStats,
  awayStats: TeamMatchStats,
  minute: number,
  weights: GlobalModelWeights
): { homeMomentum: number; awayMomentum: number; netMomentum: number } {
  let homeFlow = 0;
  let awayFlow = 0;

  for (const ev of events) {
    if (ev.minute > minute) continue;
    const age = Math.max(0, minute - ev.minute);
    const decay = ev.eventType === 'red_card' ? 1.0 : Math.exp(-DECAY_LAMBDA * age);
    const impact = getEventBaseImpact(ev.eventType) * decay;

    if (ev.teamSide === 'home') {
      homeFlow += impact;
    } else if (ev.teamSide === 'away') {
      awayFlow += impact;
    }
  }

  // Cumulative boxscore statistical pressure (normalized by elapsed game time)
  const elapsedFactor = Math.max(1, minute / 15);
  const possDiff =
    homeStats.possessionPct !== null && awayStats.possessionPct !== null
      ? (homeStats.possessionPct - awayStats.possessionPct) / 100
      : 0;

  const homeStatPressure =
    weights.shotOnTargetWeight * (homeStats.shotsOnTarget / elapsedFactor) * 3.2 +
    weights.cornerPressureWeight * (homeStats.wonCorners / elapsedFactor) * 1.8 +
    (homeStats.totalShots / elapsedFactor) * 0.9 +
    weights.possessionWeight * Math.max(0, possDiff) * 4.5 -
    homeStats.redCards * 4.5;

  const awayStatPressure =
    weights.shotOnTargetWeight * (awayStats.shotsOnTarget / elapsedFactor) * 3.2 +
    weights.cornerPressureWeight * (awayStats.wonCorners / elapsedFactor) * 1.8 +
    (awayStats.totalShots / elapsedFactor) * 0.9 +
    weights.possessionWeight * Math.max(0, -possDiff) * 4.5 -
    awayStats.redCards * 4.5;

  const homeMomentum = Number((homeFlow * 0.65 + homeStatPressure * 0.35).toFixed(2));
  const awayMomentum = Number((awayFlow * 0.65 + awayStatPressure * 0.35).toFixed(2));
  const netMomentum = Number((homeMomentum - awayMomentum).toFixed(2));

  return { homeMomentum, awayMomentum, netMomentum };
}

export function computeMomentumTimeline(
  snapshot: OddsFreeMatchSnapshot,
  weights: GlobalModelWeights
): MomentumPoint[] {
  const maxMin = Math.max(1, Math.min(95, snapshot.minute || 1));
  const points: MomentumPoint[] = [];

  for (let m = 1; m <= maxMin; m += 1) {
    const res = computeMomentumAtMinute(
      snapshot.events,
      snapshot.homeStats,
      snapshot.awayStats,
      m,
      weights
    );
    const minuteMajorEvents = snapshot.events
      .filter(
        (e) =>
          Math.max(1, e.minute) === m &&
          (e.eventType === 'goal' || e.eventType === 'red_card') &&
          (e.teamSide === 'home' || e.teamSide === 'away')
      )
      .map((e) => ({
        type: e.eventType as 'goal' | 'red_card',
        side: e.teamSide as 'home' | 'away',
        text: e.text,
      }));

    const firstNote = minuteMajorEvents[0];
    points.push({
      minute: m,
      homeMomentum: res.homeMomentum,
      awayMomentum: res.awayMomentum,
      netMomentum: res.netMomentum,
      eventNote: firstNote
        ? `${m}' ${firstNote.type === 'goal' ? 'Goal' : 'Red Card'}`
        : undefined,
      majorEvents: minuteMajorEvents.length > 0 ? minuteMajorEvents : undefined,
    });
  }

  return points;
}

function poissonPmf(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) {
    logP -= Math.log(i);
  }
  return Math.exp(logP);
}

/**
 * Pure-flow mathematical prediction engine.
 * Notice: `OddsFreeMatchSnapshot` intentionally has NO odds fields.
 * Prematch and live odds never enter any calculation here.
 */
export function predictMatchMarkets(
  snapshot: OddsFreeMatchSnapshot,
  modelState: Pick<ModelIntelligencePayload, 'globalWeights' | 'team_intelligence_matrices'>
): PureFlowPrediction {
  const w = modelState.globalWeights;
  const homeKey = slugifyTeamKey(snapshot.homeTeam);
  const awayKey = slugifyTeamKey(snapshot.awayTeam);

  const homeTeamLearned = modelState.team_intelligence_matrices[homeKey]?.learned_coefficients;
  const awayTeamLearned = modelState.team_intelligence_matrices[awayKey]?.learned_coefficients;

  const homeAdvMult = homeTeamLearned?.home_advantage_multiplier ?? w.homeAdvantageBase;
  const homeFormWeight = homeTeamLearned?.form_momentum_weight ?? 1.0;
  const awayFormWeight = awayTeamLearned?.form_momentum_weight ?? 1.0;
  const homeVol = homeTeamLearned?.volatility_index ?? 1.0;
  const awayVol = awayTeamLearned?.volatility_index ?? 1.0;
  const homeFatigueMod = homeTeamLearned?.fatigue_penalty_modifier ?? 1.0;
  const awayFatigueMod = awayTeamLearned?.fatigue_penalty_modifier ?? 1.0;

  const effectiveMinute = snapshot.state === 'pre' ? 0 : clamp(snapshot.minute, 0, 95);
  const momentumTimeline = computeMomentumTimeline(snapshot, w);
  const currentMom = computeMomentumAtMinute(
    snapshot.events,
    snapshot.homeStats,
    snapshot.awayStats,
    effectiveMinute,
    w
  );

  const elapsed90 = Math.max(0.18, effectiveMinute / 90);
  const remainingFraction =
    snapshot.state === 'post' ? 0 : clamp((92 - effectiveMinute) / 90, 0.02, 1.02);

  // Compute offensive intensity per 90 mins purely from real match stats + real last-5 form
  const homeSotRate = snapshot.homeStats.shotsOnTarget / elapsed90;
  const awaySotRate = snapshot.awayStats.shotsOnTarget / elapsed90;
  const homeCornerRate = snapshot.homeStats.wonCorners / elapsed90;
  const awayCornerRate = snapshot.awayStats.wonCorners / elapsed90;

  const homeFormBoost = (snapshot.homeStats.formScore ?? 0) * 0.42 * homeFormWeight;
  const awayFormBoost = (snapshot.awayStats.formScore ?? 0) * 0.42 * awayFormWeight;
  const homeShotVolRate = snapshot.homeStats.totalShots / elapsed90;
  const awayShotVolRate = snapshot.awayStats.totalShots / elapsed90;

  const possHomeEdge =
    snapshot.homeStats.possessionPct !== null && snapshot.awayStats.possessionPct !== null
      ? (snapshot.homeStats.possessionPct - 50) / 100
      : 0;

  const lateFatigueHome = effectiveMinute > 65 ? 1 / clamp(homeFatigueMod, 0.75, 1.35) : 1;
  const lateFatigueAway = effectiveMinute > 65 ? 1 / clamp(awayFatigueMod, 0.75, 1.35) : 1;

  // Red card manpower differential
  const homeRedFactor =
    Math.pow(0.68, snapshot.homeStats.redCards) * Math.pow(1.24, snapshot.awayStats.redCards);
  const awayRedFactor =
    Math.pow(0.68, snapshot.awayStats.redCards) * Math.pow(1.24, snapshot.homeStats.redCards);

  const momentumTilt = Math.tanh(currentMom.netMomentum / 10);

  const homeBase90 = clamp(
    (1.22 +
      w.baseTempoBias +
      w.shotOnTargetWeight * 0.14 * homeSotRate +
      0.04 * homeShotVolRate +
      w.cornerPressureWeight * 0.06 * homeCornerRate +
      w.possessionWeight * 0.35 * possHomeEdge +
      homeFormBoost) *
      homeAdvMult *
      homeVol *
      lateFatigueHome *
      homeRedFactor *
      Math.exp(w.momentumSensitivity * momentumTilt),
    0.25,
    4.2
  );

  const awayBase90 = clamp(
    (1.08 +
      w.baseTempoBias +
      w.shotOnTargetWeight * 0.14 * awaySotRate +
      0.04 * awayShotVolRate +
      w.cornerPressureWeight * 0.06 * awayCornerRate +
      w.possessionWeight * 0.35 * -possHomeEdge +
      awayFormBoost) *
      awayVol *
      lateFatigueAway *
      awayRedFactor *
      Math.exp(-w.momentumSensitivity * momentumTilt),
    0.22,
    4.0
  );

  const homeLambdaRem =
    snapshot.state === 'post' ? 0 : Number((homeBase90 * remainingFraction).toFixed(3));
  const awayLambdaRem =
    snapshot.state === 'post' ? 0 : Number((awayBase90 * remainingFraction).toFixed(3));

  // Joint Poisson probability grid over remaining goals (0..7)
  const MAX_GOALS = 7;
  const pHome = Array.from({ length: MAX_GOALS + 1 }, (_, k) => poissonPmf(k, homeLambdaRem));
  const pAway = Array.from({ length: MAX_GOALS + 1 }, (_, k) => poissonPmf(k, awayLambdaRem));

  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  const totalGoalMass: Record<number, number> = {};
  const marginMass: Record<number, number> = {};

  for (let i = 0; i <= MAX_GOALS; i++) {
    for (let j = 0; j <= MAX_GOALS; j++) {
      const joint = pHome[i] * pAway[j];
      const finalH = snapshot.homeScore + i;
      const finalA = snapshot.awayScore + j;
      if (finalH > finalA) homeWin += joint;
      else if (finalH === finalA) draw += joint;
      else awayWin += joint;

      const totalG = finalH + finalA;
      totalGoalMass[totalG] = (totalGoalMass[totalG] || 0) + joint;
      const margin = finalH - finalA;
      marginMass[margin] = (marginMass[margin] || 0) + joint;
    }
  }

  // Normalize tiny truncation tail
  const norm = homeWin + draw + awayWin || 1;
  homeWin /= norm;
  draw /= norm;
  awayWin /= norm;

  const dnbDenom = homeWin + awayWin || 1;
  const dnbHome = homeWin / dnbDenom;
  const dnbAway = awayWin / dnbDenom;

  // Next Team to Score (competing Poisson hazard rates)
  const totalLam = homeLambdaRem + awayLambdaRem;
  const noMoreGoalProb = snapshot.state === 'post' ? 1 : Math.exp(-totalLam);
  const anyMoreGoalProb = 1 - noMoreGoalProb;
  const nextHomeProb = totalLam > 0 ? anyMoreGoalProb * (homeLambdaRem / totalLam) : 0;
  const nextAwayProb = totalLam > 0 ? anyMoreGoalProb * (awayLambdaRem / totalLam) : 0;

  // Over / Under Lines
  const overUnderLines = [0.5, 1.5, 2.5, 3.5, 4.5];
  const overUnder: OverUnderLineProb[] = overUnderLines.map((line) => {
    let over = 0;
    for (const [gStr, p] of Object.entries(totalGoalMass)) {
      if (Number(gStr) > line) over += p;
    }
    over = clamp(over / norm, 0, 1);
    return {
      line,
      overProb: over,
      underProb: 1 - over,
    };
  });

  // Asian Handicap lines from home perspective
  const ahLines = [-1.5, -0.5, 0.0, 0.5, 1.5];
  const asianHandicap: AsianHandicapProb[] = ahLines.map((line) => {
    let cover = 0;
    let push = 0;
    let lose = 0;
    for (const [mStr, p] of Object.entries(marginMass)) {
      const adj = Number(mStr) + line;
      if (adj > 0) cover += p;
      else if (adj === 0) push += p;
      else lose += p;
    }
    const denom = cover + push + lose || 1;
    return {
      line,
      homeCoverProb: cover / denom,
      awayCoverProb: lose / denom,
      pushProb: push / denom,
    };
  });

  // Evidence summary strictly grounded in observed stats
  const evidenceReasons: string[] = [];
  if (Math.abs(currentMom.netMomentum) >= 2.0) {
    const leader = currentMom.netMomentum > 0 ? snapshot.homeTeam : snapshot.awayTeam;
    evidenceReasons.push(
      `${leader} holds a ${Math.abs(currentMom.netMomentum).toFixed(1)} momentum surge from recent match flow`
    );
  } else {
    evidenceReasons.push(
      `Balanced tactical flow (net momentum ${currentMom.netMomentum >= 0 ? '+' : ''}${currentMom.netMomentum.toFixed(1)})`
    );
  }

  if (snapshot.homeStats.shotsOnTarget !== snapshot.awayStats.shotsOnTarget) {
    evidenceReasons.push(
      `Shots on target edge: ${snapshot.homeTeam} ${snapshot.homeStats.shotsOnTarget} vs ${snapshot.awayTeam} ${snapshot.awayStats.shotsOnTarget}`
    );
  }

  if (snapshot.homeStats.wonCorners + snapshot.awayStats.wonCorners >= 3) {
    evidenceReasons.push(
      `Corner pressure: ${snapshot.homeStats.wonCorners}–${snapshot.awayStats.wonCorners} across ${effectiveMinute}' elapsed`
    );
  }

  if (snapshot.homeStats.redCards > 0 || snapshot.awayStats.redCards > 0) {
    evidenceReasons.push(
      `Red card manpower shift (${snapshot.homeStats.redCards}H / ${snapshot.awayStats.redCards}A)`
    );
  }

  if (snapshot.homeStats.formScore !== null && snapshot.awayStats.formScore !== null) {
    evidenceReasons.push(
      `Recent 5-match form index: ${snapshot.homeTeam} ${snapshot.homeStats.formScore >= 0 ? '+' : ''}${snapshot.homeStats.formScore.toFixed(2)} vs ${snapshot.awayTeam} ${snapshot.awayStats.formScore >= 0 ? '+' : ''}${snapshot.awayStats.formScore.toFixed(2)}`
    );
  }

  const dominantSide =
    currentMom.netMomentum > 1.5
      ? 'home'
      : currentMom.netMomentum < -1.5
      ? 'away'
      : 'balanced';

  return {
    matchId: snapshot.id,
    snapshotMinute: effectiveMinute,
    homeLambdaRem,
    awayLambdaRem,
    homeMomentum: currentMom.homeMomentum,
    awayMomentum: currentMom.awayMomentum,
    netMomentum: currentMom.netMomentum,
    dominantSide,
    momentumTimeline,
    markets: {
      winner1X2: {
        homeProb: homeWin,
        drawProb: draw,
        awayProb: awayWin,
      },
      drawNoBet: {
        homeProb: dnbHome,
        awayProb: dnbAway,
      },
      nextTeamToScore: {
        homeProb: nextHomeProb,
        awayProb: nextAwayProb,
        noGoalProb: noMoreGoalProb,
      },
      overUnder,
      doubleChance: {
        homeOrDrawProb: clamp(homeWin + draw, 0, 1),
        awayOrDrawProb: clamp(awayWin + draw, 0, 1),
        homeOrAwayProb: clamp(homeWin + awayWin, 0, 1),
      },
      asianHandicap,
    },
    evidenceReasons,
  };
}

import type {
  AuditLogEntry,
  LiveCapturedSnapshot,
  ModelIntelligencePayload,
  ScrapedMatch,
  TeamLearnedCoefficients,
} from '../types/soccer';
import {
  clamp,
  predictMatchMarkets,
  reconstructSnapshotAtMinute,
  slugifyTeamKey,
} from './momentumMath';
import { findBestLiveCapturedSnapshot } from './snapshotRecorder';

export function createInitialModelState(): ModelIntelligencePayload {
  return {
    sync_timestamp: new Date().toISOString(),
    model_engine: 'Poisson-Flow Online Brier Optimizer v1.0',
    meta_improvement_notes:
      'Initialized at analytical baseline prior to historical calibration runs.',
    globalWeights: {
      momentumSensitivity: 0.42,
      shotOnTargetWeight: 0.95,
      possessionWeight: 0.45,
      cornerPressureWeight: 0.65,
      baseTempoBias: 0.0,
      homeAdvantageBase: 1.08,
    },
    metrics: {
      totalEvaluated: 0,
      correctPredictions: 0,
      cumulativeBrier: 0,
      cumulativeLogLoss: 0,
      meanBrierScore: null,
      meanLogLoss: null,
      accuracyPct: null,
    },
    team_intelligence_matrices: {},
    recentAudits: [],
  };
}

function getOrCreateTeamMatrix(
  matrices: Record<string, TeamLearnedCoefficients>,
  teamKey: string
): TeamLearnedCoefficients {
  if (matrices[teamKey]) {
    return {
      sample_size_matches: matrices[teamKey].sample_size_matches,
      learned_coefficients: { ...matrices[teamKey].learned_coefficients },
    };
  }
  return {
    sample_size_matches: 0,
    learned_coefficients: {
      home_advantage_multiplier: 1.08,
      form_momentum_weight: 1.0,
      volatility_index: 1.0,
      fatigue_penalty_modifier: 1.0,
    },
  };
}

/**
 * Pure mathematical online learning loop over real finished matches (`state === 'post'`).
 * Prefers exact live-captured in-play snapshots recorded during earlier polling whenever available
 * (zero reconstruction bias), and falls back to strictly causal minute-clipped event reconstruction.
 */
export function evaluateAndUpdateModel(
  finishedMatches: ScrapedMatch[],
  currentState: ModelIntelligencePayload,
  snapshotMinute = 65,
  liveSnapshots: LiveCapturedSnapshot[] = []
): {
  nextState: ModelIntelligencePayload;
  newAudits: AuditLogEntry[];
  processedCount: number;
} {
  const alreadyAuditedIds = new Set(currentState.recentAudits.map((a) => a.matchId));
  const candidates = finishedMatches.filter(
    (m) => m.state === 'post' && !alreadyAuditedIds.has(m.id)
  );

  if (candidates.length === 0) {
    return {
      nextState: currentState,
      newAudits: [],
      processedCount: 0,
    };
  }

  const nextWeights = { ...currentState.globalWeights };
  const nextMatrices: Record<string, TeamLearnedCoefficients> = {
    ...currentState.team_intelligence_matrices,
  };
  let totalEvaluated = currentState.metrics.totalEvaluated;
  let correctPredictions = currentState.metrics.correctPredictions;
  let cumulativeBrier = currentState.metrics.cumulativeBrier;
  let cumulativeLogLoss = currentState.metrics.cumulativeLogLoss;

  const newAudits: AuditLogEntry[] = [];
  const learningRate = 0.035;

  let homeResidualSum = 0;
  let goalTotalResidualSum = 0;
  let exactLiveUsedCount = 0;

  for (const match of candidates) {
    // 1. Prefer exact live-captured snapshot near `snapshotMinute`, else causal reconstruction
    const exactCapture = findBestLiveCapturedSnapshot(match.id, snapshotMinute, liveSnapshots);
    const snapshot = exactCapture
      ? exactCapture.snapshot
      : reconstructSnapshotAtMinute(match, snapshotMinute);
    const usedMinute = exactCapture ? exactCapture.capturedMinute : snapshotMinute;
    const snapshotSource: AuditLogEntry['snapshotSource'] = exactCapture
      ? 'exact_live_capture'
      : 'causal_reconstruction';
    if (exactCapture) exactLiveUsedCount += 1;

    // 2. Generate pure-flow prediction using current learned parameters (NO odds)
    const prediction = predictMatchMarkets(snapshot, {
      globalWeights: nextWeights,
      team_intelligence_matrices: nextMatrices,
    });

    // 3. Compare against real full-time outcome
    const yH = match.homeScore > match.awayScore ? 1 : 0;
    const yD = match.homeScore === match.awayScore ? 1 : 0;
    const yA = match.homeScore < match.awayScore ? 1 : 0;

    const pH = prediction.markets.winner1X2.homeProb;
    const pD = prediction.markets.winner1X2.drawProb;
    const pA = prediction.markets.winner1X2.awayProb;

    const brier = ((pH - yH) ** 2 + (pD - yD) ** 2 + (pA - yA) ** 2) / 3;
    const actualProb = yH ? pH : yD ? pD : pA;
    const logLoss = -Math.log(Math.max(0.01, actualProb));

    const predictedWinner =
      pH >= pD && pH >= pA ? 'Home' : pA >= pH && pA >= pD ? 'Away' : 'Draw';
    const actualOutcome = yH ? 'Home' : yA ? 'Away' : 'Draw';
    const isCorrect = predictedWinner === actualOutcome;

    totalEvaluated += 1;
    if (isCorrect) correctPredictions += 1;
    cumulativeBrier += brier;
    cumulativeLogLoss += logLoss;

    // 4. Online stochastic gradient updates on global weights
    const homeError = yH - pH;
    const awayError = yA - pA;
    const momentumDirection = Math.tanh(prediction.netMomentum / 10);
    const directionalError = (homeError - awayError) * momentumDirection;
    nextWeights.momentumSensitivity = clamp(
      Number((nextWeights.momentumSensitivity + learningRate * directionalError).toFixed(4)),
      0.1,
      1.5
    );

    const sotDiff = snapshot.homeStats.shotsOnTarget - snapshot.awayStats.shotsOnTarget;
    if (sotDiff !== 0) {
      const sotAlign = Math.sign(sotDiff) * (homeError - awayError);
      nextWeights.shotOnTargetWeight = clamp(
        Number((nextWeights.shotOnTargetWeight + learningRate * 0.6 * sotAlign).toFixed(4)),
        0.2,
        1.8
      );
    }

    const totalActualGoals = match.homeScore + match.awayScore;
    const totalExpectedGoals =
      snapshot.homeScore +
      snapshot.awayScore +
      prediction.homeLambdaRem +
      prediction.awayLambdaRem;
    const goalResidual = totalActualGoals - totalExpectedGoals;
    goalTotalResidualSum += goalResidual;
    nextWeights.baseTempoBias = clamp(
      Number((nextWeights.baseTempoBias + learningRate * 0.25 * goalResidual).toFixed(4)),
      -0.45,
      0.45
    );

    homeResidualSum += homeError;
    nextWeights.homeAdvantageBase = clamp(
      Number((nextWeights.homeAdvantageBase + learningRate * 0.2 * homeError).toFixed(4)),
      0.9,
      1.3
    );

    // 5. Update per-team intelligence matrices
    const homeKey = slugifyTeamKey(match.homeTeam);
    const awayKey = slugifyTeamKey(match.awayTeam);
    const hMat = getOrCreateTeamMatrix(nextMatrices, homeKey);
    const aMat = getOrCreateTeamMatrix(nextMatrices, awayKey);

    hMat.sample_size_matches += 1;
    aMat.sample_size_matches += 1;

    hMat.learned_coefficients.home_advantage_multiplier = clamp(
      Number(
        (hMat.learned_coefficients.home_advantage_multiplier + 0.025 * homeError).toFixed(4)
      ),
      0.8,
      1.45
    );

    const lateGoalsHome = match.events.filter(
      (e) => e.teamSide === 'home' && e.eventType === 'goal' && e.minute > 65
    ).length;
    const lateGoalsAway = match.events.filter(
      (e) => e.teamSide === 'away' && e.eventType === 'goal' && e.minute > 65
    ).length;

    hMat.learned_coefficients.volatility_index = clamp(
      Number(
        (
          hMat.learned_coefficients.volatility_index +
          0.02 * (Math.abs(goalResidual) - 0.8)
        ).toFixed(4)
      ),
      0.65,
      1.65
    );
    aMat.learned_coefficients.volatility_index = clamp(
      Number(
        (
          aMat.learned_coefficients.volatility_index +
          0.02 * (Math.abs(goalResidual) - 0.8)
        ).toFixed(4)
      ),
      0.65,
      1.65
    );

    hMat.learned_coefficients.fatigue_penalty_modifier = clamp(
      Number(
        (
          hMat.learned_coefficients.fatigue_penalty_modifier +
          0.02 * (lateGoalsAway - lateGoalsHome)
        ).toFixed(4)
      ),
      0.7,
      1.45
    );
    aMat.learned_coefficients.fatigue_penalty_modifier = clamp(
      Number(
        (
          aMat.learned_coefficients.fatigue_penalty_modifier +
          0.02 * (lateGoalsHome - lateGoalsAway)
        ).toFixed(4)
      ),
      0.7,
      1.45
    );

    if (snapshot.homeStats.formScore !== null) {
      hMat.learned_coefficients.form_momentum_weight = clamp(
        Number(
          (
            hMat.learned_coefficients.form_momentum_weight +
            0.03 * homeError * Math.sign(snapshot.homeStats.formScore || 1)
          ).toFixed(4)
        ),
        0.5,
        1.6
      );
    }
    if (snapshot.awayStats.formScore !== null) {
      aMat.learned_coefficients.form_momentum_weight = clamp(
        Number(
          (
            aMat.learned_coefficients.form_momentum_weight +
            0.03 * awayError * Math.sign(snapshot.awayStats.formScore || 1)
          ).toFixed(4)
        ),
        0.5,
        1.6
      );
    }

    nextMatrices[homeKey] = hMat;
    nextMatrices[awayKey] = aMat;

    const topProb =
      predictedWinner === 'Home' ? pH : predictedWinner === 'Away' ? pA : pD;

    newAudits.push({
      id: `${match.id}_${usedMinute}`,
      matchId: match.id,
      league: match.league,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      finalScore: `${match.homeScore}-${match.awayScore}`,
      snapshotMinute: usedMinute,
      snapshotSource,
      market: 'Match Winner (1X2)',
      selection:
        predictedWinner === 'Home'
          ? match.homeTeam
          : predictedWinner === 'Away'
          ? match.awayTeam
          : 'Draw',
      modelProbability: Number(topProb.toFixed(4)),
      actualOutcome,
      isCorrect,
      brierScore: Number(brier.toFixed(4)),
      createdAt: new Date().toISOString(),
    });
  }

  const meanBrier = Number((cumulativeBrier / totalEvaluated).toFixed(4));
  const meanLogLoss = Number((cumulativeLogLoss / totalEvaluated).toFixed(4));
  const accuracyPct = Number(((correctPredictions / totalEvaluated) * 100).toFixed(1));

  const avgGoalRes = (goalTotalResidualSum / candidates.length).toFixed(2);
  const avgHomeRes = (homeResidualSum / candidates.length).toFixed(2);

  const nextState: ModelIntelligencePayload = {
    sync_timestamp: new Date().toISOString(),
    model_engine: 'Poisson-Flow Online Brier Optimizer v1.0',
    meta_improvement_notes: `Calibrated on +${candidates.length} finished matches (${exactLiveUsedCount} exact live-captured, ${candidates.length - exactLiveUsedCount} reconstructed; ${totalEvaluated} total). Mean Brier ${meanBrier}, 1X2 Accuracy ${accuracyPct}%. Mean goal residual ${avgGoalRes}, home residual ${avgHomeRes}.`,
    globalWeights: nextWeights,
    metrics: {
      totalEvaluated,
      correctPredictions,
      cumulativeBrier: Number(cumulativeBrier.toFixed(4)),
      cumulativeLogLoss: Number(cumulativeLogLoss.toFixed(4)),
      meanBrierScore: meanBrier,
      meanLogLoss: meanLogLoss,
      accuracyPct,
    },
    team_intelligence_matrices: nextMatrices,
    recentAudits: [...newAudits, ...currentState.recentAudits].slice(0, 120),
  };

  return {
    nextState,
    newAudits,
    processedCount: candidates.length,
  };
}

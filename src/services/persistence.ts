import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import type { User } from 'firebase/auth';
import type {
  AuditLogEntry,
  LiveCapturedSnapshot,
  ModelIntelligencePayload,
  OddsFreeMatchSnapshot,
  PaperBetRecord,
  TeamLearnedCoefficients,
} from '../types/soccer';
import { clamp, slugifyTeamKey } from '../engine/momentumMath';
import { createInitialModelState } from '../engine/learningModel';
import { db, handleFirestoreError, OperationType } from './firebase';

const MODEL_DOC_ID = 'primary';

export async function ensureUserProfile(
  user: User,
  minEvThreshold: number
): Promise<void> {
  const path = `users/${user.uid}`;
  try {
    const ref = doc(db, 'users', user.uid);
    const snap = await getDoc(ref);
    const displayName = (user.displayName || user.email || 'Quant Analyst').slice(0, 120);
    const safeThreshold = clamp(Number(minEvThreshold) || 3, 0, 50);

    if (!snap.exists()) {
      await setDoc(ref, {
        ownerId: user.uid,
        displayName,
        minEvThreshold: safeThreshold,
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(
        ref,
        {
          ownerId: user.uid,
          displayName,
          minEvThreshold: safeThreshold,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function loadUserMinEvThreshold(uid: string): Promise<number | null> {
  const path = `users/${uid}`;
  try {
    const snap = await getDoc(doc(db, 'users', uid));
    if (!snap.exists()) return null;
    const val = Number(snap.data()?.minEvThreshold);
    return Number.isFinite(val) ? clamp(val, 0, 50) : null;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }
}

export async function loadModelIntelligenceFromFirestore(
  uid: string
): Promise<ModelIntelligencePayload | null> {
  const modelPath = `users/${uid}/modelState/${MODEL_DOC_ID}`;
  try {
    const modelSnap = await getDoc(doc(db, 'users', uid, 'modelState', MODEL_DOC_ID));
    if (!modelSnap.exists()) {
      return null;
    }

    const mData = modelSnap.data();
    const base = createInitialModelState();

    const teamPath = `users/${uid}/teamIntelligence`;
    let teamSnap;
    try {
      teamSnap = await getDocs(
        query(
          collection(db, 'users', uid, 'teamIntelligence'),
          where('ownerId', '==', uid),
          limit(200)
        )
      );
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, teamPath);
    }

    const matrices: Record<string, TeamLearnedCoefficients> = {};
    teamSnap.forEach((d) => {
      const td = d.data();
      matrices[d.id] = {
        sample_size_matches: Number(td.sample_size_matches) || 0,
        learned_coefficients: {
          home_advantage_multiplier: Number(td.home_advantage_multiplier) || 1.08,
          form_momentum_weight: Number(td.form_momentum_weight) || 1.0,
          volatility_index: Number(td.volatility_index) || 1.0,
          fatigue_penalty_modifier: Number(td.fatigue_penalty_modifier) || 1.0,
        },
      };
    });

    const auditPath = `users/${uid}/auditLogs`;
    let auditSnap;
    try {
      auditSnap = await getDocs(
        query(
          collection(db, 'users', uid, 'auditLogs'),
          where('ownerId', '==', uid),
          limit(150)
        )
      );
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, auditPath);
    }

    const recentAudits: AuditLogEntry[] = [];
    auditSnap.forEach((d) => {
      const ad = d.data();
      recentAudits.push({
        id: d.id,
        matchId: String(ad.matchId || ''),
        league: String(ad.league || ''),
        homeTeam: String(ad.homeTeam || ''),
        awayTeam: String(ad.awayTeam || ''),
        finalScore: String(ad.finalScore || '0-0'),
        snapshotMinute: Number(ad.snapshotMinute) || 65,
        snapshotSource:
          ad.snapshotSource === 'exact_live_capture' || ad.snapshotSource === 'causal_reconstruction'
            ? ad.snapshotSource
            : 'causal_reconstruction',
        market: String(ad.market || 'Match Winner (1X2)'),
        selection: String(ad.selection || ''),
        modelProbability: Number(ad.modelProbability) || 0,
        impliedProbability:
          ad.impliedProbability !== undefined ? Number(ad.impliedProbability) : undefined,
        evPct: ad.evPct !== undefined ? Number(ad.evPct) : undefined,
        actualOutcome: String(ad.actualOutcome || ''),
        isCorrect: Boolean(ad.isCorrect),
        brierScore: Number(ad.brierScore) || 0,
        createdAt: ad.createdAt?.toDate ? ad.createdAt.toDate().toISOString() : new Date().toISOString(),
      });
    });

    recentAudits.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const totalEvaluated = Math.max(0, Math.round(Number(mData.totalEvaluated) || 0));
    const correctPredictions = Math.max(
      0,
      Math.min(totalEvaluated, Math.round(Number(mData.correctPredictions) || 0))
    );
    const cumulativeBrier = Math.max(0, Number(mData.cumulativeBrier) || 0);
    const cumulativeLogLoss = Math.max(0, Number(mData.cumulativeLogLoss) || 0);

    return {
      sync_timestamp: String(mData.sync_timestamp || base.sync_timestamp),
      model_engine: String(mData.model_engine || base.model_engine),
      meta_improvement_notes: String(mData.meta_improvement_notes || base.meta_improvement_notes),
      globalWeights: {
        momentumSensitivity: clamp(Number(mData.momentumSensitivity) || 0.42, 0.05, 2.5),
        shotOnTargetWeight: clamp(Number(mData.shotOnTargetWeight) || 0.95, 0.01, 2.0),
        possessionWeight: clamp(Number(mData.possessionWeight) || 0.45, 0, 2.0),
        cornerPressureWeight: clamp(Number(mData.cornerPressureWeight) || 0.65, 0, 2.0),
        baseTempoBias: clamp(Number(mData.baseTempoBias) || 0, -1, 1),
        homeAdvantageBase: clamp(Number(mData.homeAdvantageBase) || 1.08, 0.75, 1.5),
      },
      metrics: {
        totalEvaluated,
        correctPredictions,
        cumulativeBrier,
        cumulativeLogLoss,
        meanBrierScore:
          totalEvaluated > 0 ? Number((cumulativeBrier / totalEvaluated).toFixed(4)) : null,
        meanLogLoss:
          totalEvaluated > 0 ? Number((cumulativeLogLoss / totalEvaluated).toFixed(4)) : null,
        accuracyPct:
          totalEvaluated > 0
            ? Number(((correctPredictions / totalEvaluated) * 100).toFixed(1))
            : null,
      },
      team_intelligence_matrices: matrices,
      recentAudits: recentAudits.slice(0, 60),
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, modelPath);
  }
}

export async function saveCalibrationToFirestore(
  user: User,
  modelState: ModelIntelligencePayload,
  newAudits: AuditLogEntry[],
  teamDisplayNames: Record<string, string>
): Promise<void> {
  const uid = user.uid;
  const modelPath = `users/${uid}/modelState/${MODEL_DOC_ID}`;

  try {
    const batch = writeBatch(db);
    const totalEval = Math.max(0, Math.round(modelState.metrics.totalEvaluated));
    const correctPred = Math.max(
      0,
      Math.min(totalEval, Math.round(modelState.metrics.correctPredictions))
    );

    batch.set(doc(db, 'users', uid, 'modelState', MODEL_DOC_ID), {
      ownerId: uid,
      sync_timestamp: modelState.sync_timestamp.slice(0, 64),
      model_engine: modelState.model_engine.slice(0, 120),
      meta_improvement_notes: modelState.meta_improvement_notes.slice(0, 1000),
      momentumSensitivity: clamp(modelState.globalWeights.momentumSensitivity, 0.05, 2.5),
      shotOnTargetWeight: clamp(modelState.globalWeights.shotOnTargetWeight, 0.01, 2.0),
      possessionWeight: clamp(modelState.globalWeights.possessionWeight, 0, 2.0),
      cornerPressureWeight: clamp(modelState.globalWeights.cornerPressureWeight, 0, 2.0),
      baseTempoBias: clamp(modelState.globalWeights.baseTempoBias, -1, 1),
      homeAdvantageBase: clamp(modelState.globalWeights.homeAdvantageBase, 0.75, 1.5),
      totalEvaluated: totalEval,
      correctPredictions: correctPred,
      cumulativeBrier: Math.max(0, modelState.metrics.cumulativeBrier),
      cumulativeLogLoss: Math.max(0, modelState.metrics.cumulativeLogLoss),
      updatedAt: serverTimestamp(),
    });

    // Persist updated team matrices (bounded batch size <= 450 ops)
    const teamEntries = Object.entries(modelState.team_intelligence_matrices).slice(0, 120);
    for (const [rawKey, mat] of teamEntries) {
      const teamKey = slugifyTeamKey(rawKey);
      const tName = (teamDisplayNames[teamKey] || teamKey.replace(/_/g, ' ')).slice(0, 120);
      batch.set(doc(db, 'users', uid, 'teamIntelligence', teamKey), {
        ownerId: uid,
        teamKey,
        teamName: tName,
        sample_size_matches: Math.max(0, Math.round(mat.sample_size_matches)),
        home_advantage_multiplier: clamp(mat.learned_coefficients.home_advantage_multiplier, 0.5, 2.0),
        form_momentum_weight: clamp(mat.learned_coefficients.form_momentum_weight, 0.1, 3.0),
        volatility_index: clamp(mat.learned_coefficients.volatility_index, 0.3, 3.0),
        fatigue_penalty_modifier: clamp(mat.learned_coefficients.fatigue_penalty_modifier, 0.4, 2.5),
        updatedAt: serverTimestamp(),
      });
    }

    for (const audit of newAudits.slice(0, 60)) {
      const logId = audit.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
      const matchId = audit.matchId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
      const payload: Record<string, unknown> = {
        ownerId: uid,
        matchId,
        league: audit.league.slice(0, 120),
        homeTeam: audit.homeTeam.slice(0, 120),
        awayTeam: audit.awayTeam.slice(0, 120),
        finalScore: audit.finalScore.slice(0, 20),
        snapshotMinute: clamp(Math.round(audit.snapshotMinute), 1, 120),
        market: audit.market.slice(0, 80),
        selection: audit.selection.slice(0, 80),
        modelProbability: clamp(audit.modelProbability, 0, 1),
        actualOutcome: audit.actualOutcome.slice(0, 40),
        isCorrect: Boolean(audit.isCorrect),
        brierScore: clamp(audit.brierScore, 0, 2),
        createdAt: serverTimestamp(),
      };
      if (audit.snapshotSource) {
        payload.snapshotSource = audit.snapshotSource;
      }
      if (audit.impliedProbability !== undefined) {
        payload.impliedProbability = clamp(audit.impliedProbability, 0, 1);
      }
      if (audit.evPct !== undefined) {
        payload.evPct = clamp(audit.evPct, -100, 1000);
      }
      batch.set(doc(db, 'users', uid, 'auditLogs', logId), payload);
    }

    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, modelPath);
  }
}

export async function saveTrendAlertToFirestore(
  user: User,
  trend: { id: string; matchId: string; teamName: string; patternLabel: string; minute: number },
  brief: { bestMarketPick: string; tacticalVerdict: string; dangerQualitySummary: string }
): Promise<void> {
  const uid = user.uid;
  const alertId = `${trend.matchId}_${trend.minute}_${trend.teamName}`
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 120);
  const path = `users/${uid}/trendAlerts/${alertId}`;

  try {
    await setDoc(doc(db, 'users', uid, 'trendAlerts', alertId), {
      ownerId: uid,
      matchId: trend.matchId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64),
      teamName: trend.teamName.slice(0, 120),
      patternLabel: trend.patternLabel.slice(0, 160),
      bestMarketPick: brief.bestMarketPick.slice(0, 160),
      tacticalVerdict: brief.tacticalVerdict.slice(0, 80),
      dangerQualitySummary: brief.dangerQualitySummary.slice(0, 600),
      minute: clamp(Math.round(trend.minute), 0, 120),
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function loadTrendAlertsFromFirestore(
  uid: string
): Promise<
  {
    id: string;
    matchId: string;
    teamName: string;
    patternLabel: string;
    bestMarketPick: string;
    tacticalVerdict: string;
    dangerQualitySummary: string;
    minute: number;
    createdAt: string;
  }[]
> {
  const path = `users/${uid}/trendAlerts`;
  try {
    const snap = await getDocs(
      query(
        collection(db, 'users', uid, 'trendAlerts'),
        where('ownerId', '==', uid),
        limit(100)
      )
    );
    const rows: {
      id: string;
      matchId: string;
      teamName: string;
      patternLabel: string;
      bestMarketPick: string;
      tacticalVerdict: string;
      dangerQualitySummary: string;
      minute: number;
      createdAt: string;
    }[] = [];
    snap.forEach((d) => {
      const td = d.data();
      rows.push({
        id: d.id,
        matchId: String(td.matchId || ''),
        teamName: String(td.teamName || ''),
        patternLabel: String(td.patternLabel || ''),
        bestMarketPick: String(td.bestMarketPick || ''),
        tacticalVerdict: String(td.tacticalVerdict || ''),
        dangerQualitySummary: String(td.dangerQualitySummary || ''),
        minute: Number(td.minute) || 0,
        createdAt: td.createdAt?.toDate ? td.createdAt.toDate().toISOString() : '',
      });
    });
    rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return rows.slice(0, 40);
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
  }
}

export async function savePaperBetsToFirestore(
  user: User,
  bets: PaperBetRecord[]
): Promise<void> {
  if (bets.length === 0) return;
  const uid = user.uid;
  const path = `users/${uid}/paperBets`;
  try {
    const batch = writeBatch(db);
    for (const bet of bets.slice(0, 60)) {
      const betId = bet.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
      const matchId = bet.matchId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
      const docData: Record<string, unknown> = {
        ownerId: uid,
        matchId,
        league: (bet.league || 'Global League').slice(0, 120),
        matchTitle: (bet.matchTitle || `${bet.homeTeam} vs ${bet.awayTeam}`).slice(0, 200),
        homeTeam: (bet.homeTeam || 'Home').slice(0, 120),
        awayTeam: (bet.awayTeam || 'Away').slice(0, 120),
        minutePlaced: clamp(Math.round(bet.minutePlaced), 0, 120),
        scoreAtPlacement: (bet.scoreAtPlacement && bet.scoreAtPlacement.length >= 3 ? bet.scoreAtPlacement : '0-0').slice(0, 20),
        market: bet.market.slice(0, 80),
        selection: (bet.selection || 'Selection').slice(0, 120),
        confidenceTier: bet.confidenceTier,
        modelProbability: clamp(bet.modelProbability, 0, 1),
        bookmakerOddsDecimal: clamp(bet.bookmakerOddsDecimal, 1.01, 500),
        bookmakerOddsAmerican: (bet.bookmakerOddsAmerican || 'EVEN').slice(0, 20),
        evPct: clamp(bet.evPct, -100, 2000),
        stakeUnits: clamp(bet.stakeUnits, 0.01, 25),
        oddsVerifiedLive: Boolean(bet.oddsVerifiedLive),
        status: bet.status,
        profitUnits: clamp(bet.profitUnits, -50, 5000),
        placedAt: (bet.placedAt && bet.placedAt.length >= 10 ? bet.placedAt : new Date().toISOString()).slice(0, 64),
        updatedAt: serverTimestamp(),
      };
      if (bet.finalScore && bet.finalScore.length >= 3) {
        docData.finalScore = bet.finalScore.slice(0, 20);
      }
      if (bet.settledAt && bet.settledAt.length >= 10) {
        docData.settledAt = bet.settledAt.slice(0, 64);
      }
      batch.set(doc(db, 'users', uid, 'paperBets', betId), docData, { merge: true });
    }
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function loadPaperBetsFromFirestore(uid: string): Promise<PaperBetRecord[]> {
  const path = `users/${uid}/paperBets`;
  try {
    const snap = await getDocs(
      query(
        collection(db, 'users', uid, 'paperBets'),
        where('ownerId', '==', uid),
        limit(250)
      )
    );
    const rows: PaperBetRecord[] = [];
    snap.forEach((d) => {
      const pd = d.data();
      rows.push({
        id: d.id,
        matchId: String(pd.matchId || ''),
        league: String(pd.league || ''),
        matchTitle: String(pd.matchTitle || ''),
        homeTeam: String(pd.homeTeam || ''),
        awayTeam: String(pd.awayTeam || ''),
        minutePlaced: Number(pd.minutePlaced) || 0,
        scoreAtPlacement: String(pd.scoreAtPlacement || '0-0'),
        market: (pd.market || 'Match Winner (1X2)') as PaperBetRecord['market'],
        selection: String(pd.selection || ''),
        confidenceTier: (pd.confidenceTier || 'Moderate Edge') as PaperBetRecord['confidenceTier'],
        modelProbability: Number(pd.modelProbability) || 0,
        bookmakerOddsDecimal: Number(pd.bookmakerOddsDecimal) || 1.5,
        bookmakerOddsAmerican: String(pd.bookmakerOddsAmerican || ''),
        evPct: Number(pd.evPct) || 0,
        stakeUnits: Number(pd.stakeUnits) || 1,
        oddsVerifiedLive: Boolean(pd.oddsVerifiedLive),
        status: (pd.status || 'open') as PaperBetRecord['status'],
        finalScore: pd.finalScore ? String(pd.finalScore) : null,
        profitUnits: Number(pd.profitUnits) || 0,
        placedAt: String(pd.placedAt || new Date().toISOString()),
        settledAt: pd.settledAt ? String(pd.settledAt) : null,
      });
    });
    rows.sort((a, b) => (b.settledAt || b.placedAt).localeCompare(a.settledAt || a.placedAt));
    return rows.slice(0, 120);
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
  }
}

export async function saveLiveSnapshotsToFirestore(
  user: User,
  snapshots: LiveCapturedSnapshot[]
): Promise<void> {
  if (snapshots.length === 0) return;
  const uid = user.uid;
  const path = `users/${uid}/liveSnapshots`;
  try {
    const batch = writeBatch(db);
    for (const item of snapshots.slice(0, 40)) {
      const snapId = item.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
      const matchId = item.matchId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
      const compactSnap: OddsFreeMatchSnapshot = {
        ...item.snapshot,
        events: item.snapshot.events.slice(-45),
      };
      const serialized = JSON.stringify(compactSnap);
      if (serialized.length > 32000) continue;

      batch.set(doc(db, 'users', uid, 'liveSnapshots', snapId), {
        ownerId: uid,
        matchId,
        milestoneMinute: item.milestoneMinute,
        capturedMinute: clamp(Math.round(item.capturedMinute), 1, 120),
        netMomentum: clamp(item.netMomentum, -200, 200),
        snapshotJson: serialized,
        capturedAt: serverTimestamp(),
      });
    }
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function loadLiveSnapshotsFromFirestore(
  uid: string
): Promise<LiveCapturedSnapshot[]> {
  const path = `users/${uid}/liveSnapshots`;
  try {
    const snap = await getDocs(
      query(
        collection(db, 'users', uid, 'liveSnapshots'),
        where('ownerId', '==', uid),
        limit(200)
      )
    );
    const rows: LiveCapturedSnapshot[] = [];
    snap.forEach((d) => {
      const sd = d.data();
      try {
        const parsedSnap = JSON.parse(String(sd.snapshotJson || '{}')) as OddsFreeMatchSnapshot;
        if (!parsedSnap.id) return;
        rows.push({
          id: d.id,
          matchId: String(sd.matchId || ''),
          milestoneMinute: (Number(sd.milestoneMinute) || 60) as LiveCapturedSnapshot['milestoneMinute'],
          capturedMinute: Number(sd.capturedMinute) || 60,
          netMomentum: Number(sd.netMomentum) || 0,
          snapshot: parsedSnap,
          capturedAt: sd.capturedAt?.toDate ? sd.capturedAt.toDate().toISOString() : '',
        });
      } catch {
        // Ignore malformed snapshot JSON
      }
    });
    rows.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
    return rows.slice(0, 120);
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
  }
}

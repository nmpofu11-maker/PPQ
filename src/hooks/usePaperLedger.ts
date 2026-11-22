import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import type { PaperBetRecord, ScrapedMatch, ValueAlert } from '../types/soccer';
import { computePaperLedgerSummary, recordNewPaperBets, settlePaperBets } from '../engine/paperLedger';
import { loadPaperBetsFromFirestore, savePaperBetsToFirestore } from '../services/persistence';
import { loadStoredJson, removeStored, saveStoredJson } from '../lib/storage';

const KEY = 'pitchpulse_paper_bets';

export function usePaperLedger(params: {
  user: User | null;
  userRef: React.MutableRefObject<User | null>;
  profileReady: boolean;
  matches: ScrapedMatch[];
  allAlerts: ValueAlert[];
}) {
  const { user, userRef, profileReady, matches, allAlerts } = params;
  const [paperBets, setPaperBets] = useState<PaperBetRecord[]>(() => loadStoredJson<PaperBetRecord[]>(KEY, []));
  const paperBetsRef = useRef(paperBets);
  paperBetsRef.current = paperBets;

  useEffect(() => {
    if (!user || !profileReady) return;
    let active = true;
    loadPaperBetsFromFirestore(user.uid)
      .catch(() => [] as PaperBetRecord[])
      .then((loaded) => {
        if (!active || loaded.length === 0) return;
        setPaperBets((prev) => {
          const merged = new Map<string, PaperBetRecord>();
          for (const b of prev) merged.set(b.id, b);
          for (const b of loaded) merged.set(b.id, b);
          return Array.from(merged.values()).slice(0, 250);
        });
      });
    return () => {
      active = false;
    };
  }, [user, profileReady]);

  // Automatically log qualified +EV edges (verified-live odds only) into the ledger
  useEffect(() => {
    if (matches.length === 0 || allAlerts.length === 0) return;
    const rec = recordNewPaperBets({
      existingBets: paperBetsRef.current,
      alerts: allAlerts,
      matchesById: new Map(matches.map((m) => [m.id, m])),
    });
    if (rec.addedBets.length > 0) {
      setPaperBets(rec.nextBets);
      saveStoredJson(KEY, rec.nextBets);
      if (userRef.current) savePaperBetsToFirestore(userRef.current, rec.addedBets).catch(() => {});
    }
  }, [matches, allAlerts, userRef]);

  /** Settle open bets against newly finished matches from the latest scrape. */
  const settleFinished = useCallback(
    (scraped: ScrapedMatch[]) => {
      const allFinished = scraped.filter((m) => m.state === 'post');
      if (allFinished.length === 0 || !paperBetsRef.current.some((b) => b.status === 'open')) return;
      const settled = settlePaperBets({ bets: paperBetsRef.current, finishedMatches: allFinished });
      if (settled.settledBets.length > 0) {
        setPaperBets(settled.nextBets);
        saveStoredJson(KEY, settled.nextBets);
        if (userRef.current) savePaperBetsToFirestore(userRef.current, settled.settledBets).catch(() => {});
      }
    },
    [userRef]
  );

  const reset = useCallback(() => {
    setPaperBets([]);
    removeStored(KEY);
  }, []);

  const summary = useMemo(() => computePaperLedgerSummary(paperBets), [paperBets]);

  return { paperBets, summary, settleFinished, reset };
}

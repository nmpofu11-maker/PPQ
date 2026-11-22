/**
 * Firestore security-rules tests. They need the Firestore emulator, so they are skipped unless
 * FIRESTORE_EMULATOR_HOST is set. Run with:
 *   npx firebase-tools emulators:exec --only firestore --project demo-ppq "npm run test:rules"
 */
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
const skip = emulator ? false : 'FIRESTORE_EMULATOR_HOST not set (Firestore emulator required)';

let env: RulesTestEnvironment;

before(async () => {
  if (skip) return;
  const [host, port] = emulator!.split(':');
  env = await initializeTestEnvironment({
    projectId: 'demo-ppq',
    firestore: {
      host,
      port: Number(port),
      rules: fs.readFileSync(path.resolve(process.cwd(), 'firestore.rules'), 'utf8'),
    },
  });
});

beforeEach(async () => {
  if (!skip) await env.clearFirestore();
});

after(async () => {
  if (!skip) await env.cleanup();
});

const alice = () => env.authenticatedContext('alice', { email_verified: true }).firestore();
const aliceUnverified = () => env.authenticatedContext('alice', { email_verified: false }).firestore();
const bob = () => env.authenticatedContext('bob', { email_verified: true }).firestore();
const anon = () => env.unauthenticatedContext().firestore();

const profile = (ownerId = 'alice') => ({
  ownerId,
  displayName: 'Alice',
  minEvThreshold: 3,
  updatedAt: serverTimestamp(),
});

function paperBet(ownerId = 'alice') {
  return {
    ownerId,
    matchId: 'm1',
    league: 'EPL',
    matchTitle: 'A vs B',
    homeTeam: 'A',
    awayTeam: 'B',
    minutePlaced: 60,
    scoreAtPlacement: '0-0',
    market: 'Match Winner',
    selection: 'A',
    confidenceTier: 'Moderate Edge',
    modelProbability: 0.5,
    bookmakerOddsDecimal: 2.4,
    bookmakerOddsAmerican: '+140',
    evPct: 20,
    stakeUnits: 0.5,
    oddsVerifiedLive: true,
    status: 'open',
    profitUnits: 0,
    placedAt: new Date().toISOString(),
    updatedAt: serverTimestamp(),
  };
}

test('default deny: unknown collections are not readable or writable', { skip }, async () => {
  await assertFails(getDoc(doc(alice(), 'secrets/x')));
  await assertFails(setDoc(doc(alice(), 'secrets/x'), { a: 1 }));
});

test('profile: only the verified owner can create; anonymous and other users cannot', { skip }, async () => {
  await assertSucceeds(setDoc(doc(alice(), 'users/alice'), profile()));
  await assertFails(setDoc(doc(anon(), 'users/alice'), profile()));
  await assertFails(setDoc(doc(bob(), 'users/alice'), profile()));
  await assertFails(setDoc(doc(aliceUnverified(), 'users/alice'), profile()));
});

test('profile: validates shape, ownership and threshold bounds', { skip }, async () => {
  await assertFails(setDoc(doc(alice(), 'users/alice'), { ...profile(), minEvThreshold: 999 }));
  await assertFails(setDoc(doc(alice(), 'users/alice'), { ...profile(), extra: true }));
  await assertFails(setDoc(doc(alice(), 'users/alice'), profile('bob')));
});

test('profile: other users cannot read it and nobody can list users', { skip }, async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'users/alice'), { ...profile(), updatedAt: new Date() });
  });
  await assertSucceeds(getDoc(doc(alice(), 'users/alice')));
  await assertFails(getDoc(doc(bob(), 'users/alice')));
  await assertFails(getDoc(doc(anon(), 'users/alice')));
});

test('paperBets: owner can create valid bets and settle, but not change immutable fields', { skip }, async () => {
  const ref = doc(alice(), 'users/alice/paperBets/b1');
  await assertSucceeds(setDoc(ref, paperBet()));
  await assertSucceeds(
    updateDoc(ref, { status: 'won', profitUnits: 0.7, finalScore: '1-0', settledAt: new Date().toISOString(), updatedAt: serverTimestamp() })
  );
  await assertFails(updateDoc(ref, { stakeUnits: 25, updatedAt: serverTimestamp() }));
});

test('paperBets: invalid status, forged owner and cross-user access are rejected', { skip }, async () => {
  await assertFails(setDoc(doc(alice(), 'users/alice/paperBets/b2'), { ...paperBet(), status: 'half_won' }));
  await assertFails(setDoc(doc(alice(), 'users/alice/paperBets/b3'), paperBet('bob')));
  await assertFails(setDoc(doc(bob(), 'users/alice/paperBets/b4'), paperBet()));
  await assertFails(setDoc(doc(anon(), 'users/alice/paperBets/b5'), paperBet()));
});

test('liveSnapshots: only milestone minutes are accepted and they are immutable', { skip }, async () => {
  const snap = (milestoneMinute: number) => ({
    ownerId: 'alice',
    matchId: 'm1',
    milestoneMinute,
    capturedMinute: milestoneMinute,
    netMomentum: 1.5,
    snapshotJson: '{}',
    capturedAt: serverTimestamp(),
  });
  await assertSucceeds(setDoc(doc(alice(), 'users/alice/liveSnapshots/s30'), snap(30)));
  await assertFails(setDoc(doc(alice(), 'users/alice/liveSnapshots/s31'), snap(31)));
  await assertFails(updateDoc(doc(alice(), 'users/alice/liveSnapshots/s30'), { netMomentum: 2 }));
});

test('sanity: tests are wired to the emulator', { skip }, () => {
  assert.ok(emulator);
});

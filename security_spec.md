# Security Specification & Data Invariants

## 1. Data Invariants
1. Every document under `/users/{userId}` and its subcollections (`modelState`, `teamIntelligence`, `auditLogs`, `trendAlerts`, `paperBets`, `liveSnapshots`) is strictly owned by `userId` (`request.auth.uid == userId && data.ownerId == request.auth.uid`).
2. All writes require `request.auth != null && request.auth.token.email_verified == true`.
3. Path variables (`userId`, `stateId`, `teamId`, `logId`, `alertId`, `betId`, `snapshotId`) must match `^[a-zA-Z0-9_\-]+$` and be `<= 128` characters.
4. All fields are strictly allowlisted via `keys().hasAll(...) && keys().hasOnly(...)` on `create` and `affectedKeys().hasOnly(...)` on `update` to block shadow fields.
5. Numeric coefficients (`home_advantage_multiplier`, `form_momentum_weight`, `volatility_index`, `fatigue_penalty_modifier`, probabilities, Brier score, paper-bet stakes/odds) are bounded to mathematically valid ranges.
6. `auditLogs`, `trendAlerts`, and `liveSnapshots` are append-only historical evidence records (`allow update: if false;` once created, owner may only delete or read); `paperBets` updates may mutate settlement fields (`status`, `finalScore`, `profitUnits`, `settledAt`, `updatedAt`) only.
7. Server-validated timestamps (`request.time`) are enforced on `updatedAt` / `createdAt` / `capturedAt`.

## 2. Adversarial "Dirty Dozen" Payloads (Expected: PERMISSION_DENIED)
1. Unauthenticated read/write to `/users/uid1/modelState/primary`.
2. Authenticated user `uid2` reading `/users/uid1/modelState/primary`.
3. Authenticated user `uid1` with `email_verified == false` writing to `/users/uid1`.
4. Identity spoofing: `uid1` creating `/users/uid1/teamIntelligence/arsenal` with `ownerId: "uid2"`.
5. Shadow field injection: `uid1` creating `/users/uid1` with extra `isAdmin: true` field.
6. ID poisoning: `uid1` writing to `/users/uid1/teamIntelligence/` with a 500-char invalid ID containing slashes/spaces.
7. Resource exhaustion: `uid1` writing `meta_improvement_notes` with 5,000 characters (`> 1000`).
8. Out-of-range weight poisoning: `uid1` setting `home_advantage_multiplier: 999` or `modelProbability: 1.5`.
9. Immutable owner mutation: `uid1` attempting to change `ownerId` during `update` on `modelState`.
10. Timestamp spoofing: `uid1` passing a forged past/future timestamp not equal to `request.time`.
11. Audit log tampering: `uid1` attempting to `update` an existing `auditLogs` record to falsify `isCorrect: true`.
12. Blanket list query by another user: `uid2` querying `/users/uid1/auditLogs`.

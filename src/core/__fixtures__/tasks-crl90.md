# CRL-90 — Tasks

- [ ] T1 — Add `'reviewing'` to the `IssuePhase` union and to `RESUMABLE_PHASES` in `corral/src/core/types.ts`, leaving `WAITING_PHASES` unchanged (REQ-1, REQ-5, REQ-6, REQ-7)
- [ ] T2 — Persist `phase = 'reviewing'` and clear `stuck` at the top of each `selfReviewLoop` round in `corral/src/orchestrator.ts`, before the existing phase event and before `review.run` (REQ-1, REQ-4, REQ-5) [after: T1]
- [ ] T3 — Wire retry semantics in `corral/src/orchestrator.ts`: add `'reviewing'` to `RETRYABLE_PHASES` and add a `redispatchPhase` case routing it to `presentReview` (REQ-6, REQ-7, REQ-9) [after: T1]
- [ ] T4 — Add `describe('reviewing')` cross-check assertions to `corral/src/core/phase-classification.test.ts`: core sets (not waiting, resumable) and renderer sets (not idle, not waiting, a `stageIndex` case) (REQ-2, REQ-6) [after: T1]
- [ ] T5 — Add persistence tests to `corral/src/core/issue-state.test.ts`: an old-format `issues.json` without the new phase loads and round-trips, and a runtime with `phase: 'reviewing'` persists and reloads intact (REQ-7, REQ-8) [after: T1]

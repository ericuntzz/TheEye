# Atria V1 Acceptance Scorecard

Last updated: 2026-03-08
Owner: Product + Engineering
Current release posture: `Partial` (not release-ready)

## Purpose
This scorecard defines the release-level acceptance criteria for Atria V1 based on:
1. Atria Product Principles
2. Atria UX Interaction Guide
3. Atria V1 Implementation Specification

Rule: V1 is only "Done" when all P0 criteria are Pass and no P0/P1 release blockers are open.

## Status Values
- `Pass`: Verified in production-like environment with evidence.
- `Partial`: Some behavior exists but is incomplete or not validated.
- `Fail`: Missing, broken, or contradicted by behavior.
- `N/A`: Not in V1 scope (must include rationale).

## Current Snapshot
- Overall: `Partial`
- P0 blockers open: `2` (`P0-03`, `P0-08`)
- Verified checks on 2026-03-08:
  - `npm run build`: pass
  - `npx tsc --noEmit` (web): pass
  - `npx tsc --noEmit` (mobile): pass
  - `test-api.sh`: 22/23 (1 fail)
  - `test-stress.sh`: 44/44

## Evidence Types
- Test run output (integration/stress)
- Manual walkthrough video or screenshots
- API request/response logs
- Database query evidence
- Incident-free soak result

## P0 Criteria (Must Pass)

| ID | Requirement | Evidence Required | Status | Evidence Link/Notes |
|---|---|---|---|---|
| P0-01 | Auth boundaries enforced on protected APIs | Unauthorized requests return 401; authorized return 2xx/4xx as expected | Pass | Verified in integration + stress runs (2026-03-08) |
| P0-02 | Inspection flow end-to-end works | Start inspection, scan/capture, findings, submit, summary | Partial | Mobile wiring exists; full human walkthrough evidence still required |
| P0-03 | Invalid IDs do not cause 500 | Non-UUID/fake IDs return controlled 4xx responses | Fail | `/api/inspections` still allows invalid `propertyId` to reach DB UUID cast path |
| P0-04 | Vision compare endpoints stable | `/api/vision/compare` and `/api/vision/compare-stream` return valid schema and error handling | Partial | Error paths verified; sustained load/real-capture validation pending |
| P0-05 | Event log writes for key actions | Inspection/condition/baseline actions emit expected events | Partial | Event schema/emitter present; complete event coverage audit still pending |
| P0-06 | Property training works from mobile | Capture -> upload -> train -> rooms/baselines available | Partial | `PropertyTraining` implemented; needs recorded end-to-end proof on device |
| P0-07 | Build and type safety clean | `npm run build`, web `tsc`, mobile `tsc` pass | Pass | Verified 2026-03-08 |
| P0-08 | Release gate test suites pass | Integration + stress suite pass on fresh server state | Fail | Stress passes (44/44), integration not fully green (22/23) |

## Product Principles Alignment

| ID | Principle Requirement | Validation Method | Status | Evidence Link/Notes |
|---|---|---|---|---|
| PR-01 | AI does most reasoning/preparation; user approves | Walkthrough of inspection and findings confirmation flow | Partial | Flow exists in code; live operator validation pending |
| PR-02 | UI avoids clutter during inspection | Mobile camera HUD review against UX guide | Partial | HUD appears minimal; UX sign-off pending |
| PR-03 | Information hierarchy supports safety/financial/maintenance/cosmetic triage | Findings severity/category checks in summary and API payloads | Partial | Severity/category models exist; hierarchy behavior needs scenario testing |
| PR-04 | Workflow minimizes cognitive load | Time-to-complete and number-of-taps observation | Partial | No timing/usability benchmark captured yet |

## UX Guide Alignment

| ID | UX Requirement | Validation Method | Status | Evidence Link/Notes |
|---|---|---|---|---|
| UX-01 | Full-screen camera feed with minimal overlays | Mobile screen recording | Partial | Camera screen implemented; recording evidence pending |
| UX-02 | Room + angle coverage visible | Live walkthrough with changing room/coverage data | Partial | Coverage UI implemented; field proof pending |
| UX-03 | Findings surfaced only when important | Manual test with low/no findings and high severity findings | Partial | Logic exists; behavior benchmark not yet documented |
| UX-04 | Inspector can confirm or dismiss findings quickly | Usability walk with confirmation flows | Partial | Confirm/dismiss/mute actions implemented; usability run pending |
| UX-05 | Inspection modes available (turnover, maintenance, owner arrival, vacancy check) | API + mobile mode selection verification | Pass | Modes exposed in mobile and validated in stress suite requests |

## V1 Spec Feature Alignment

| ID | V1 Feature | Validation Method | Status | Evidence Link/Notes |
|---|---|---|---|---|
| V1-01 | AI-assisted inspections | Run completed inspection and verify room results | Partial | Core APIs + mobile camera integration present; full acceptance run pending |
| V1-02 | Automatic damage attribution foundation | Event + finding metadata includes claimability/guest damage flags | Partial | Claimability fields present; attribution pipeline not fully proven |
| V1-03 | Maintenance ticket generation pathway | Verify finding-to-ticket event path (or documented V1 limitation) | Fail | Ticket creation path not validated as operational in current run |
| V1-04 | Inspection coverage scoring | Coverage per room and overall coverage in summary | Partial | Session/summary coverage logic implemented; full E2E verification pending |
| V1-05 | Property assurance ledger foundation | Immutable events table captures system timeline | Partial | Events table exists with emit utility; end-to-end event completeness pending |
| V1-06 | Portfolio dashboard baseline metrics | Dashboard shows property and inspection operational metrics | Partial | Basic metrics present; health-score maturity still limited |

## Exit Criteria
1. All P0 rows are `Pass`.
2. No open P0/P1 defects in active branch.
3. Release gate checklist is fully green.
4. Ops runbook is active in Slack channels.

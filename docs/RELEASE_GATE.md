# Atria Release Gate

Last updated: 2026-03-08
Owner: Engineering Lead (Gatekeeper) + Operator (`#atria-command`)

## Rule
No merge to release branch and no production deploy unless all mandatory checks are green.

## Operational Artifacts
1. Daily command status template: `docs/ATRIA_COMMAND_DAILY_UPDATE_TEMPLATE.md`
2. One-page release decision form: `docs/RELEASE_GO_NO_GO_CHECKLIST.md`

## Gate Levels
- `Blocker`: Must be fixed before release.
- `Warn`: Can release only with explicit approval.
- `Info`: Track but does not block.

## Mandatory Pre-Merge Checks (Blocker)
1. Web build passes.
2. Web typecheck passes.
3. Mobile typecheck passes.
4. Integration test suite passes.
5. Stress test suite passes.
6. No new P0/P1 defects from code review.
7. No endpoint returns unexpected 500 for invalid input paths.

## Mandatory Pre-Deploy Checks (Blocker)
1. Migration plan reviewed (if schema changed).
2. Rollback plan prepared and tested.
3. Environment variables present in target environment.
4. Health endpoint returns 200 after fresh process start.
5. Auth boundary smoke tests pass (401/200 behavior).

## Recommended Commands
Run from repository root:

```bash
npm run build
npx tsc --noEmit
cd mobile && npx tsc --noEmit && cd ..
TOKEN=$(python3 get-token.py)
./test-api.sh "$TOKEN"
bash ./test-stress.sh "$TOKEN"
```

## Known Process Risks
1. Dev server state can become stale/corrupt; always test from a fresh server process.
2. `npm run lint` is currently interactive until ESLint migration is completed.
3. Mobile runtime risk remains until `react-native-worklets` peer dependency is installed.

## Release Decision Template (Post to `#atria-command`)
Use this exact template:

```text
Release Candidate: <branch/commit>
Date: <YYYY-MM-DD>

Gate Results:
- Build: PASS/FAIL
- Web Typecheck: PASS/FAIL
- Mobile Typecheck: PASS/FAIL
- Integration Tests: PASS/FAIL (<x>/<y>)
- Stress Tests: PASS/FAIL (<x>/<y>)
- P0/P1 Defects Open: <count>
- Migration/Rollback Reviewed: YES/NO
- Health/Auth Smoke: PASS/FAIL

Decision: GO / NO-GO
Approval Needed: YES/NO
Requested Approver: <name/role>
```

## Waiver Policy
If any blocker fails, release is `NO-GO` unless explicit waiver is posted in `#atria-command` using:

```text
APPROVED: Release waiver for <specific failed check> at <commit>, accepted risk: <risk>, mitigation: <mitigation>
```

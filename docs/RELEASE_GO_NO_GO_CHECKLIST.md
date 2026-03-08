# Atria Release Go/No-Go Checklist

Last updated: 2026-03-08
Owner: Gatekeeper + `#atria-command`

## Release Candidate
- Branch/Commit: `<fill>`
- Target Environment: `<fill>`
- Date: `<YYYY-MM-DD>`

## Blocker Checks (All must be PASS)
- [ ] Web build passes (`npm run build`)
- [ ] Web typecheck passes (`npx tsc --noEmit`)
- [ ] Mobile typecheck passes (`cd mobile && npx tsc --noEmit`)
- [ ] Integration test suite passes (`./test-api.sh "$TOKEN"`)
- [ ] Stress test suite passes (`bash ./test-stress.sh "$TOKEN"`)
- [ ] No unexpected HTTP 500 for invalid input paths
- [ ] No open P0 defects
- [ ] No open P1 defects without approved waiver

## Deploy Safety Checks (All must be YES)
- [ ] Migration plan reviewed (if schema changed)
- [ ] Rollback plan documented and executable
- [ ] Required environment variables verified in target environment
- [ ] Fresh-process health check returns 200
- [ ] Auth boundary smoke checks pass (401/200 behavior)

## Risk Summary
- Highest technical risk: `<fill>`
- Highest operational risk: `<fill>`
- Customer impact risk: `<fill>`
- Mitigation owner: `<fill>`

## Decision
- Gate decision: `GO` / `NO-GO`
- If `NO-GO`, top blocker: `<fill>`
- If `GO with waiver`, waiver text:

```text
APPROVED: Release waiver for <specific failed check> at <commit>, accepted risk: <risk>, mitigation: <mitigation>
```

## Approvals
- Engineering approver: `<name>`
- Operations approver: `<name>`
- Business approver: `<name>`
- Time approved: `<timestamp>`

## `#atria-command` Posting Block
Copy/paste this final decision summary:

```text
Release Candidate: <branch/commit>
Date: <YYYY-MM-DD>

Gate Results:
- Build: <PASS/FAIL>
- Web Typecheck: <PASS/FAIL>
- Mobile Typecheck: <PASS/FAIL>
- Integration Tests: <PASS/FAIL (x/y)>
- Stress Tests: <PASS/FAIL (x/y)>
- P0/P1 Defects Open: <count>
- Migration/Rollback Reviewed: <YES/NO>
- Health/Auth Smoke: <PASS/FAIL>

Decision: <GO/NO-GO>
Approval Needed: <YES/NO>
Requested Approver: <name/role>
```


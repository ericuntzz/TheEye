# #atria-command Daily Update Template

Last updated: 2026-03-08
Owner: Fin operator in `#atria-command`

## Purpose
Provide a single, executive-style daily brief that keeps build, ops, support, and growth aligned.

## Cadence
1. Morning brief: by 9:00 AM local time.
2. End-of-day brief: by 5:00 PM local time.

## RYG Definitions
- `GREEN`: No P0/P1 blockers; release gate on track.
- `YELLOW`: At least one blocker or risk that may impact timeline.
- `RED`: Active incident, failed release gate blocker, or major business risk.

## Copy/Paste Template
Use this exact block in `#atria-command`:

```text
Daily Command Brief - <YYYY-MM-DD> - <MORNING or EOD>
Overall Status: <GREEN | YELLOW | RED>

Top 3 Priorities:
1) <priority>
2) <priority>
3) <priority>

Top 3 Risks:
1) <risk> | Owner: <channel/person> | Mitigation: <action>
2) <risk> | Owner: <channel/person> | Mitigation: <action>
3) <risk> | Owner: <channel/person> | Mitigation: <action>

By Channel:
- #atria-build: <today progress + next milestone + blockers>
- #atria-ops: <health/incidents + operational risk>
- #atria-support: <ticket volume + SLA + escalations>
- #atria-growth: <experiments/pipeline + KPI movement>

Release Gate Snapshot:
- Build: <PASS/FAIL>
- Web Typecheck: <PASS/FAIL>
- Mobile Typecheck: <PASS/FAIL>
- Integration Tests: <PASS/FAIL (x/y)>
- Stress Tests: <PASS/FAIL (x/y)>
- P0/P1 Open: <count>

Decisions Needed Today:
1) <decision> | Needed by: <time> | Approver: <name/role>
2) <decision> | Needed by: <time> | Approver: <name/role>

Next Check-In:
<time + what will be reported>
```

## Enforcement Rule
If status is `YELLOW` or `RED`, include at least one explicit ask:
- decision request
- approval request
- or escalation route

# Atria — Post-Release Testing Protocol

> Run this protocol after every feature release, refactor, or significant code change.
> Designed for Claude Code to execute systematically. Each phase catches a different class of bug.

---

## Why This Exists

Ad-hoc code reviews miss things. In our initial review passes of this codebase, **each successive pass found new issues** because each one looked through a different lens. This protocol formalizes every lens into a repeatable, ordered checklist.

The order matters. Early phases are fast and catch obvious breaks. Later phases are slower but catch subtle bugs that only surface under specific conditions.

---

## Established Code Standards

These are the concrete patterns every route in this codebase MUST follow. They were established through 4 review passes and represent the "correct" way to write code in Atria. Any new code that deviates from these is a bug.

### Route Template

Every new API route should follow this exact skeleton:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getDbUser, isValidUUID, isSafeUrl } from "@/lib/auth";
import { db } from "@/server/db";
import { emitEventSafe } from "@/lib/events/emit";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {                                          // 1. Outer try/catch
    const { id } = await params;
    if (!isValidUUID(id)) {                      // 2. UUID validation BEFORE auth
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const dbUser = await getDbUser();            // 3. Auth check
    if (!dbUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: Record<string, unknown>;           // 4. Body parsing with own try/catch
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { someField } = body;

    // 5. Input validation (type + value)
    if (typeof someField !== "string" || !someField.trim()) {
      return NextResponse.json({ error: "someField is required" }, { status: 400 });
    }

    // 6. Authorization (ownership check)
    const [resource] = await db.select().from(table)
      .where(and(eq(table.id, id), eq(table.userId, dbUser.id)));
    if (!resource) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // 7. Business logic
    const [result] = await db.insert(table).values({ ... }).returning();

    // 8. Event emission (safe — never blocks response)
    await emitEventSafe({ eventType: "...", aggregateId: id, ... });

    // 9. Response
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    console.error("[route-name] POST error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
```

### Required Validation Functions

| Function | When to Use | Import From |
|---|---|---|
| `isValidUUID(id)` | Every ID from URL params, request body, or query string BEFORE any DB query | `@/lib/auth` |
| `isSafeUrl(url)` | Every URL that will be fetched, stored, or passed to an external service | `@/lib/auth` |
| `emitEventSafe()` | Every event emission (never use raw `emitEvent()` in route handlers) | `@/lib/events/emit` |

### Required Limits

These are the agreed-upon limits. New endpoints that accept arrays or lists MUST enforce equivalent limits.

| Input | Max Size | Where Enforced |
|---|---|---|
| `mediaUploadIds` array | 100 | `train/route.ts` |
| `results` array (bulk) | 200 | `bulk/route.ts` |
| Embeddings per request | 500 | `embeddings/route.ts` |
| Pagination `limit` param | 100 | `properties/route.ts`, `inspections/route.ts` |
| File upload size | 50 MB | `upload/route.ts` |
| Image fetch timeout | 30 seconds | `compare.ts`, `train/route.ts` |
| AI API call timeout | 120 seconds | `compare.ts`, `train/route.ts` |
| String fields from AI | 200 chars (names), 500 chars (descriptions) | `train/route.ts` |

### Required Validation for AI-Parsed Data

When inserting data parsed from Claude Vision responses, EVERY field must be validated:

```typescript
// Names: typeof + trim + fallback + length limit
const name = typeof data.name === "string" && data.name.trim()
  ? data.name.trim().slice(0, 200)
  : "Fallback Name";

// Enums: typeof + includes check + fallback
const VALID_VALUES = ["a", "b", "c"];
const value = typeof data.value === "string" && VALID_VALUES.includes(data.value)
  ? data.value
  : "default";

// Arrays of URLs: typeof + truthy check per element
for (const url of urls) {
  if (typeof url !== "string" || !url.trim()) continue;
  // ... use url
}
```

### Error Response Contract

All error responses MUST use this shape:

```json
{ "error": "Human-readable message" }
```

Status codes:
- `400` — Validation failure (bad input from client)
- `401` — Not authenticated (no token or expired)
- `404` — Not found OR not owned by user (never return 403 — prevents ID enumeration)
- `500` — Unexpected server error (always logged with `console.error`)

Never expose: stack traces, DB error messages, internal IDs of other users' resources.

---

## Bug Catalog

Real bugs found during 4 review passes. Organized by category so future reviews can pattern-match.

### Category 1: Missing Validation (Found in passes 1–4)

**Bug:** UUID from URL params passed directly to DB query without validation.
**Where found:** Every route on first pass — none had `isValidUUID()`.
**Pattern to grep:**
```bash
# Find DB queries using params without prior UUID validation
grep -n "eq(.*\.id, id)" src/app/api/**/route.ts
# Then check: does isValidUUID(id) appear BEFORE that line?
```
**Fix:** Always call `isValidUUID(id)` immediately after extracting from params.

---

**Bug:** `typeof` check missing on body fields — object passed where string expected.
**Where found:** `room_name` in `vision/compare` (pass 4), `base64Image` in `upload` (pass 3).
**What happens:** `(someObject as string)` doesn't crash immediately, but downstream `.match()`, `.trim()`, or `.slice()` throws `TypeError`.
**Pattern to grep:**
```bash
# Find body destructuring followed by use without typeof check
grep -n "as string" src/app/api/**/route.ts
# Each hit: is there a typeof check BEFORE this cast?
```
**Fix:** Always `typeof field !== "string"` before any string operation.

---

**Bug:** Enum field accepted any string — no validation against allowed values.
**Where found:** `inspectionMode` in `compare-stream` (pass 4), `condition`/`importance` in `train` AI parsing (pass 4).
**What happens:** Invalid enum value reaches a `switch` statement with no `default` case → function returns `undefined` → `undefined` concatenated into prompt string.
**Fix:** Validate against `VALID_VALUES.includes(value)` array. Always add `default` case to switch statements.

---

**Bug:** Optional field validated when required but NOT when present-but-wrong-type.
**Where found:** `roomId` in conditions POST (pass 3), `imageUrl` in conditions (pass 3).
**Pattern:** Code checks `if (!roomId) { ... }` but doesn't check `if (roomId && typeof roomId !== "string")`.
**Fix:** Validate optional fields with: `if (field !== undefined && field !== null) { validate... }`

---

### Category 2: Security (Found in passes 2–4)

**Bug:** User-supplied URL fetched without SSRF protection.
**Where found:** `train/route.ts` image fetches (pass 4), `bulk/route.ts` `currentImageUrl` (pass 4), `embeddings/route.ts` Mode 1 (pass 4).
**What happens:** Attacker supplies `http://169.254.169.254/latest/meta-data/` → server fetches cloud metadata.
**Pattern to grep:**
```bash
# Find all fetch() calls and check for isSafeUrl() guard
grep -n "fetch(" src/app/api/**/route.ts src/lib/**/*.ts
# Each hit: is isSafeUrl() called on the URL before this fetch?
```
**Fix:** Call `isSafeUrl(url)` before every `fetch()`. Applied in `auth.ts` as shared utility.

---

**Bug:** `emitEvent()` (throwing version) used instead of `emitEventSafe()`.
**Where found:** Property DELETE handler (pass 4) — used manual try/catch around `emitEvent()`.
**What happens:** If the pattern is copied without the try/catch, a DB error in event emission returns 500 even though the primary operation succeeded.
**Fix:** Always use `emitEventSafe()`. Never import `emitEvent` directly in route files.

---

### Category 3: Performance (Found in passes 1–2)

**Bug:** N+1 query — DB call inside a loop.
**Where found:** `rooms/route.ts` (pass 1), `inspections/[id]/route.ts` (pass 1), `train/route.ts` baseline linking (pass 2), `train/route.ts` embedding updates (pass 4), `embeddings/route.ts` Modes 2 and 3 (pass 4).
**Pattern to grep:**
```bash
# Find await db.* inside for/for-of loops
grep -B5 "await db\." src/app/api/**/route.ts | grep -A1 "for ("
```
**Fix:** Batch-fetch with `inArray()` before the loop, build a `Map` for lookups.

```typescript
// BAD: N+1
for (const room of rooms) {
  const baselines = await db.select().from(baselineImages)
    .where(eq(baselineImages.roomId, room.id));
}

// GOOD: batch
const allBaselines = await db.select().from(baselineImages)
  .where(inArray(baselineImages.roomId, rooms.map(r => r.id)));
const baselinesByRoom = new Map();
for (const b of allBaselines) {
  if (!baselinesByRoom.has(b.roomId)) baselinesByRoom.set(b.roomId, []);
  baselinesByRoom.get(b.roomId).push(b);
}
```

---

**Bug:** List endpoint returns unbounded result set.
**Where found:** `properties/route.ts` (pass 2), `inspections/route.ts` (pass 2), `conditions/route.ts` (pass 4).
**Fix:** Add `limit`/`offset` pagination with `Math.min(limit, 100)`.

---

### Category 4: Error Handling (Found in passes 1–3)

**Bug:** Auth check outside try/catch — throws unhandled on cookie parsing failure.
**Where found:** `train/route.ts` (pass 2) — `getDbUser()` and param extraction were outside the try block.
**Fix:** The outer try/catch MUST wrap everything, including `await params` and `getDbUser()`.

---

**Bug:** `inArray()` called with empty array → Drizzle generates invalid SQL.
**Where found:** `inspections/[id]/baselines/route.ts` (pass 1).
**Fix:** Always guard: `const results = ids.length > 0 ? await db.select()...where(inArray(..., ids)) : [];`

---

### Category 5: Data Integrity (Found in passes 3–4)

**Bug:** Baseline version increment is not atomic — race condition on concurrent POSTs.
**Where found:** `baselines/route.ts` POST (pass 4).
**What happens:** Two requests read `MAX(versionNumber) = 3`, both create version 4.
**Fix:** Wrap in `db.transaction()`. The `MAX()` approach prevents most races but a transaction makes it bulletproof.

---

**Bug:** Training creates rooms/items/baselines across many queries without a transaction.
**Where found:** `train/route.ts` (pass 4).
**What happens:** If item creation fails for room 3, rooms 1-2 are already inserted. Catch block resets `trainingStatus` but doesn't clean up orphaned data.
**Fix (ideal):** `db.transaction()`. **(Fix deferred)** — the AI API calls in the middle make a single transaction impractical. Current mitigation: catch block resets status, and re-training overwrites.

---

## Automated Violation Detection

Run these grep commands to find common violations. Integrate into CI when ready.

```bash
# 1. Find routes missing outer try/catch
# Look for export async function without try on next line
grep -A2 "export async function" src/app/api/**/route.ts | grep -v "try {"

# 2. Find direct emitEvent usage (should be emitEventSafe)
grep -rn "emitEvent(" src/app/api/ --include="*.ts" | grep -v "emitEventSafe"

# 3. Find fetch() without isSafeUrl guard (check manually)
grep -rn "fetch(" src/app/api/ src/lib/ --include="*.ts" | grep -v "node_modules"

# 4. Find as string casts (potential validation bypass)
grep -rn "as string" src/app/api/ --include="*.ts"

# 5. Find as any casts
grep -rn "as any" src/app/api/ --include="*.ts"

# 6. Find DB queries inside loops (N+1 candidates)
grep -B3 "await db\." src/app/api/**/route.ts | grep "for \|for("

# 7. Find routes without UUID validation
grep -L "isValidUUID" src/app/api/**/route.ts

# 8. Find routes without body parse try/catch
grep -L "Invalid JSON body" src/app/api/**/route.ts
```

---

## Phase 0: Pre-Flight (30 seconds)

Before anything else, verify the project builds.

```
npx tsc --noEmit
```

If this fails, stop. Fix compilation errors first. Everything else is meaningless if the code doesn't compile.

**Also check:**
- [ ] `npm run lint` passes (or note any new warnings)
- [ ] No `.env` or credential files in staged changes (`git diff --cached --name-only`)

---

## Phase 1: Changed-File Impact Analysis (2–3 minutes)

Map what changed and what it touches.

1. **List changed files**: `git diff --name-only HEAD~N` (where N = commits since last review)
2. **Classify each file**:
   - `route.ts` → API surface change (test the endpoint)
   - `schema.ts` → Database change (check migrations, FK integrity)
   - `lib/` → Shared module (find all callers, test each)
   - `components/` → UI change (visual check)
   - `mobile/` → Mobile-specific (test with mobile auth flow)
3. **Map the blast radius**: For each changed file, list every file that imports it
4. **Flag high-risk changes**:
   - Auth changes (`auth.ts`, `middleware.ts`) → affects ALL endpoints
   - Schema changes → affects ALL queries against that table
   - Event type changes → affects ALL event emitters and consumers
   - Vision/compare changes → affects both web and mobile inspection flows

---

## Phase 2: Security Review (5–10 minutes)

Go through every changed API route and check each item. This is the highest-value phase — security bugs are the most expensive to fix after release.

### 2a. Input Validation Checklist

For every user-supplied value in every changed route:

- [ ] **UUIDs**: All ID params validated with `isValidUUID()` before DB queries
- [ ] **Strings**: `typeof` check before use (prevents object injection)
- [ ] **Numbers**: `typeof` check + bounds validation (no NaN, no Infinity)
- [ ] **Arrays**: `Array.isArray()` check + max length limit
- [ ] **Enums**: Validated against allowed values array (not just `typeof === 'string'`)
- [ ] **Optional fields**: Validated when present, not just when required
- [ ] **Nested objects**: Each property validated individually (don't trust `as Type` casts)

### 2b. Auth & Authorization Checklist

- [ ] Every route calls `getDbUser()` and returns 401 if null
- [ ] Every resource access checks ownership (`userId === dbUser.id` or equivalent)
- [ ] Auth check happens BEFORE any DB queries or business logic
- [ ] No `as string` casts on user input that bypass validation
- [ ] Params from URL path (`params.id`) validated before use

### 2c. SSRF & URL Safety

- [ ] Every user-supplied URL validated with `isSafeUrl()` before fetch
- [ ] URLs from DB also validated before fetch (defense in depth)
- [ ] `AbortSignal.timeout()` on ALL external fetches (30s images, 120s AI)
- [ ] No URL construction from user input without validation

### 2d. Data Exposure

- [ ] API responses don't leak internal IDs, stack traces, or DB errors
- [ ] Error messages are generic ("Not found", "Internal server error")
- [ ] No `console.log` of sensitive data (passwords, tokens, full request bodies)
- [ ] Pagination on all list endpoints (max 100 items)

---

## Phase 3: Error Handling Review (3–5 minutes)

### 3a. Try/Catch Coverage

- [ ] Every route handler has an outer try/catch returning 500
- [ ] JSON body parsing has its own try/catch returning 400
- [ ] Event emission uses `emitEventSafe()` (never blocks primary response)
- [ ] DB operations that can fail independently are wrapped

### 3b. Error Recovery

- [ ] Failed training resets `trainingStatus` to `"untrained"`
- [ ] Partial failures don't leave data in inconsistent state
- [ ] Catch blocks log the actual error (`console.error` with route context)
- [ ] No empty catch blocks (every catch either handles or logs)

### 3c. Edge Cases

- [ ] Empty arrays handled (`.length === 0` checks before `inArray()` queries)
- [ ] Null/undefined from DB queries handled (destructured with `[result]` pattern)
- [ ] Division by zero guarded (score calculations, averages)
- [ ] Date parsing validated (no `new Date(userInput)` without checks)

---

## Phase 4: Data Integrity Review (5–10 minutes)

### 4a. Database Operations

- [ ] Multi-step operations use transactions (`db.transaction()`) where atomicity matters:
  - Baseline version creation (deactivate old + create new)
  - Bulk inspection submission (insert results + update inspection status)
  - Training (create rooms + items + baselines + version)
- [ ] No N+1 queries: look for DB calls inside loops
  - Pattern to find: `for (...) { await db.select/insert/update }`
  - Fix: batch with `inArray()` or collect + single query
- [ ] Foreign key relationships respected (don't insert child without valid parent)
- [ ] Unique constraints won't conflict (version numbers, etc.)

### 4b. Race Conditions

- [ ] Concurrent requests can't create duplicate resources
- [ ] Version number increment is atomic (use `MAX()` + 1, not read-then-write)
- [ ] Status transitions are guarded (can't complete an already-completed inspection)
- [ ] No TOCTOU (time-of-check-time-of-use) bugs in auth or ownership checks

### 4c. Type Safety

- [ ] No `as any` casts on user input
- [ ] No `as string` casts that skip validation
- [ ] AI-parsed data (Claude responses) validated before DB insertion
- [ ] JSONB fields (`findings`, `payload`, `metadata`) have structure validation

---

## Phase 5: API Contract Review (3–5 minutes)

### 5a. Request Validation

For each changed endpoint, verify:

- [ ] Required fields return 400 with clear error message when missing
- [ ] Invalid field types return 400 (string where number expected, etc.)
- [ ] Extra/unknown fields are ignored (not passed to DB)
- [ ] Array size limits enforced (mediaUploadIds: 100, bulk results: 200, embeddings: 500)

### 5b. Response Consistency

- [ ] Success responses use consistent shape (`{ data }` or direct object)
- [ ] Error responses always have `{ error: string }` shape
- [ ] HTTP status codes are correct:
  - 200: Success (GET, PATCH)
  - 201: Created (POST that creates resources)
  - 400: Bad request (validation failure)
  - 401: Unauthorized (no/invalid auth)
  - 404: Not found (invalid ID or not owned)
  - 500: Internal error (unexpected failure)
- [ ] List endpoints return pagination metadata when paginated

### 5c. Mobile Compatibility

- [ ] Bearer token auth works (not just cookie auth)
- [ ] SSE streaming endpoints follow correct event format (`event: name\ndata: json\n\n`)
- [ ] Base64 image handling works alongside URL-based handling
- [ ] Response sizes are reasonable for mobile (no unbounded arrays)

---

## Phase 6: Performance Review (3–5 minutes)

### 6a. Query Efficiency

- [ ] No `SELECT *` on tables with large columns (embeddings, raw responses) unless needed
- [ ] Indexes exist on all columns used in WHERE clauses (check `server/schema.ts`)
- [ ] Pagination on all list endpoints
- [ ] Batch queries used instead of loops (`inArray()` pattern)

### 6b. Resource Limits

- [ ] Array inputs have max size limits
- [ ] File uploads have size limits (50MB)
- [ ] AI API calls have timeouts (120s)
- [ ] Image fetches have timeouts (30s)
- [ ] Embedding generation has per-request limits (500)

### 6c. Memory

- [ ] Large arrays aren't held in memory unnecessarily
- [ ] Base64 image data is streamed/chunked where possible
- [ ] No unbounded data accumulation in loops

---

## Phase 7: Cross-Cutting Concerns (2–3 minutes)

### 7a. Event Sourcing

- [ ] State-changing operations emit appropriate events
- [ ] Event types match the `EventType` union in `types.ts`
- [ ] Event payloads match their type interfaces
- [ ] All event emission uses `emitEventSafe()` (not `emitEvent()`)
- [ ] Events include correct `aggregateId`, `propertyId`, `userId`

### 7b. Consistency Patterns

All routes should follow this order:
1. Outer try/catch
2. Auth check (`getDbUser()`)
3. Param extraction + UUID validation
4. Body parsing (with try/catch)
5. Input validation
6. Authorization (ownership check)
7. Business logic
8. Event emission (safe)
9. Response

- [ ] New/changed routes follow this order
- [ ] Indentation is consistent within try blocks
- [ ] Import style matches existing files

---

## Phase 8: Functional Testing (5–15 minutes)

Actually test the changed features. This is where you act as a user.

### 8a. Happy Path

For each changed endpoint, make a valid request and verify:
- [ ] Correct response status code
- [ ] Response body has expected shape and data
- [ ] Database record created/updated/deleted correctly
- [ ] Events emitted correctly (check events table)

### 8b. Sad Path

For each changed endpoint, test error cases:
- [ ] Missing required fields → 400
- [ ] Invalid UUID → 400 or 404
- [ ] Wrong user (not owner) → 404 (not 403, to avoid ID enumeration)
- [ ] Duplicate creation → appropriate error
- [ ] Malformed JSON body → 400
- [ ] Oversized input → 400

### 8c. Integration Flows

Test complete workflows that span multiple endpoints:

**Property Lifecycle:**
1. `POST /api/properties` → create
2. `POST /api/upload` → upload images
3. `POST /api/properties/[id]/train` → AI training
4. `GET /api/properties/[id]/rooms` → verify rooms created
5. `GET /api/properties/[id]/baselines` → verify baseline version
6. `PATCH /api/properties/[id]` → update
7. `DELETE /api/properties/[id]` → delete + verify cascade

**Inspection Lifecycle:**
1. `POST /api/inspections` → start
2. `GET /api/inspections/[id]` → load details
3. `GET /api/inspections/[id]/baselines` → load baseline data
4. `POST /api/inspections/[id]` → submit single room result
5. `POST /api/inspections/[id]/bulk` → submit remaining rooms
6. `GET /api/inspections` → verify completed inspection in list

**Conditions Lifecycle:**
1. `POST /api/properties/[id]/conditions` → register condition
2. `GET /api/properties/[id]/conditions` → verify listed
3. `PATCH /api/properties/[id]/conditions` → resolve
4. `GET /api/properties/[id]/conditions?active=false` → verify resolved shown

---

## Phase 9: What to Look For That's Easy to Miss

These are the bugs that survive multiple review passes. They're subtle and pattern-based.

### 9a. The "Almost Right" Bug
- Value validated as string but not checked for empty string
- UUID validated but not checked against actual DB records (can reference other users' data)
- Array validated as non-empty but individual elements not validated
- Auth check present but happens AFTER some business logic already ran

### 9b. The "Works in Dev" Bug
- Hardcoded `localhost` URLs that break in production
- `console.log` with sensitive data that shows up in production logs
- Missing CORS headers for mobile app requests
- Supabase bucket creation (auto-creates in dev, fails in prod if not pre-created)

### 9c. The "Nobody Tests This" Bug
- What happens when the Anthropic API key is missing/invalid?
- What happens when Supabase storage is down?
- What happens when the DB connection pool is exhausted?
- What happens when a user deletes a property that has active inspections?
- What happens when two users try to inspect the same property simultaneously?

### 9d. The "Mobile-Only" Bug
- SSE stream disconnects mid-inspection (does the mobile app retry?)
- Large base64 images exceed request body limits
- Bearer token expires during long inspection (401 mid-stream)
- Slow/intermittent connectivity during bulk submission

---

## Quick Reference: File → What to Test

| File Changed | Test Focus |
|---|---|
| `server/schema.ts` | Migration safety, FK integrity, index coverage |
| `src/lib/auth.ts` | ALL endpoints (auth is cross-cutting) |
| `src/lib/vision/compare.ts` | Compare endpoint, compare-stream, inspection POST |
| `src/lib/events/emit.ts` | ALL routes that emit events |
| `src/lib/events/types.ts` | Event emission type safety |
| `src/app/api/properties/route.ts` | Create + list properties |
| `src/app/api/properties/[id]/route.ts` | Get, update, delete property |
| `src/app/api/properties/[id]/train/route.ts` | Training flow end-to-end |
| `src/app/api/properties/[id]/rooms/route.ts` | Room listing, baseline association |
| `src/app/api/properties/[id]/baselines/route.ts` | Version management, activation |
| `src/app/api/properties/[id]/conditions/route.ts` | Condition CRUD |
| `src/app/api/inspections/route.ts` | Create + list inspections |
| `src/app/api/inspections/[id]/route.ts` | Inspection detail, single room submit |
| `src/app/api/inspections/[id]/bulk/route.ts` | Bulk submission, scoring |
| `src/app/api/inspections/[id]/baselines/route.ts` | Inspection-ready data loading |
| `src/app/api/vision/compare/route.ts` | One-off comparison |
| `src/app/api/vision/compare-stream/route.ts` | SSE streaming comparison |
| `src/app/api/upload/route.ts` | File + base64 upload |
| `src/app/api/embeddings/route.ts` | Embedding generation (3 modes) |
| `mobile/src/lib/api.ts` | Mobile API wrapper, retry logic |
| `mobile/src/lib/vision/comparison-manager.ts` | SSE parsing, findings state |

---

## Severity Classification

When reporting issues, classify them:

| Severity | Definition | Example |
|---|---|---|
| **Critical** | Data loss, auth bypass, or security vulnerability | SSRF, missing auth check, SQL injection |
| **High** | Incorrect behavior that affects users | Missing validation causes 500, N+1 causing timeouts |
| **Medium** | Correctness issue that doesn't block usage | Missing enum validation, inconsistent error format |
| **Low** | Code quality, consistency, or minor edge case | Indentation, unused import, missing pagination on small lists |

---

## Automated Checks (Future)

These should be automated as the project matures:

### Priority 1: Add Now
- [ ] TypeScript strict mode (`strict: true` in tsconfig)
- [ ] ESLint rules for: no `as any`, no `as string` on user input
- [ ] Pre-commit hook: `tsc --noEmit && eslint`

### Priority 2: Add Soon
- [ ] Vitest setup with API route integration tests
- [ ] Test the auth flow (cookie + bearer token)
- [ ] Test input validation on every route (400 responses)
- [ ] Test ownership checks (404 for other users' resources)

### Priority 3: Add When Scaling
- [ ] Load testing: concurrent inspections, bulk submissions
- [ ] Database: test migration up/down cycles
- [ ] E2E: Playwright for web dashboard flows
- [ ] Mobile: Detox or Maestro for inspection camera flow

---

## How to Run This Protocol

### Quick Mode (after small changes): Phases 0, 1, 2, 3
**Time:** ~15 minutes
**When:** Bug fixes, small feature additions, dependency updates

### Standard Mode (after feature releases): Phases 0–7
**Time:** ~30 minutes
**When:** New endpoints, schema changes, auth changes, vision updates

### Full Mode (after major releases): Phases 0–9
**Time:** ~60 minutes
**When:** Major features, refactors, pre-launch, post-security-incident

---

## Protocol Version History

| Version | Date | Changes |
|---|---|---|
| 1.0 | 2026-03-08 | Initial protocol based on 4-pass review of full codebase |
| 1.1 | 2026-03-08 | Added: Established Code Standards, Route Template, Bug Catalog (5 categories, 12 bugs), Automated Violation Detection grep commands |

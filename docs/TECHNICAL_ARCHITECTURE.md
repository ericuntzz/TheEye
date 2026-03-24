# Atria Technical Architecture & Implementation Plan

> **Version:** 1.0 | **Last updated:** March 9, 2026
> **Status:** Active — guiding all development work
> **Scope:** Complete technical specification from MVP through autonomous AI platform

---

## Table of Contents

1. [Product Vision & Context](#1-product-vision--context)
2. [Core UX Principles](#2-core-ux-principles)
3. [The Product Model](#3-the-product-model-autonomous-outcomes)
4. [Information Hierarchy](#4-information-hierarchy)
5. [Event-Driven Architecture](#5-event-driven-architecture)
6. [Two-Project Architecture](#6-two-project-architecture)
7. [Processing Pipeline](#7-processing-pipeline)
8. [Phase 1: Backend Enhancements](#8-phase-1-backend-enhancements)
9. [Phase 2: React Native Mobile App](#9-phase-2-react-native-mobile-app)
10. [Phase 3: Smart Glasses Integration](#10-phase-3-smart-glasses-integration)
11. [Phase 4: Product Features (Web Dashboard)](#11-phase-4-product-features)
12. [Phase 5: Multi-Agent AI Architecture](#12-phase-5-multi-agent-ai-architecture)
13. [Phase 6: Developer Brain](#13-phase-6-developer-brain)
14. [Phase 7: User Feedback Brain](#14-phase-7-user-feedback-brain)
15. [Real-World Edge Cases](#15-real-world-edge-cases)
16. [Operational Considerations](#16-operational-considerations)
17. [Files Summary](#17-files-summary)
18. [Implementation Order](#18-implementation-order)
19. [Verification Checklists](#19-verification-checklists)
20. [Critical Logic Gates](#20-critical-logic-gates)

---

## 1. Product Vision & Context

Atria currently uses a manual room-by-room web inspection flow. We are building **the operating system for property readiness, damage proof, and owner trust** in luxury vacation rentals and second-home management.

The product is **NOT** "AI home inspection." It is:

- **A silent turnover companion** that only asks for attention when money, safety, or owner experience is at risk
- **The trusted inspection record** — proof of who inspected, when, how thoroughly, and what they found
- **A claims-ready evidence system** — before/after documentation that maps directly to Airbnb/VRBO damage workflows
- **A damage attribution system** — "Never lose a damage claim again." Automatically answers "which guest caused this?" with insurance-grade evidence
- **A self-learning platform** — AI that adapts to each property over time, reducing operator burden to near-zero

---

## 2. Core UX Principles

- Auto-detects which room the user is in (no manual selection)
- Passively tracks coverage via angle-based scanning (not just room entry)
- Alerts only when it finds issues — haptic vibration + finding pops up
- Shows completion via a slim HUD progress bar (not an overlay)
- Self-learns — the system gets smarter after every inspection, per property
- Delivers **decisions, not observations** — the system does the thinking, the manager just approves

**No ghost overlay. No matching game.** The camera feed stays clean and full-screen. The phone is a silent partner. Users will not read instructions, will not manually categorize findings, and will not slow down. The product must function even if the user is moving quickly and barely paying attention.

---

## 3. The Product Model: Autonomous Outcomes

The biggest risk is building a "smart tool" instead of an "autonomous outcome system."

**Wrong model** (what 95% of AI products do):
```
Observation -> User thinking -> User execution
"6 findings detected. Go figure out what to do."
```

**Correct model** (what Atria must do):
```
Observation -> AI reasoning -> AI preparation -> Human approval
"3 actions completed. 1 approval needed. [Approve]"
```

Every feature must pass this litmus test: **Does this reduce thinking for the manager?** If the answer is no, the feature is wrong.

**Example — the wrong way:**
> Finding detected: marble countertop stain
> Manager must: remember previous inspections, check guest dates, confirm it wasn't pre-existing, gather evidence, file claim. Total time: 30-45 minutes.

**Example — the right way:**
> Damage detected: marble countertop stain
> Attribution confidence: 93%
> Evidence package prepared.
> Recommended action: File claim with Airbnb Resolution Center.
> **[Approve Claim Filing]**
> Total time: 10 seconds.

---

## 4. Information Hierarchy

Luxury property managers want "tell me what matters," not "show me everything."

| Level | Category | Examples | Delivery |
|-------|----------|----------|----------|
| 1 — Critical | Safety + urgent | Water leak, broken glass, hot tub issue, major damage | Immediate alert |
| 2 — Financial | Claimable damage | Guest damage, attribution-ready findings | Important, action queue |
| 3 — Maintenance | Routine repairs | Loose fixture, small crack, worn hardware | Batched, auto-ticketed |
| 4 — Cosmetic | Minor visual | Small scuff, pillow misaligned | Optional, lowest priority |

The dashboard surfaces Level 1-2 proactively. Level 3-4 are handled automatically (tickets created, conditions logged) and only surface if the manager wants to see them.

---

## 5. Event-Driven Architecture

**Everything that happens in Atria is an event.** Instead of storing state directly in CRUD tables, we write immutable events and derive state from them. This is the architectural foundation that makes Property Memory, Damage Attribution, Multi-Agent orchestration, and 10,000+ property scale possible.

### Why Events

- **Property Memory becomes trivial:** The unified property timeline is literally `filter events by propertyId` — no special denormalization
- **Damage Attribution becomes a query:** "Show me all events between inspection A and inspection B for this property" — instant attribution
- **Multi-Agent Architecture is natural:** Agents subscribe to event streams and react independently
- **Audit trail is built-in:** Every action is an immutable record — critical for claims, insurance, and accountability
- **Replay & debugging:** Can reconstruct any property's state at any point in time

### Pragmatic Approach

Full CQRS/EventStore infrastructure (EventStoreDB, Kafka) is overkill before product-market fit.

```
Phase A: PostgreSQL append-only `events` table + Drizzle materialized state tables
         -> Events are the write model (append-only, immutable)
         -> Existing tables (properties, rooms, inspections, findings) are materialized views
         -> Dashboard reads from materialized tables (fast queries, familiar patterns)
         -> Background workers update materialized state from events

Phase B-C: If scale demands it, migrate to dedicated event store
           -> Same event schema, different storage engine
           -> Materialized views become projections
           -> Agents become event stream subscribers
```

### Core Event Types

```
PropertyEvents:
  PropertyCreated, PropertyUpdated, BaselineVersionCreated,
  BaselineVersionActivated, BaselineRefreshRequested,
  BaselineRefreshApproved, BaselineRefreshRejected

InspectionEvents:
  InspectionStarted, InspectionPaused, InspectionResumed,
  InspectionCompleted, RoomEntered, RoomExited,
  AngleScanned, ComparisonSent, ComparisonReceived

FindingEvents:
  FindingSuggested, FindingConfirmed, FindingDismissed,
  FindingMuted, FindingTicketed, FindingMarkedKnownCondition,
  FindingResolved

MaintenanceEvents:
  TicketCreated, TicketAssigned, TicketInProgress,
  TicketResolved, TicketReopened

ClaimsEvents:
  DamageDetected, AttributionCalculated, ClaimPrepared,
  ClaimApproved, ClaimFiled, ClaimResolved

GuestEvents:
  GuestStayRecorded, GuestStayUpdated

ConditionEvents:
  ConditionRegistered, ConditionAcknowledged, ConditionResolved

SystemEvents:
  RestockItemDetected, PresentationFindingDetected,
  BaselineDeviationFlagged, CoverageThresholdReached
```

### Event Schema

```typescript
events = pgTable("events", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventType: text("event_type").notNull(),        // e.g., "FindingConfirmed"
  aggregateType: text("aggregate_type").notNull(), // e.g., "property", "inspection"
  aggregateId: uuid("aggregate_id").notNull(),     // e.g., propertyId or inspectionId
  propertyId: uuid("property_id"),                 // denormalized for fast property queries
  userId: uuid("user_id"),                         // who triggered the event
  payload: json("payload").notNull(),              // event-specific data
  metadata: json("metadata"),                      // context: device, network, app version
  timestamp: timestamp("timestamp").defaultNow().notNull(),
  version: integer("version").notNull(),           // optimistic concurrency per aggregate
});

// Index: (propertyId, timestamp) — fast property timeline queries
// Index: (aggregateId, version)  — event ordering per aggregate
// Index: (eventType, timestamp)  — agent subscriptions
```

### Individual Property Dashboards

Events make per-property dashboards better, not harder. The dashboard queries materialized state tables (properties, rooms, findings, inspections) which are derived from events. Each property has its own complete data set. The event log adds a bonus: the property timeline view is a direct read of events filtered by `propertyId`, ordered by `timestamp`.

```
User opens "Aspen Lodge" dashboard
  -> Reads materialized tables: property details, rooms, latest inspection scores
  -> Reads events for timeline: all events WHERE propertyId = X ORDER BY timestamp DESC
  -> Both are fast PostgreSQL queries — no architectural complexity for the user
```

---

## 6. Two-Project Architecture

```
+--------------------------------------------------+
|  Next.js Backend (existing)                      |
|  - /api/inspections, /api/properties, /api/upload|
|  - /api/vision/compare-stream (SSE endpoint)     |
|  - /api/embeddings                               |
|  - Supabase Auth, PostgreSQL, Supabase Storage   |
|  - Web dashboard for management/training         |
+------------------------+-------------------------+
                         | HTTPS API calls
+------------------------v-------------------------+
|  React Native (Expo) Mobile App (new)            |
|  - Clean full-screen camera (no overlay)         |
|  - Auto room detection (MobileCLIP on-device)    |
|  - Angle-based coverage tracking                 |
|  - Real-time alerts with haptic feedback         |
|  - BLE glasses connection (Phase 3)              |
+--------------------------------------------------+
```

---

## 7. Processing Pipeline

```
Camera Feed (30fps native)
    |
    +---> Room Detection + Coverage Loop (~3fps, ON-DEVICE)
    |       MobileCLIP-S0 via ONNX Runtime
    |       -> cosine similarity vs stored baseline embeddings
    |       -> 5-frame hysteresis (no flicker at doorways)
    |       -> identify current room
    |       -> angle tracking: mark baseline angles as "scanned"
    |          when similarity > 0.85
    |       -> coverage = scannedAngles / totalAngles per room
    |       -> adaptive rate: 3fps -> 1fps when 99%+ confident
    |          for >30s
    |
    +---> Comparison Loop (throttled, SERVER-SIDE)
            Frame diff pre-filter (on-device, <5ms)
            + IMU stillness check (gyroscope, >500ms stable)
            -> burst capture: 2 high-res frames 500ms apart
               (detects motion like running water)
            -> dynamic tiling: crop only the changed region
            -> POST to /api/vision/compare-stream
            -> Claude Vision expert analysis (2-5s)
            -> SSE streams findings back
            -> haptic vibration + finding card pops up
```

---

## 8. Phase 1: Backend Enhancements

> Next.js — modify existing backend

### 1.1 Extract Shared Comparison Logic + Expert Prompts

**New:** `src/lib/vision/compare.ts`

- Extract `compareImages()` from `src/app/api/inspections/[id]/route.ts`
- Accept base64 directly (no Supabase round-trip for live frames)
- Multi-frame burst support: Accept 2 images 500ms apart for detecting motion (running water, flickering lights)

**Enhanced expert prompt** — the AI acts as a Master Home Inspector for luxury vacation rentals ($3M-$20M+ properties):

#### Object Categorization (four-class inventory doctrine)

Classify all detected objects as:

| Class | Examples | Alert Behavior |
|-------|----------|----------------|
| **Fixed/structural** | Cabinets, sinks, appliances, built-in shelves, windows, doors, countertops, mounted decor | Deviations ALWAYS trigger alerts |
| **Durable movable** | Chairs, stools, coffee tables, lamps, cookware, remote controls, hair dryers | Tolerance for repositioning; only alert if missing entirely or damaged |
| **Decorative objects** | Pillows, throws, small decor, artwork, table settings | High tolerance; only alert if baseline inventory item is completely absent |
| **Consumables/replenishable** | Coffee pods, soaps, tissues, paper goods, cleaning supplies, firewood, welcome basket items, pool towels | Do NOT treat depletion as damage. Route to **restock lane** |

#### Three Output Lanes

Every AI detection routes to exactly one:

1. **Condition findings** — damage, safety, maintenance, guest damage (the core inspection output)
2. **Presentation findings** — staging, reset, premium-readiness (active by default ONLY in `owner_arrival` mode, optional in other modes)
3. **Restock items** — consumable depletion, amenity replenishment (separate operational output, never mixed into condition findings)

#### Detection Specializations

- **Operational states:** Faucets on/off (specular highlights/shimmer indicating running water), windows open/closed, blinds position, oven/stove knobs, thermostat settings, light switches, toilet seats, shower doors
- **Open windows/doors context:** Only flag if they create risk (winter/rain, security concern). Ventilation after cleaning is normal.
- **Fine damage:** Hairline cracks, nail holes, small stains, scuff marks, paint chips, chipped tile, scratched surfaces, water rings — "zoom and enhance" on subtle details
- **Missing/moved items:** Compare against item inventory from training, apply object categorization rules
- **Maintenance indicators:** Water stains on ceilings/walls, mold/mildew, pest signs, peeling paint, warped flooring
- **Safety hazards:** Exposed wiring, loose railings, tripping hazards, blocked exits
- **Contextual logic:** If main water is off but faucet handle is ON, flag it; if blinds differ from baseline, note it
- **Vacancy tolerance:** Minor dust, small cobwebs, seasonal pollen, dead insects — NOT damage unless severe
- **Pet tolerance:** Pet hair, nose prints, paw prints — "temporary surface mess," NOT scratches/stains/damage
- **Smart home awareness:** Ignore dynamic smart home states (screens, Lutron/Control4/Savant lights, motorized blinds)
- **Staging awareness:** Detect baseline mismatch but categorize as "staging difference," not damage
- **Outdoor areas:** Hot tubs (water level, cover), pools (debris, clarity), outdoor kitchens, fire pits, patios, grills, furniture, lighting
- **Known condition awareness:** Cross-reference the Property Condition Register before classifying. If issue matches a known condition, suppress it.
- **Lighting disclaimer:** Focus on structural/object changes, not shadow/brightness differences. Ignore color temperature shifts.

#### Damage Severity Classification

Every finding must include one of:
- `cosmetic` — minor visual issue, no functional impact
- `maintenance` — requires routine maintenance
- `safety` — potential safety hazard, needs prompt attention
- `urgent_repair` — immediate action needed (water leak, broken fixture)
- `guest_damage` — damage likely caused by recent guest (for Airbnb/VRBO claims)

#### Presentation Findings (luxury standards)

Two finding categories: `condition` (damage, safety, maintenance) and `presentation` (staging, reset, premium-readiness).

Presentation issues include: pillows arranged poorly, throw blankets folded wrong, dining set not staged correctly, blinds misaligned, toiletries not presented well, patio furniture not symmetrically arranged.

- In `turnover` mode: presentation findings are lower priority
- In `owner_arrival` mode: presentation findings are elevated to primary importance

#### Priority Issue Categories for V1

| Area | Watch For |
|------|-----------|
| **Kitchen** | Refrigerator/freezer status, dishwasher status, oven/stove knobs, trash left behind, sink/faucet issues, countertop stains/scratches |
| **Bathrooms** | Running water, slow drains, mold/mildew, broken towel bars, shower door state |
| **Bedrooms** | Stained linens, missing bulbs, damaged shades/blinds, wall damage around luggage areas |
| **Outdoor** | Hot tub cover condition, water level/clarity, grill condition, furniture damage, exterior lighting |

**Modify:** `src/app/api/inspections/[id]/route.ts` — import from shared module
**Modify:** `src/app/api/vision/compare/route.ts` — import from shared module

### 1.2 SSE Comparison Endpoint

**New:** `src/app/api/vision/compare-stream/route.ts`

- POST: `{ baselineUrl, currentImages: string[] (1-2 base64), roomName, inspectionId?, roomId?, baselineImageId? }`
- Returns SSE: `event: status` -> `event: result` (findings + score) -> `event: done`
- Optionally persists to `inspectionResults`

### 1.3 Embeddings API

**New:** `src/app/api/embeddings/route.ts`

- POST: accepts image URLs, returns 512-dim MobileCLIP embeddings
- Uses `onnxruntime-node` with the same MobileCLIP-S0 `.onnx` model file as the mobile app (critical for embedding consistency)

### 1.4 Embedding Storage + Baseline Versioning + Quality Gate + Events Table

**Modify:** `server/schema.ts`

- **Add `events` table** (append-only event log — see Event-Driven Architecture section):
  - `id uuid`, `eventType text`, `aggregateType text`, `aggregateId uuid`, `propertyId uuid?`, `userId uuid?`, `payload json`, `metadata json?`, `timestamp`, `version integer`
  - Indexes: `(propertyId, timestamp)`, `(aggregateId, version)`, `(eventType, timestamp)`
  - All state-changing operations emit an event alongside updating materialized state tables

- **Add to `baselineImages`:**
  - `embedding json` — 512-dim Float32Array as JSON
  - `qualityScore real` — Laplacian variance blur score
  - `embeddingModelVersion text` — track which model generated the embedding

- **Add `baselineVersions` table:**
  - `id`, `propertyId`, `versionNumber integer`, `label text` (e.g., "Original", "Post-renovation", "Winter 2025"), `isActive boolean`, `createdAt`
  - Each version groups a set of baseline images for a property
  - Only one version active at a time per property
  - Old versions preserved for comparison/history

- **Add `baselineVersionId` FK** to `baselineImages`

- **Update `inspectionResults`:** finding type to include `severity: "cosmetic" | "maintenance" | "safety" | "urgent_repair" | "guest_damage"`

- **Add `inspectionEvents` table:**
  - `id`, `inspectionId`, `eventType text` (room_entered, angle_scanned, finding_suggested, finding_confirmed, finding_dismissed, finding_muted, comparison_sent, comparison_received, inspection_paused, inspection_resumed), `roomId?`, `metadata json`, `timestamp`
  - Metadata: `networkState`, `batteryLevel`, `thermalState`, `baselineVersion`, `inspectionMode`, `knownConditionMatch?`, `linkedTicketId?`

- **Add `propertyConditions` table** (Property Condition Register):
  - `id`, `propertyId`, `roomId?`, `description text`, `category text` ("accepted_wear", "deferred_maintenance", "owner_approved", "known_defect"), `severity text`, `imageUrl?`, `reportedAt`, `acknowledgedBy`, `resolvedAt?`, `isActive boolean`
  - Known unresolved defects, owner-approved exceptions, deferred maintenance, accepted wear-and-tear
  - AI comparison references this register to suppress known conditions
  - Conditions can be created from confirmed findings ("Mark as known condition") or added manually

- **Add `guestStays` table** (Guest Stay Timeline):
  - `id`, `propertyId`, `guestName text?`, `platform text` ("airbnb", "vrbo", "direct", "owner"), `checkIn date`, `checkOut date`, `reservationId text?`, `notes text?`
  - Links guest reservation windows to properties
  - Enables automatic damage attribution
  - Can be populated manually, via API integration, or via PMS (Guesty, Hostaway, etc.)

- **Update finding model** with state machine and claims metadata:
  - Finding states: `suggested` -> `confirmed` -> `ticketed` -> `known_condition` -> `resolved`
  - `suppression text` — one of: `none`, `session_mute`, `stay_mute`, `resolved_suppression`, `known_condition`
  - `isClaimable boolean` — whether this finding has financial/claims relevance
  - `claimMetadata json?` — `{ baselineImageId, currentCaptureId, timeFound, confirmedBy, previousInspectionHadIssue, existingTicketId, preExistingConditionId? }`
  - `findingCategory text` — `condition` vs `presentation`

**New:** `src/app/api/properties/[id]/baselines/route.ts`
- GET: list all baseline versions for a property
- POST: create a new baseline version (triggers re-training)
- PATCH: set active version

**Modify:** `src/app/api/properties/[id]/train/route.ts`
- After creating baseline images, generate MobileCLIP embeddings and store
- Store `embeddingModelVersion` with each embedding
- Create baseline version record, set as active
- **Quality gate:** Calculate Laplacian variance (blur detection). If baseline is too blurry, flag it and prompt retake.
- **Baseline refresh approval workflow:** If inspection shows >30% baseline deviation across multiple rooms:
  1. System suggests baseline refresh (notification, NOT auto-refresh)
  2. Property manager reviews and approves/rejects
  3. If approved, optionally requires a dedicated re-baseline walkthrough
  4. Manager labels the reason: `post_renovation`, `owner_update`, `seasonal_setup`, `furniture_replacement`, `staging_change`
  5. Old baseline version preserved — protects chain of truth for historical claims

### 1.5 Inspection API Enhancement

**Modify:** `src/app/api/inspections/[id]/route.ts`
- Add `GET /api/inspections/{id}/baselines` — returns all rooms with baseline images, embeddings, and item inventories
- Add `POST /api/inspections/{id}/bulk` — accept multiple room results at once

### 1.6 Base64 Upload Support

**Modify:** `src/app/api/upload/route.ts`
- Add JSON body path: `{ base64Image, propertyId, fileName }`

---

## 9. Phase 2: React Native Mobile App

> New project: `mobile/` directory

### 2.0 Project Setup

- Expo SDK 52+ with Expo Dev Client
- Key deps: `expo-camera`, `expo-sensors`, `expo-haptics`, `expo-image`, `expo-secure-store`, `onnxruntime-react-native`, `react-native-reanimated`, `react-native-gesture-handler`, `@gorhom/bottom-sheet`, `@supabase/supabase-js`, `@react-navigation/native`

### 2.1 Auth & API Layer

**New:** `mobile/src/lib/api.ts` — fetch wrapper for Next.js backend
**New:** `mobile/src/lib/supabase.ts` — Supabase client with `expo-secure-store`

### 2.2 Room Detection + Angle Tracking Engine

**New:** `mobile/src/lib/vision/room-detector.ts`

- Loads MobileCLIP-S0 ONNX model via `onnxruntime-react-native`
- `generateEmbedding(imageUri)` -> `Float32Array[512]`
- `identifyRoom(frame, baselines[])` -> `{ roomId, roomName, confidence }`
- **5-frame hysteresis:** Only switch rooms when new room is top match for 5 consecutive frames
- **Angle tracking:** Each room has 3-5 baseline images from different angles. When current frame has cosine similarity > threshold to a specific baseline, that angle is marked "scanned." Coverage = scannedAngles / totalAngles.
  - **Tunable threshold:** Default 0.85, configurable per room type. White-walled bathrooms may need lower (0.78). Complex kitchens may need higher (0.88). Calibrated during training.
- **Multi-room buffering** (doorway handling): If confidence scores for two rooms are both high (e.g., Kitchen 45%, Hallway 40%), track angles for BOTH simultaneously. The camera sees it, it counts.
- **Zone detection** (open floor plans): Luxury homes often have great rooms, open kitchens, connected dining areas. When multiple rooms share an open space, treat them as "zones."
  - **Two-layer coverage model** to prevent inflated completion in open plans:
    - **Coarse coverage:** Room/zone was seen by camera. Counts toward `minimum` completion tier.
    - **Inspection-grade coverage:** Specific anchored viewpoints or object clusters were seen. Counts toward `standard`/`thorough` tiers.
    - During training, each baseline image is tagged with which object clusters it covers.
- **Outdoor areas:** Support outdoor zones (patios, pool areas, hot tub, outdoor kitchen, fire pit) as inspectable rooms.
- **Adaptive rate:** 3fps default. Drops to 1fps when 99%+ confident in current room for >30s. Resumes 3fps on significant motion.
- **Native ONNX:** ~30-80ms per frame

**New:** `mobile/src/lib/vision/room-detector-models/` — Quantized MobileCLIP-S0 ONNX model (~10-20MB)

### 2.3 Change Detection + Motion Filter

**New:** `mobile/src/lib/vision/change-detector.ts`
- Pixel diff at 320x240 -> `{ diffPercentage, hasMeaningfulChange, changedQuadrants[] }`
- Localized change detection: identifies which quadrant(s) changed -> enables dynamic tiling
- Runs in <5ms

**New:** `mobile/src/lib/sensors/motion-filter.ts`
- Uses `expo-sensors` (accelerometer + gyroscope)
- `isStable(thresholdMs: 500)` -> boolean
- Prevents sending motion-blurred frames to Claude

### 2.4 Comparison Manager ("The Silent Trigger")

**New:** `mobile/src/lib/vision/comparison-manager.ts`

- Only triggers when: `hasMeaningfulChange AND isStable AND cooldownElapsed`
- **Burst capture:** 2 high-res frames 500ms apart (for motion detection). **Lock auto-exposure and auto-focus** between frames — brightness shifts cause false "flickering" findings.
- **Dynamic tiling:** If change is localized, crop and send only that region (~1024x1024). **Always include a low-res context thumbnail** so Claude knows WHERE in the room the crop is from.
- **Resolution switching:** Live preview at 1080p. 4K capture only for comparison frames (saves battery/heat).
- Config: `minIntervalMs: 5000`, `maxConcurrent: 1`
- POSTs to `/api/vision/compare-stream`, parses SSE response
- On finding: triggers haptic vibration via `expo-haptics`

### 2.5 Session Manager (Coverage + Event Logging)

**New:** `mobile/src/lib/inspection/session-manager.ts`

**State:**
- `allRooms[]` — rooms + baseline embeddings (loaded at start)
- `currentRoom` — auto-detected
- `visitedRooms` Map -> `{ findings[], bestScore, anglesScanned: Set<baselineId>, confirmed: boolean[] }`
- `roomCoverage(roomId)` — `anglesScanned.size / totalAngles`
- `overallCoverage` — average of all room coverages
- `overallScore` — weighted average of room scores

**Inspection modes** (selected at start — adjusts prompt, thresholds, and priorities):

| Mode | Purpose | Optimized For |
|------|---------|---------------|
| `turnover` | Post-checkout speed inspection | Exception detection, claim evidence, completion tier |
| `maintenance` | Inspect known problem or verify repairs | Issue-specific capture, before/after repair evidence |
| `owner_arrival` | "Is the home perfect for owner use?" | Cleanliness, staging, operational settings, premium presentation |
| `vacancy_check` | Monitor homes that sat empty | Leaks, pests, HVAC, environmental conditions |

Same core engine, different parameter presets per mode (prompt additions, tolerance thresholds, severity weights, priority categories).

**Progressive completion levels** (for fast-moving cleaning crews):

| Tier | Coverage | Description |
|------|----------|-------------|
| `minimum` | At least 1 angle per room | Quick walkthrough, ~10-30 sec/room |
| `standard` | 60%+ angles per room | Normal inspection |
| `thorough` | 100% angles per room | Deep inspection |

User can end inspection at any level; the report shows completion tier per room. Default target: `standard`. UI encourages `thorough` but never blocks `minimum`.

**Comprehensive event logging:** Every action generates an event logged locally and synced to `inspectionEvents` table:
- `room_entered` / `room_exited` — with timestamp and confidence
- `angle_scanned` — which baseline angle was matched
- `finding_suggested` / `finding_confirmed` / `finding_dismissed` / `finding_muted`
- `comparison_sent` / `comparison_received` — API call tracking
- `inspection_paused` / `inspection_resumed`
- `baseline_deviation_flagged`

This log becomes the official inspection record — proof that someone inspected, when, how thoroughly, and what they found.

### 2.6 Camera Screen — "The HUD"

**New:** `mobile/src/screens/InspectionCamera.tsx`

```
+-------------------------------+
| <- End   Kitchen  3/5 angles  |  <- room name + angle progress
| ================  Property 67%|  <- overall coverage bar
+-------------------------------+
|                               |
|                               |
|   Clean Full-Screen Camera    |  <- NO overlay. Just the real world.
|                               |
|         o                     |  <- "Pulse" ring:
|      (green)                  |     Green = angle recorded
|                               |     Yellow = moving too fast
|                               |     Hidden when stable + idle
|                               |
+-------------------------------+
|  ^ 2 findings                 |  <- collapsed findings drawer
|  ! Faucet on in guest bath    |     slides up on new finding
|  ! Scratch on kitchen counter |     with haptic buzz
+-------------------------------+
```

**Features:**
- **Camera:** `expo-camera` at 1080p preview, 4K burst capture for comparisons
- **No overlay:** Clean camera feed. The user looks at the actual house.
- **Room badge** (top): Shows detected room name + "3/5 angles" progress
- **Coverage bar** (top): Slim progress bar showing overall property scan completion
- **Pulse ring** (center, subtle): Brief green flash when an angle is recorded. Yellow if moving too fast. Invisible when idle.
- **Findings drawer** (bottom): Collapsed by default. Slides up with haptic vibration on new finding. Each finding shown as "Suggested" with Confirm (checkmark) or Dismiss (X) buttons.
- **Side-by-side review** (on-demand only): When user taps a finding, comparison view slides up showing baseline vs. current capture. This is a review tool, not a walking view.
- **Recording indicator** (persistent): Small red dot + "REC" badge. Required for App Store compliance.
- **Privacy disclosure:** On first use, one-time privacy screen explaining: camera is active, faces are blurred before upload, no PII leaves the device.
- **Configurable media retention:** Admin setting for storage duration before automatic deletion.
- **Voice logging:** Two activation methods — (1) microphone button, (2) wake phrase ("Log issue" or "Note") for hands-free operation. Inspector speaks naturally -> speech-to-text -> Claude structuring -> structured finding. Auto-creates ticket + ledger entry.
- **Quick issue buttons:** Common non-visual issues via floating action button: `Hot Tub Issue`, `Water Leak`, `HVAC Noise`, `Propane Low`, `Garbage Odor`, `Pest Sign`, `Pool Chemistry`, `Lighting Issue`. One tap -> structured entry -> optional voice note.
- **Free-form note:** "Add Note" for uncommon situations.
- **Pause button:** Shows "PAUSED" overlay when active. Session state preserved.
- **End Inspection:** Visible in top-left. Finalizes and navigates to summary.

### 2.7 Coverage Tracker Component (Waypoint-Style)

**New:** `mobile/src/components/CoverageTracker.tsx`

- Baseline angles treated as inspection waypoints — named anchor viewpoints (e.g., "Sink," "Stove," "Fridge," "Island," "Cabinets")
- Slim bar: room name, waypoint dots (filled/empty) with labels, overall %
- Green glow animation when a room reaches 100%
- **Directional hints** (subtle, delayed): Only trigger when ALL THREE conditions are true:
  1. Angle not captured
  2. User has been in room >10 seconds
  3. User appears to be exiting (heading toward doorway)
- Maximum 1 hint per room, only for high-priority waypoints, dismissible, hidden in `minimum` tier
- **Waypoint naming:** During training, each baseline image gets a short name. Auto-generated from AI analysis if not manually labeled.

### 2.8 Findings Panel Component

**New:** `mobile/src/components/FindingsPanel.tsx`

- Bottom sheet (`@gorhom/bottom-sheet`)
- Findings arrive as "Suggested" — actions per finding (human-in-the-loop):
  - **Confirm** — finding is real, persists to final report
  - **Dismiss** — false positive, logged but not in report
  - **Mute (session)** — suppress for rest of this inspection
  - **Mark as known condition** — adds to Property Condition Register, suppressed in future inspections
- Only confirmed findings persist to the final report
- **Finding state machine:** `suggested` -> `confirmed` -> `ticketed` -> `known_condition` -> `resolved`
- Findings >70% confidence: shown normally
- Findings <70% confidence: collapsed into "Review" section
- **Severity color coding:**

| Severity | Color | Description |
|----------|-------|-------------|
| `cosmetic` | Gray/blue | Minor visual issue |
| `maintenance` | Yellow | Routine maintenance needed |
| `safety` | Orange | Safety hazard, prompt attention |
| `urgent_repair` | Red | Immediate action needed |
| `guest_damage` | Purple | Potential guest damage, for claims |

- Tap a finding -> side-by-side review (baseline vs. current)
- Per-room grouping when expanded

### 2.9 Training Mode — Initial Property Mapping

The first visit is **mapping mode** (creating baselines), not inspection mode. This is a distinct UX flow.

**Training mode UX:**
- User selects "Add Property" or "Re-baseline Property"
- **Room setup:** Walk through and name each room/zone. App captures baseline images at key viewpoints.
- **Waypoint capture:** 3-5 images per room from different angles. Each capture becomes a named waypoint. App auto-suggests names using AI.
- **Quality feedback:** Real-time quality score (Laplacian variance). If blurry: "Hold steady — image is blurry." Rejects baselines below threshold.
- **Coverage guidance:** More active guidance than inspection mode — shows captured angles and suggests additional viewpoints.
- **Room completion:** Room shows as "trained" when minimum waypoints captured (3+). More waypoints = better accuracy.
- **Property completion:** All rooms trained -> property ready for inspection mode.
- **Uses the same camera screen** (2.6) in a dedicated training state: no comparison triggers, just waypoint capture + quality validation.
- **Repeatable:** Baseline re-capture for renovations, seasonal setup, etc. Creates a new baseline version.

### 2.10 Navigation & Other Screens

**New:** `mobile/src/screens/`
- `Login.tsx` — Supabase email/password auth
- `Properties.tsx` — List of trained properties
- `PropertyTraining.tsx` — Training mode screen (baseline capture flow)
- `InspectionStart.tsx` — Select property -> load baselines + embeddings -> select mode -> navigate to camera
- `InspectionCamera.tsx` — The HUD (serves both training and inspection modes)
- `InspectionSummary.tsx` — Post-inspection report

### 2.11 Inspection Completion Flow

When "End Inspection" is tapped:
1. Submit all room results via `POST /api/inspections/{id}/bulk`
2. Navigate to `InspectionSummary`:
   - Overall readiness score
   - Room-by-room scores + coverage %
   - Confirmed findings grouped by severity
   - Add notes per finding
   - "Complete Inspection" finalizes the record
   - Results visible in web dashboard

---

## 10. Phase 3: Smart Glasses Integration

With the "Silent Inspector" model and no overlay, glasses are a natural fit. The glasses record video while the phone processes in the pocket. The user gets **audio cues** instead of visual alerts.

### 3.1 BLE Service Layer
**New:** `mobile/src/lib/ble/ble-manager.ts`
- `react-native-ble-plx` for native BLE (iOS + Android)

### 3.2 Frame Driver
**New:** `mobile/src/lib/ble/frame-driver.ts`
- Service: `7a230001-5475-a6a4-654c-8431f6ad49c4`
- Lua command -> JPEG chunks -> reassemble

### 3.3 OpenGlass Driver
**New:** `mobile/src/lib/ble/openglass-driver.ts`
- Service: `19b10000-e8f2-537e-4f6c-d104768a1214`
- 200-byte chunks, `0xFFFF` end marker

### 3.4 Image Source Abstraction
**New:** `mobile/src/lib/image-source/`
- `types.ts` — `ImageSourceType = "camera" | "frame" | "openglass"`
- `use-camera-source.ts` — expo-camera
- `use-frame-source.ts` — Frame BLE
- `use-openglass-source.ts` — OpenGlass BLE

### 3.5 Audio Cues for Glasses Mode
**New:** `mobile/src/lib/audio/inspection-announcer.ts`
- Findings announced via TTS: "Alert: Faucet left on in guest bath"
- Coverage updates: "Kitchen 100% complete. Moving to hallway."
- Uses `expo-speech`

### 3.6 Device Picker
**New:** `mobile/src/components/DevicePicker.tsx`
- Phone Camera (default), scan for BLE glasses
- Connection status, battery level from glasses

### 3.7 Progressive Enhancement for Low-Res Glasses
- Glasses provide low-res frames for room detection + rough change detection
- If change flagged via glasses, comparison manager requests "detailed look" — user holds phone up for 4K capture
- Handles variable image quality gracefully

---

## 11. Phase 4: Product Features

> Next.js Web Dashboard — after mobile app works

### 4.1 Guest Damage Evidence Package + Post-Checkout Claim Mode

**New:** `src/app/api/inspections/[id]/damage-report/route.ts`
**New:** `src/components/inspection/damage-report.tsx`

- Auto-generate damage evidence package from confirmed `guest_damage` findings
- Per finding includes:
  - Baseline image (with baseline version ID)
  - Current capture image
  - Timestamp found + who confirmed it
  - Room name + location description
  - Whether previous inspection had the same issue
  - Whether a maintenance ticket already existed before guest arrival
  - Whether issue was a known condition (from Property Condition Register)
  - Repair estimate placeholder
  - Chain-of-custody metadata (inspection ID, inspector identity, inspection mode)
- Export as PDF for Airbnb/VRBO damage claims (Airbnb requires filing within 14 days of checkout)
- Side-by-side before/after with annotated damage description
- **Post-Checkout Claim Mode** (mobile app): In `turnover` mode shortly after checkout, the comparison manager automatically prioritizes `guest_damage` classification, stores full claim metadata, cross-references condition register, and tags findings as "claim-ready"

### 4.2 Automatic Maintenance Tickets

**New:** `src/app/api/maintenance/route.ts`
**New:** `server/schema.ts` — add `maintenanceTickets` table
**New:** `src/components/maintenance/ticket-list.tsx`

- When findings with severity `maintenance`/`safety`/`urgent_repair` are confirmed -> auto-generate maintenance ticket
- Ticket includes: property, room, description, severity, images, created from inspection
- Ticket states: `open` -> `assigned` -> `in_progress` -> `completed` -> `verified` (auto-verified on next inspection)

### 4.2a Maintenance Communication Gateway

**New:** `src/lib/comms/gateway.ts`
**New:** `src/app/api/comms/inbound/route.ts` — webhook for Twilio SMS/WhatsApp + inbound email
**New:** `src/lib/comms/message-parser.ts` — AI parsing of vendor messages

Vendors won't install your app. They communicate via text, email, and WhatsApp. Atria adapts to their behavior.

**How it works:**
1. Maintenance ticket created -> Atria sends vendor notification via preferred channel (SMS or email)
2. Vendor replies naturally — text, photo, email — to that same thread
3. AI parses reply into structured ticket update (status change, completion confirmation, photo proof)
4. Ticket updated automatically, `MaintenanceCompleted` event emitted

**Channels (priority order):**

| Channel | Phase | Details |
|---------|-------|---------|
| **SMS/MMS** (Twilio) | Phase B | Each ticket generates a Twilio thread. Vendor texts back updates + photos. ~$0.0075/message. |
| **Email** (SendGrid/Postmark) | Phase B | Reply address `ticket-3821@updates.atria.so`. Inbound parse webhook. |
| **WhatsApp** (Twilio) | Phase B+ | Same Twilio infrastructure. Requires WhatsApp Business API approval. |
| **Phone calls** | Deferred | PM logs a voice note after the call instead. |

**AI Message Parser:** Claude processes each inbound message — identifies ticket, extracts status update/completion/issues/photos, updates ticket state. Events: `VendorMessageReceived`, `TicketUpdated`, `MaintenanceCompleted`.

**Important:** Atria does NOT intercept the PM's actual phone/messages. Each ticket has its own dedicated communication thread.

### 4.2b Maintenance Schedule Profiles

**New:** `src/app/api/properties/[id]/maintenance-schedule/route.ts`
**New:** `src/components/property/maintenance-schedule.tsx`
**Modify:** `server/schema.ts` — add `maintenanceSchedules` table

Luxury homes have predictable maintenance cycles:

```
Aspen Lodge

Weekly:    Pool service, hot tub chemicals, trash removal
Monthly:   HVAC filter check, pest inspection, smart lock batteries
Quarterly: HVAC servicing, hot tub deep clean, chimney inspection
Annual:    Roof inspection, septic pumping, deck sealing, fire safety
```

- Auto-generates maintenance reminders and tickets on schedule
- Tracks completion via Communication Gateway or next inspection
- Overdue maintenance surfaces in Portfolio Dashboard action queue
- Templates: start with luxury property defaults, customize per property
- Proof of completion recorded in Property Assurance Ledger

### 4.3 Inspection History & Trends

**New:** `src/components/property/inspection-history.tsx`
- Timeline view of all inspections for a property
- Track recurring issues by room
- Damage trend charts
- Coverage trends

### 4.4 Portfolio Dashboard + Property Health Score

**New:** `src/app/dashboard/portfolio/page.tsx`
**New:** `src/components/dashboard/portfolio-overview.tsx`
**New:** `src/lib/scoring/property-health.ts`

The dashboard delivers **decisions, not data:**

```
Portfolio Summary

Inspections today: 12
Actions completed automatically: 17
Manager approvals needed: 2

+-------------------------------------+
| 1. Claim: Aspen Lodge               |
|    Marble countertop stain           |
|    Attribution confidence: 93%       |
|    Estimated recovery: $2,800        |
|    [Approve Claim]  [Review Details] |
|                                      |
| 2. Maintenance: Tahoe Retreat        |
|    Hot tub cover - recurring issue   |
|    Flagged 3x in 6 months            |
|    [Approve Replacement] [Defer]     |
+-------------------------------------+

Portfolio Health
Aspen Lodge     92  ##########
Tahoe Retreat   67  ######----  ! 3 open
Malibu Villa    95  ##########
```

- **Action queue is the primary view** — not property lists, not raw findings
- **"Actions completed automatically"** — shows value
- **Property Health Score (0-100):**
  - Unresolved findings count + severity (40%)
  - Open maintenance tickets + age (20%)
  - Recent inspection coverage tier (15%)
  - Damage frequency trend (15%)
  - Days since last inspection (10%)
- **Total manager time: 2 minutes** to review entire portfolio

### 4.5 Cleaner Accountability Reports

**New:** `src/components/inspection/accountability-report.tsx`
- Who inspected, when, duration, coverage % per room, completion tier
- Proof that the property was inspected
- Exportable for property owner/manager records

### 4.6 Insurance & Annual Documentation

**New:** `src/app/api/properties/[id]/annual-report/route.ts`
- Annual property condition reports from inspection history
- Condition documentation, maintenance records, damage history
- Useful for insurance requirements on luxury properties ($3M-$20M+)

### 4.7 Damage Attribution Engine (THE 10x FEATURE)

**New:** `src/lib/ai/damage-attribution.ts`
**New:** `src/app/api/inspections/[id]/attribution/route.ts`
**New:** `src/components/inspection/attribution-report.tsx`

This is the single most valuable feature. Luxury property managers' biggest financial pain point is **proving which guest caused damage.** Without clear evidence, they eat the cost ($500-$20,000+ per incident).

**How it works:**
```
Inspection timeline + Condition history + Guest stay windows
       |
When damage is detected, cross-reference:
  - Last inspection: June 10 - no damage detected
  - Current inspection: June 14 - damage detected
  - Guest stay: June 10-June 14
       |
Damage Attribution Confidence: 92%
"Damage likely occurred during this guest stay"
```

**The Damage Attribution Report includes:**
- Before image (baseline or last clean inspection) + After image (current)
- Timestamps and inspection IDs for both
- Inspector identity for both
- Previous inspection result (confirmed no damage)
- Guest stay dates + platform (Airbnb/VRBO/direct)
- Confidence score
- Location in property (room, specific area)
- Pre-existing condition check (from condition register)
- Existing maintenance ticket check
- Repair estimate placeholder
- Recommended action

**Guest Stay Integration:**
- Manual entry (Phase 1)
- Future: API integration with Airbnb, VRBO, Guesty, Hostaway

**Product positioning shift:**
- From: "AI-powered home inspection"
- To: **"Never lose a damage claim again"** / **"Prove exactly when damage happened"**

**Revenue math:** Even one recovered claim per property per year (avg $1,000-$5,000 in luxury) pays for itself many times over.

### 4.8 Property Memory System — The Property Assurance Ledger (THE RETENTION FLYWHEEL)

**New:** `src/app/properties/[id]/timeline/page.tsx`
**New:** `src/components/property/property-timeline.tsx`
**New:** `src/components/property/visual-memory.tsx`
**New:** `src/app/api/properties/[id]/timeline/route.ts`

This creates **near-zero churn**. Once managers have months of property memory, cancelling means losing years of accumulated intelligence. The software becomes **infrastructure**, not a tool.

**Property Assurance Ledger** — a unified chronological view of everything:
```
May 3  - Inspection (standard, turnover mode)
May 3  - Faucet issue detected, confirmed by Jane
May 4  - Maintenance ticket created
May 6  - Faucet repaired, ticket resolved
May 12 - Inspection (standard). No issues detected.
May 18 - Guest damage detected: marble countertop stain
May 18 - Damage attribution: Guest stay May 12-18, confidence 94%
May 19 - Claim filed with Airbnb
May 22 - Claim approved ($2,800)
Jun 1  - Baseline v3 created (post-renovation, manager-approved)
```

Everything searchable, filterable, exportable for owner reporting, insurance, legal.

**Visual Memory** — time-series visual history of every room:
```
Kitchen - June 2024 (baseline v1)
Kitchen - December 2024 (baseline v2, post-renovation)
Kitchen - April 2025 (inspection capture)
Kitchen - Today
```

- Managers scrub through time to see how the property changed
- Answers "was this already there?" instantly with visual proof

**Maintenance Intelligence** — pattern recognition from history:
- "Hot tub pump replaced twice in 12 months — recommend full replacement"
- "Kitchen faucet flagged 4 times in 6 months — chronic issue"
- "Guest damage frequency increased 40% at Tahoe Retreat this quarter"

**The Retention Math:**
- Year 1: helpful (inspection records, some history)
- Year 2: valuable (damage trends, maintenance patterns, claims history)
- Year 3: indispensable (deep property intelligence no one else has)
- Switching cost: losing years of property knowledge

### 4.9 Owner-Facing Trust Reports

**New:** `src/components/reports/owner-summary.tsx`
**New:** `src/app/api/properties/[id]/owner-report/route.ts`

- Owner-facing property condition summaries (separate from internal ops reports)
- Answers: Was my home checked? Was damage documented? Was anything off? Is it owner-ready?
- Exportable as PDF for periodic owner updates
- Tone: professional, trust-building, not technical

### 4.10 Guest Incident Intelligence — Conversational Triage Loop

**New:** `src/lib/ai/guest-incident.ts`
**New:** `src/app/api/incidents/route.ts`
**New:** `src/components/incidents/IncidentPanel.tsx`
**New:** `mobile/src/screens/NewIncident.tsx`

When guests report problems, the AI runs a **Conversational Triage Loop** — gathers context, reasons against property memory, prepares the right action.

**Triage Model — 3 paths:**

| Path | When | Behavior |
|------|------|----------|
| **Act now** | Enough evidence from message + property memory | Prepare action immediately |
| **Clarify briefly** | One question would materially improve confidence | Suggest question to manager |
| **Escalate immediately** | Urgent, emotional, safety-related, reputational | Alert manager, avoid AI back-and-forth |

**Incident State Machine:**
```
new -> triaging -> awaiting_guest_reply -> ready_for_recommendation
-> manager_review -> action_in_progress -> resolved | closed_no_issue
```

**Incident Types:**
- **Operational/mechanical** (hot tub, dishwasher, AC): 1-question clarification ideal
- **Safety/urgent** (gas smell, broken glass, water leak): No clarification — immediate urgent recommendation
- **Emotional/subjective** ("this place is dirty"): Escalate to manager quickly
- **Ambiguous nuisance** ("something seems off with the pool"): One clarifying question useful

**Clarification Budget (strict guardrails):**
- Maximum 1 clarifying question in most cases
- Maximum 2 only for low-risk ambiguous incidents
- No AI-led clarification for safety-critical or emotionally sensitive issues
- Never ask a question the guest already answered

**Example Flow:**
```
Guest: "The hot tub smells weird"
  -> AI checks: last inspection (2 hrs ago, clean), no open tickets,
     weekly service completed yesterday
  -> Decides: 1 clarifying question appropriate
  -> Suggests: "Thanks for letting us know. Is the water also cloudy
     or discolored, or mainly an odor?"
  -> Manager approves, sends

Guest: "It looks a little cloudy too"
  -> AI updates: signal_strength=high, likely=water chemistry imbalance
  -> Prepares: dispatch pool vendor + suggested guest reply + property context
  -> Manager: [Approve Dispatch] - one click
```

**Message Ingestion (phasing):**
- Phase B (launch): Manual incident creation
- Phase B+: Email forwarding to `incidents@atria.so`
- Phase C: PMS messaging integration (Guesty, Hostaway)

**New Event Types:**
```
GuestMessageReceived, GuestIssueDetected, ClarifyingQuestionSuggested,
ClarifyingQuestionSent, GuestReplyReceived, IncidentContextUpdated,
IncidentRecommendationPrepared, ManagerReplyApproved, IncidentEscalated,
IncidentResolved, IncidentClosedNoAction
```

### 4.11 Maintenance Forecasting + Complaint Prediction (Future)

- Detect patterns over time: frequent faucet issues, repeated wall damage, wear patterns
- Predict maintenance needs from historical data
- **Complaint prediction:** Cross-reference recurring issue + time since last service + upcoming guest arrival -> predict complaint probability
- The system shifts from **detecting problems** to **preventing problems**

---

## 12. Phase 5: Multi-Agent AI Architecture

The Operations Brain evolves into a **multi-agent architecture**. Instead of users pushing buttons, the system **perceives -> plans -> executes -> updates memory -> repeats**.

**Goal:** After an inspection, the manager sees:
```
Property AI Summary - Aspen Lodge

Inspection complete. Coverage: Standard.

- Faucet leak detected in guest bath
  -> Maintenance ticket created automatically

- Marble countertop stain detected
  -> Damage likely occurred during last guest stay
  -> Claim evidence prepared (awaiting your approval to file)

- Kitchen chair repeatedly moved
  -> Suppressed as normal repositioning

- Hot tub cover degradation trend
  -> Replacement recommended within 3 months

Manager action needed: 1 item (approve claim filing)
```

The manager doesn't analyze anything. The system already did the thinking.

### 5.0 Multi-Agent Architecture (Event-Driven)

```
+---------------------------------------------+
|           Operations Agent (Coordinator)      |
|  Subscribes to event stream, orchestrates     |
|  agents, surfaces conclusions to manager      |
+-------+------+------+------+------+----------+
|Inspect|Memory|Claims|Maint.|Owner | Feedback |
| Agent |Agent |Agent |Agent |Agent |  Agent   |
+-------+------+------+------+------+----------+
         ^      ^      ^      ^      ^
         +------+------+------+------+
              Event Stream (events table)
```

**Specialized Agents:**

| Agent | Subscribes To | Does |
|-------|---------------|------|
| **Inspection Agent** | Camera comparisons | Processes comparisons, outputs findings. Emits `FindingSuggested`. |
| **Property Memory Agent** | ALL property events | Maintains property knowledge graph. Tracks conditions, repairs, history. |
| **Claims Agent** | `FindingConfirmed` where `isClaimable=true` | Damage attribution, claim reports, evidence packages. |
| **Maintenance Agent** | `FindingConfirmed` where severity is maintenance+ | Manages tickets, tracks repair history, detects recurring patterns. |
| **Owner Agent** | `InspectionCompleted` | Owner summaries, property health reports, trust updates. |
| **Feedback Agent** | Feedback submission events | Processes user feedback, classifies issues. |

### Human-in-the-Loop: Where Humans MUST Stay in Control

**FULLY AUTOMATED (no human needed):**
- Recording inspection events and property timeline updates
- Auto-suppressing frequently dismissed finding types (with logged reasoning)
- Adjusting per-property confidence thresholds within safe bounds
- Generating inspection summaries and property health digests
- Creating inspection prep briefings
- Updating the property memory graph
- Classifying user feedback
- Recommending inspection mode for next visit

**HUMAN APPROVAL REQUIRED (suggest + wait):**
- Filing damage claims (false claim damages guest relationships)
- Sending owner reports (false finding causes panic)
- Scheduling vendors / spending money
- Baseline refresh
- Promoting findings to known conditions
- Prompt refinements that affect detection sensitivity

**ALWAYS HUMAN (never automate):**
- Final finding confirmation during inspection (Confirm/Dismiss/Mute)
- Insurance claim submissions
- Owner communication about significant property issues
- Property access decisions (granting keys, vendor access)

### 5.1 Per-Property Learning Engine

**New:** `src/lib/ai/operations-brain.ts`
**New:** `src/app/api/ai/operations/route.ts`

**Data prerequisite:** Needs 50-100+ inspections across multiple properties before meaningful patterns emerge. Do NOT build this before the data exists.

- **False positive learning:** If a finding type is dismissed >70% of the time, auto-suppress and log
- **Threshold calibration:** Adjust per-property similarity thresholds based on historical confirmation/dismissal rates
- **Baseline health monitoring:** Track deviation scores, suggest refresh when trending upward
- **Coverage pattern analysis:** Identify skipped angles/rooms, flag to ops manager
- **Seasonal pattern recognition:** Mountain property dust in spring, coastal salt in winter
- **User behavior patterns:** Adapt alert timing based on speed and confirmation rate

### 5.2 Automated Operations Actions

**New:** `src/lib/ai/operations-actions.ts`

| Category | Actions |
|----------|---------|
| **Auto-execute** | Suppress dismissed findings, adjust thresholds, generate digests, update memory graph, create prep briefings |
| **Suggest + wait** | File claim, send owner report, schedule vendor, refresh baseline, change prompt sensitivity |
| **Alert (urgent)** | Property health declining, critical maintenance trend, claim-worthy damage frequency increasing |

All auto-actions logged with reasoning and reversible.

### 5.3 Property Health Dashboard (AI-Powered)

**Modify:** `src/app/dashboard/portfolio/page.tsx`

Evolves Phase 4 dashboard from formula-based to AI-powered:
- AI-generated conclusions replace raw data
- Smarter action queue: prioritized by financial impact and urgency
- Proactive alerts: "3 properties have inspections due before weekend turnovers"
- Weekly email digest option

### 5.4 Smart Inspection Prep

**New:** `src/app/api/ai/inspection-prep/route.ts`

Before an inspection starts, the Operations Agent prepares a briefing:
- Known conditions to be aware of
- Recent maintenance tickets (resolved and open)
- Last inspection findings
- Seasonal alerts
- Recommended inspection mode based on context
- **Optimized scan path** (Phase C): Analyze historical movement patterns to suggest room order

### 5.5 Property Risk Profiles

After 6+ months and 50+ inspections per property:
```
Tahoe Retreat
Damage frequency: HIGH
Top causes: large groups, winter stays, hot tub usage
Claim history: 4 claims in 12 months ($8,200 total)
Recommendation: Increase security deposit, add pre-checkout walkthrough
```

### 5.6 AI Property Assistant (Natural Language Queries)

**New:** `src/lib/ai/property-assistant.ts`
**New:** `src/app/api/ai/assistant/route.ts`
**New:** `src/components/assistant/PropertyAssistant.tsx`
**New:** `mobile/src/components/PropertyAssistant.tsx`

- "Why is the hot tub broken at Aspen Lodge?" -> AI pulls event timeline, shows history, identifies root cause
- "Was this issue reported before?" -> searches property events
- "Did maintenance fix the hot tub?" -> checks ticket status + inspection verification
- "Which guest likely caused this damage?" -> runs attribution query
- Available in both web dashboard and mobile app

### 5.7 Continuous Expert Prompt Refinement

- Track which finding types are consistently accurate vs consistently dismissed
- Propose prompt adjustments (requires human sign-off for sensitivity changes)
- Prompt changes versioned and logged; can be rolled back

---

## 13. Phase 6: Developer Brain

An AI system that monitors the application for errors, diagnoses issues, and either fixes them automatically or creates actionable tickets. Goal: **reduce developer intervention to near-zero for routine issues.**

**Rollout strategy:** Start with monitoring + diagnosis ONLY (read-only). Add auto-fix after codebase stabilizes. Auto-fix PRs human-reviewed for first 3 months.

### 6.1 Error Monitoring + Auto-Diagnosis

**New:** `src/lib/ai/developer-brain.ts`
**New:** `src/app/api/ai/developer/route.ts`

Monitors: application error logs, mobile crash reports, AI comparison failures, performance degradation, database errors, failed uploads.

On error detection:
1. Analyze error context, stack trace, and recent changes
2. Cross-reference against codebase for root cause
3. Determine severity: `auto_fix` | `needs_review` | `critical_alert`

### 6.2 Automated Code Fixes

**New:** `src/lib/ai/auto-fixer.ts`

| Severity | Action |
|----------|--------|
| `auto_fix` | Generate fix, create PR, run tests, auto-merge if low-risk |
| `needs_review` | Create detailed ticket with root cause analysis and suggested fix |
| `critical_alert` | Immediate notification, auto-disable affected feature if needed |

### 6.3 Proactive Health Checks

- API endpoint response time trends
- Database query performance
- Storage usage and quota warnings
- AI API cost tracking and anomaly detection
- SSL certificate expiry, dependency vulnerabilities
- Weekly developer health report

### 6.4 Deployment Safety

- **Pre-deployment:** Analyze diff, run impact analysis, check for breaking mobile API changes
- **Post-deployment:** Watch error rates for 24 hours, auto-rollback trigger if threshold exceeded

---

## 14. Phase 7: User Feedback Brain

AI-powered support and product intelligence. Goal: **zero manual support ticket triage.**

### 7.1 In-App Feedback Collection

**New:** `mobile/src/components/FeedbackWidget.tsx`
**New:** `src/components/feedback/FeedbackWidget.tsx` (web)
**New:** `src/app/api/feedback/route.ts`

- Report a bug (with automatic screenshot/context capture)
- Request a feature
- Ask a question
- Rate inspection experience (1-5 stars + optional comment)
- Context automatically captured: current screen, inspection mode, property, device info, app version

### 7.2 AI Classification + Routing

**New:** `src/lib/ai/feedback-brain.ts`

| Classification | Urgency | Routing |
|---------------|---------|---------|
| `bug` | `immediate_fix` | Developer Brain for auto-diagnosis |
| `bug` | `next_sprint` | Developer ticket with context |
| `feature_request` | — | Product backlog with vote count |
| `question` | — | Auto-respond with help content if possible |
| `operational_issue` | — | Operations Brain for config adjustment |
| `praise` | — | Logged for team morale + analytics |

### 7.3 Product Intelligence

- Most requested features, common pain points
- Feature adoption metrics
- User satisfaction trends, churn risk indicators
- Monthly product intelligence report

### 7.4 Knowledge Base (Self-Building)

- Common questions automatically compiled into knowledge base
- Similar questions get auto-responded
- Grows organically from real user interactions

---

## 15. Real-World Edge Cases

### 1. Mirrors & Glass (Optical Illusions)
Floor-to-ceiling mirrors could cause false room switches. Glass tables may hide items.
- **Expert prompt:** "Ignore reflections in mirrors or glass surfaces. Be aware of transparent surfaces."
- **Room detector:** 5-frame hysteresis prevents brief mirror reflections from triggering room switch.

### 2. Changed Furniture / Missing Decor (Coverage Breakage)
If baseline had a specific rug and it's now gone, angle tracking may fail.
- **Do NOT auto-assume replacement.** Flag to user: "The living room looks significantly different from the baseline."
- **Anchor-based fallback:** If overall frame similarity is low (<0.7) but structural anchors (windows, door frames) still match, allow "scanned" but flag deviation.

### 3. Low Light / Motion Blur
Cleaning crews often work in dim conditions.
- **Luminance check:** Check frame brightness before comparison. If below threshold: "Low light detected — turn on lights."
- **Motion filter** already handles blur (IMU stillness check).

### 4. Network Latency (Basement / Rural)
4K upload in a basement could take 10-15 seconds.
- **Contextual findings:** Every finding includes room name, timestamp, and thumbnail.
- **Offline queue:** Queue comparison requests locally, process when connectivity returns.
- **Sync indicator:** Subtle "cloud" icon for pending uploads.

### 5. Featureless Rooms (White Box Trap)
Newly painted empty rooms — MobileCLIP may struggle to distinguish.
- **"Low confidence" UI state:** "Room uncertain — look at a door frame or window to help identify."
- Coverage tracking pauses until confidence regained.

### 6. Lens Distortion (Wide-Angle Warping)
Ultra-wide cameras warp edges.
- **Expert prompt:** "Ignore geometric warping at frame edges from wide-angle lens distortion."
- **MobileCLIP is robust** — semantic embeddings handle barrel distortion.

### 7. Repeated False Positives (The Coat-on-Door Problem)
Same finding flagged repeatedly becomes noise.
- **"Mute for this session"** option alongside Confirm/Dismiss.
- **Spatial dedup:** If identical finding + same room appears more than once, auto-collapse.

### 8. Privacy Pause (Glasses Mode)
People walking into frame may feel violated.
- **Quick-pause gesture:** Double-tap on glasses temple kills camera feed instantly.
- **Phone-only mode:** Pause button visible on phone screen.

### 9. Long Vacancy Periods (Seasonal Properties)
Luxury second homes may sit empty for weeks/months.
- **Vacancy tolerance in prompt:** Dust, cobwebs, seasonal debris NOT classified as damage unless severe.
- **Inspection metadata:** If >30 days since last inspection, AI applies higher tolerance.

### 10. Furniture Repositioning (Cleaning Crew Rearrangement)
Cleaners routinely move chairs, shift tables, rearrange pillows.
- **Object categorization** (1.1): Fixed vs. movable vs. decorative.
- Chair 2 feet from baseline = not a finding. Chair missing entirely = finding.

### 11. Owner Personalization (Baseline Drift)
Owners modify properties — seasonal decorations, new artwork, rugs.
- **Baseline versioning** (1.4): Multiple versions with labels.
- **Auto-refresh suggestion:** >30% deviation triggers suggestion.

### 12. Pets (Pet-Friendly Rentals)
Pet hair, nose prints, paw prints.
- **Expert prompt:** Differentiate temporary surface mess from permanent damage.
- **Cleaning flag:** Categorize as `cosmetic` with "cleaning needed" note.

### 13. Smart Home Systems (Dynamic States)
Control4, Savant, Crestron, Sonos, Nest, Lutron — screens off, lights changed, blinds moved.
- **Expert prompt:** Ignore dynamic smart home states.
- **Exception:** Physically damaged smart home devices ARE findings.

### 14. Outdoor Areas (Pool, Hot Tub, Patio)
- Outdoor zones trained with baselines like indoor rooms.
- Outdoor-specific checks: hot tub water/cover, pool debris, propane, broken furniture.
- Weather tolerance: distinguish normal outdoor weathering from damage.

### 15. Staging Differences (Photography/Sale Prep)
- Detect baseline mismatch but categorize as "staging difference," not damage.

### 16. Bystander Privacy (Faces in Frame)
- **On-device face blur:** Run lightweight face detector before upload. Blur detected faces on-device.
- **No PII uploaded:** Server never receives identifiable face data.

---

## 16. Operational Considerations

### User Profile
Inspections are performed by housekeeping teams, maintenance techs, property managers, and house managers. These users are under time pressure, not tech-focused, and sometimes temporary workers. They will not read instructions, will not manually categorize findings, and will not slow down.

### Inspection Speed
Turnover teams move at 10-30 seconds per room. Progressive completion tiers accommodate this reality. Fast-moving users still get value from `minimum` tier.

### Phone Fatigue & Capture Quality
Cleaners carry supplies, wear gloves, multitask.
- Phase 3 glasses address this directly
- Phone-only mode: lanyard or armband for hands-free scanning
- **Optional hardware recommendations:**
  - Phone gimbal ($80-$150, e.g., DJI Osmo Mobile) — improves stability, not required
  - 360 camera for baseline capture (Insta360 X3) — NOT for inspections (resolution too low), but excellent for initial property onboarding
  - Consider "Inspector Kit" as Phase B onboarding upsell

### False Positive Budget
Target: **>90% precision.** Object categorization, vacancy tolerance, pet tolerance, smart home awareness all reduce false positives. Human-in-the-loop is the safety net, but the goal is to rarely need "Dismiss."

### Baseline Drift
- Baseline versioning with labels
- Auto-refresh suggestion at >30% deviation
- Old versions preserved

### Connectivity
Many luxury homes have poor connectivity.
- **Offline inspection fully supported:** Room detection, coverage tracking, event logging all on-device
- **Offline queue:** Comparison requests queue locally
- **Sync indicator:** Subtle cloud icon for pending uploads

### Minimum Useful Success State
Even at minimum-tier inspection, the app MUST reliably deliver:
- Room/zone visit proof (timestamped)
- Walkthrough record (event log with rooms, duration, coverage)
- High-confidence exception shortlist (>90% precision)
- Claim-ready image pairs for major guest damage
- Suppression of known conditions
- Separation of restock items from findings
- Final readiness summary

If it cannot do this reliably in minimum mode, the app is too complex.

### QA Benchmarks — Critical Misses for V1
These must work reliably at launch:
- Faucet left on / running water
- Visible wall damage (holes, dents, large scratches)
- Broken glass
- Major stain (carpet, countertop, upholstery)
- Hot tub issue (cover off, water level, clarity)
- Broken blind/shade
- Stove/oven knob left on
- Exterior door/window security problem

### Decision Replacement Rate (DRR) — The Core Product Metric

> **What percentage of operational decisions does the system make for the property manager?**

**Possible decisions per inspection:**
1. Is maintenance required? -> auto-ticketed
2. Is this guest damage? Is it claimable? -> attribution calculated, evidence prepared
3. Is the property guest-ready? -> readiness score computed
4. Are restocks needed? -> restock list generated
5. Should the owner be notified? -> owner summary drafted
6. Is the baseline drifting? -> refresh suggested with evidence

| DRR | Product Outcome |
|-----|----------------|
| 10-20% | Nice tool — easily replaced |
| 30-40% | Useful SaaS |
| 50-60% | Core software |
| 70%+ | Operational infrastructure — removing it means hiring people |

**Target: 60-70% DRR.** Track DRR per property over time. Every feature must be evaluated against DRR.

### Operator Burden Metrics

Track alongside DRR:
- DRR per property (primary) + DRR trend over time
- Average confirmations/dismissals per inspection
- Muted findings rate
- Inspections by completion tier
- Time-to-first-finding review
- Percentage of zero-interaction inspections
- False positive rate by property, room type, user type
- **Manager time per inspection cycle** (target: <2 minutes)
- **Median inspection duration:**
  - `minimum`: 3-4 minutes
  - `standard`: 5-8 minutes
  - `thorough`: 10-12 minutes
- **Alert rate per inspection** (target: <3 alerts per property). Auto-flag chronic high-alert properties.

### User-Type Confidence Tuning
Analyze thresholds separately for:
- Housekeeping leads (speed-focused, high volume)
- Maintenance techs (issue-specific, detail-focused)
- Property managers (accountability-focused)
- House managers (presentation-focused, owner-facing)

### Stress Tests (Before Building Too Far)

| Test | Scenario | Success Criteria |
|------|----------|-----------------|
| **10-Minute Turnover** | 4-6 BR luxury home, one busy user, 10 min, weak Wi-Fi | Minimum tier complete, no over-alerting, room proof solid |
| **Housekeeper Test** | Person with no product background, normal turnover pace | Observe: do they understand haptics? Confirm/dismiss? |
| **Baseline Drift** | Changed art, rug, chairs; known scratch; depleted consumables; different lighting | No false damage flood, known conditions suppressed, restock separated |
| **Claim-Readiness** | After checkout: one new guest damage, one pre-existing, one known maintenance | App distinguishes all three. Evidence PDF is claim-ready. |
| **Owner-Arrival Perfection** | No guest damage, but poor staging, low stock, smart home oddity, subtle maintenance | Owner-arrival mode catches what matters |
| **"Ignored Phone" (MOST IMPORTANT)** | Give app to a cleaner, say "just clean normally." Mount on lanyard. | System STILL produces useful record even when completely ignored. |

---

## 17. Files Summary

### Backend Phase 1 (Next.js — 12 changes)

| Type | File | Description |
|------|------|-------------|
| New | `src/lib/vision/compare.ts` | Shared comparison logic + expert prompt |
| New | `src/app/api/vision/compare-stream/route.ts` | SSE endpoint |
| New | `src/app/api/embeddings/route.ts` | Embedding generation (onnxruntime-node) |
| New | `src/app/api/properties/[id]/baselines/route.ts` | Baseline version management + approval |
| New | `src/lib/events/emit.ts` | `emitEvent()` helper |
| New | `src/lib/events/types.ts` | TypeScript event type definitions |
| New | `src/app/api/properties/[id]/conditions/route.ts` | Property Condition Register CRUD |
| Modify | `server/schema.ts` | Events table, baseline versioning, embeddings, quality scores, severity, conditions, finding state machine, guest stays |
| Modify | `src/app/api/inspections/[id]/route.ts` | Shared compare, bulk endpoint, baselines endpoint |
| Modify | `src/app/api/vision/compare/route.ts` | Shared compare |
| Modify | `src/app/api/upload/route.ts` | Base64 path |
| Modify | `src/app/api/properties/[id]/train/route.ts` | Embeddings + quality gate + baseline versioning |

### Backend Phase 4 (Product Features)

| Type | File |
|------|------|
| New | `src/app/api/inspections/[id]/damage-report/route.ts` |
| New | `src/app/api/inspections/[id]/attribution/route.ts` |
| New | `src/lib/ai/damage-attribution.ts` |
| New | `src/components/inspection/attribution-report.tsx` |
| New | `src/app/api/properties/[id]/guest-stays/route.ts` |
| New | `src/app/properties/[id]/timeline/page.tsx` |
| New | `src/app/api/properties/[id]/timeline/route.ts` |
| New | `src/components/property/property-timeline.tsx` |
| New | `src/components/property/visual-memory.tsx` |
| New | `src/app/api/maintenance/route.ts` |
| New | `src/app/api/properties/[id]/annual-report/route.ts` |
| New | `src/app/api/properties/[id]/owner-report/route.ts` |
| New | `src/components/inspection/damage-report.tsx` |
| New | `src/components/maintenance/ticket-list.tsx` |
| New | `src/components/property/inspection-history.tsx` |
| New | `src/components/property/condition-register.tsx` |
| New | `src/components/reports/owner-summary.tsx` |
| New | `src/components/inspection/accountability-report.tsx` |
| New | `src/app/dashboard/portfolio/page.tsx` |
| New | `src/components/dashboard/portfolio-overview.tsx` |
| New | `src/lib/ai/guest-incident.ts` |
| New | `src/app/api/incidents/route.ts` |
| New | `src/components/incidents/IncidentPanel.tsx` |
| New | `src/lib/comms/gateway.ts` |
| New | `src/app/api/comms/inbound/route.ts` |
| New | `src/lib/comms/message-parser.ts` |
| New | `src/app/api/properties/[id]/maintenance-schedule/route.ts` |
| New | `src/components/property/maintenance-schedule.tsx` |
| New | `src/lib/scoring/property-health.ts` |
| Modify | `server/schema.ts` — add `maintenanceTickets`, `maintenanceSchedules` |

### AI Intelligence Layer (Phases 5-7)

| Phase | File |
|-------|------|
| 5 | `src/lib/ai/operations-brain.ts` |
| 5 | `src/app/api/ai/operations/route.ts` |
| 5 | `src/lib/ai/operations-actions.ts` |
| 5 | `src/app/api/ai/inspection-prep/route.ts` |
| 5 | `src/lib/ai/property-assistant.ts` |
| 5 | `src/app/api/ai/assistant/route.ts` |
| 5 | `src/components/assistant/PropertyAssistant.tsx` |
| 5 | `mobile/src/components/PropertyAssistant.tsx` |
| 6 | `src/lib/ai/developer-brain.ts` |
| 6 | `src/app/api/ai/developer/route.ts` |
| 6 | `src/lib/ai/auto-fixer.ts` |
| 7 | `src/lib/ai/feedback-brain.ts` |
| 7 | `src/app/api/feedback/route.ts` |
| 7 | `src/components/feedback/FeedbackWidget.tsx` |
| 7 | `mobile/src/components/FeedbackWidget.tsx` |
| 4 | `mobile/src/screens/NewIncident.tsx` |

### Mobile App (React Native — ~25 files)

| Phase | File |
|-------|------|
| 2 | `mobile/src/lib/api.ts` |
| 2 | `mobile/src/lib/supabase.ts` |
| 2 | `mobile/src/lib/vision/room-detector.ts` |
| 2 | `mobile/src/lib/vision/change-detector.ts` |
| 2 | `mobile/src/lib/sensors/motion-filter.ts` |
| 2 | `mobile/src/lib/vision/comparison-manager.ts` |
| 2 | `mobile/src/lib/inspection/session-manager.ts` |
| 2 | `mobile/src/screens/Login.tsx` |
| 2 | `mobile/src/screens/Properties.tsx` |
| 2 | `mobile/src/screens/PropertyTraining.tsx` |
| 2 | `mobile/src/screens/InspectionStart.tsx` |
| 2 | `mobile/src/screens/InspectionCamera.tsx` |
| 2 | `mobile/src/screens/InspectionSummary.tsx` |
| 2 | `mobile/src/components/CoverageTracker.tsx` |
| 2 | `mobile/src/components/FindingsPanel.tsx` |
| 3 | `mobile/src/lib/ble/ble-manager.ts` |
| 3 | `mobile/src/lib/ble/frame-driver.ts` |
| 3 | `mobile/src/lib/ble/openglass-driver.ts` |
| 3 | `mobile/src/lib/image-source/types.ts` |
| 3 | `mobile/src/lib/image-source/use-camera-source.ts` |
| 3 | `mobile/src/lib/image-source/use-frame-source.ts` |
| 3 | `mobile/src/lib/image-source/use-openglass-source.ts` |
| 3 | `mobile/src/lib/audio/inspection-announcer.ts` |
| 3 | `mobile/src/components/DevicePicker.tsx` |

### Dependencies

**Backend (add to existing package.json):**
- `onnxruntime-node` — server-side MobileCLIP embedding generation
- PDF generation library (`@react-pdf/renderer` or `puppeteer`)
- `twilio` — SMS/MMS/WhatsApp Communication Gateway

**Mobile App:**
- `expo`, `expo-camera`, `expo-sensors`, `expo-haptics`, `expo-speech`, `expo-image`, `expo-secure-store`
- `onnxruntime-react-native` — on-device MobileCLIP
- `react-native-ble-plx` — BLE for glasses
- `react-native-reanimated`, `react-native-gesture-handler`
- `@gorhom/bottom-sheet` — findings panel
- `@supabase/supabase-js`, `@react-navigation/native`
- `react-native-sse` or EventSource polyfill — SSE client
- `@react-native-ml-kit/face-detection` — on-device face blur

---

## 18. Implementation Order

### Phase A: Inspection Engine (Core — build first, prove it works)

```
Phase 1: Backend (can start immediately)
  1.0 EVENT-DRIVEN FOUNDATION:
      - Add append-only events table to schema
      - Create emitEvent() helper + TypeScript event types
      - All state-changing operations emit events
  1.1 Extract compare.ts + enhanced expert prompt
  1.2 SSE endpoint
  1.3 Embeddings API (onnxruntime-node)
  1.4 Schema: baseline versioning, embeddings, quality scores,
      severity, claims metadata, condition register, finding state machine
  1.5 Inspection API (baselines, bulk, event logging, conditions)
  1.6 Base64 upload
  -> TEST: existing web inspection still works, SSE returns results
     with severity, baseline versioning works, conditions suppress
     known issues, events table captures all state changes

Phase 2: Mobile App
  2.0 Expo project setup + EARLY PROTOTYPING:
      - SSE on real devices (test immediately, have polling fallback)
      - ONNX model performance + thermal (sustained 10+ min)
      - 4K burst with locked AE/AF
      - Face blur pipeline performance
  2.1 Auth + API layer
  2.2 Room detector + angle tracking + zone detection + outdoor
  2.3 Change detector + motion filter + luminance gate
  2.4 Comparison manager (cross-references condition register)
  2.5 Session manager (modes, progressive completion, event logging)
  2.6-2.9 UI screens + components
  2.10 End-to-end walk-through flow
  -> GATE: Run stress tests 1-5. Must pass "ignored phone test."
```

### Phase B: Operations Platform (build after inspection engine is proven)

```
Phase 3: Glasses (after mobile app works)
  3.1-3.3 BLE drivers
  3.4 Image source abstraction
  3.5 Audio cues
  3.6-3.7 Device picker + progressive enhancement
  -> TEST: connect glasses, walk through, audio alerts

Phase 4: Product Features (after inspection data is flowing)
  4.1 Guest damage evidence + post-checkout claim mode
  4.2 Automatic maintenance tickets
  4.2a COMMUNICATION GATEWAY
  4.2b MAINTENANCE SCHEDULE PROFILES
  4.3 Inspection history + trends
  4.4 Portfolio dashboard + Property Health Score
  4.5 Cleaner accountability reports
  4.6 Insurance / annual documentation
  4.7 DAMAGE ATTRIBUTION ENGINE (THE 10x FEATURE)
  4.8 PROPERTY MEMORY SYSTEM (THE RETENTION FLYWHEEL)
  4.9 Owner-facing trust reports
  4.10 GUEST INCIDENT INTELLIGENCE
  4.11 Property Condition Register UI
  4.12 In-app feedback collection
  -> GATE: Operators use it daily. FP rate <10%. Claims accepted
     by Airbnb/VRBO. Attribution accurate. Timeline coherent.
```

### Phase C: AI Learning Layer (needs 50-100+ inspections per property)

```
Phase 5: Operations Brain
  PREREQUISITE: 50-100+ inspections across multiple properties.
  5.1 Per-property learning engine
  5.2 Automated operations actions
  5.3 AI-powered property health dashboard
  5.4 Smart inspection prep briefings
  5.5 Property risk profiles
  5.6 AI PROPERTY ASSISTANT
  5.7 Continuous expert prompt refinement
  -> GATE: AI matches experienced PM decisions. Blind-test agreement.

Phase 7: User Feedback Brain
  7.1 AI classification + routing
  7.2 Product intelligence
  7.3 Self-building knowledge base
  -> TEST: bug -> classified -> routed correctly.
     Common question -> auto-responded from KB.
```

### Phase D: Automation / Autonomy (only after trust is established)

```
Phase 6: Developer Brain
  PREREQUISITE: Product stable, operators trust it, codebase mature.
  6.1 Error monitoring + auto-diagnosis (read-only first)
  6.2 Proactive health checks + weekly reports
  6.3 Automated code fixes (careful rollout)
  6.4 Deployment safety
  -> GATE: Auto-fixes human-reviewed for first 3 months.

Phase 5.5: Maintenance forecasting (needs 6+ months of data)
  -> Predict maintenance needs from trends
```

---

## 19. Verification Checklists

### Phase 1 Verification
- [ ] Every state change writes to append-only `events` table
- [ ] `SELECT * FROM events WHERE propertyId = X` returns complete timeline
- [ ] Train property -> embeddings + quality scores stored, baseline v1 created, event emitted
- [ ] Blurry baseline -> quality gate rejects, prompts retake
- [ ] Baseline v2 -> requires manager approval, labels reason, v1 preserved
- [ ] `compareImages` extraction: existing web inspection still works
- [ ] SSE endpoint: returns streamed events with findings including severity
- [ ] Expert prompt: movable furniture (no alert), pet hair (cosmetic/restock), smart home states (ignored), consumables (restock not damage)
- [ ] Property Condition Register: add known scratch -> subsequent inspections suppress it
- [ ] Finding with claims metadata: stores baselineImageId, confirmedBy, preExisting check

### Phase 2 Verification
- [ ] Login -> see trained properties -> tap one -> select mode -> "Start Inspection"
- [ ] Privacy disclosure shown on first use
- [ ] Camera opens full-screen with recording indicator
- [ ] Walk into open kitchen/living -> zone detection identifies zones
- [ ] Coarse coverage for adjacent zone; inspection-grade only when seeing specific objects
- [ ] Pan around kitchen -> angle dots fill up, green pulse per angle
- [ ] Stand still near stain -> burst capture -> haptic buzz -> finding with severity color
- [ ] Pre-existing known scratch -> auto-suppressed
- [ ] Actions: Confirm / Dismiss / Mute / Mark as known condition
- [ ] Fast walkthrough (10-30 sec/room) -> minimum tier recorded
- [ ] Walk to bathroom -> room switches, coverage bar updates
- [ ] Faucet left on -> urgent_repair finding, isClaimable: true, red + vibration
- [ ] Walk to patio -> outdoor zone detected, hot tub checked
- [ ] Pause -> "PAUSED" overlay, session preserved -> Resume
- [ ] Coverage target reached -> "Inspection Complete" prompt
- [ ] End -> summary: findings by severity, coverage per room, restock items
- [ ] Event log captures everything
- [ ] Results visible in web dashboard

### Phase 3 Verification
- [ ] Connect Brilliant Labs Frame via BLE
- [ ] Glasses capture snapshots -> room detection works
- [ ] Finding -> audio: "Alert: scratch on living room wall"
- [ ] Phone in pocket, hands-free walkthrough
- [ ] Double-tap temple -> camera paused instantly

### Phase 4 Verification
- [ ] Guest damage -> evidence PDF with before/after, timestamps, chain-of-custody
- [ ] System confirms pre-existing vs new damage
- [ ] PDF claim-ready for Airbnb Resolution Center
- [ ] Damage attribution: correct guest window identified with confidence score
- [ ] Maintenance ticket auto-created from confirmed finding
- [ ] Known recurring issue moves to condition register
- [ ] Restock items in separate list
- [ ] Portfolio view: all properties with scores, tickets, risk metrics
- [ ] Cleaner accountability report exportable
- [ ] Property timeline: unified chronological history
- [ ] Visual memory: scroll through room photos over time
- [ ] Owner report: professional PDF, exportable

### Phase 5 Verification
- [ ] After 10+ inspections: auto-suppress finding type dismissed >70%
- [ ] Baseline refresh suggestion when deviation trends upward
- [ ] Weekly property health digest
- [ ] Inspection briefing with known conditions, recent tickets, seasonal alerts

### Phase 6 Verification
- [ ] Simulated API error -> detected, analyzed, PR created or ticket filed
- [ ] Weekly health report generated
- [ ] Post-deployment monitoring catches regression within 24 hours

### Phase 7 Verification
- [ ] Bug submitted -> auto-classified -> routed correctly
- [ ] Common question -> auto-responded from knowledge base
- [ ] Feature request -> logged with vote count

---

## 20. Critical Logic Gates

| Component | Key Logic | Why It Matters |
|-----------|-----------|----------------|
| Room Detector | Cosine similarity > tunable threshold + 5-frame hysteresis | Prevents flicker, handles room-specific visual complexity |
| Doorway Handler | Multi-room buffering when top-2 rooms both score >35% | Tracks angles for both rooms at doorways |
| Motion Filter | IMU variance < threshold for >500ms before 4K capture | Prevents sending blurry frames that waste API tokens |
| Burst Capture | 2 frames 500ms apart with AE/AF LOCKED | Detects water/motion without false "flickering" from exposure changes |
| Dynamic Tiling | 1024x1024 crop + low-res context thumbnail | Claude needs spatial context to describe WHERE the issue is |
| Quality Gate | Laplacian variance on all baselines during training | Garbage in = garbage out. Blurry baselines break everything. |
| Coverage | Angle-based (per-baseline similarity), not time/entry based | Ensures every corner is inspected, not just doorways |
| Expert Prompt | The most critical piece — must be hyper-specific | If the prompt misses "water rings" or "flipped switches," the AI will too |
| Mirror/Glass Filter | Prompt tells Claude to ignore reflections | Prevents false "missing item" findings |
| Luminance Gate | Check frame brightness before comparison | Prevents wasting API tokens on dark/grainy images |
| Face Blur | On-device face detection + blur before upload | Privacy compliance — no PII leaves the device |
| Baseline Deviation | Flag changed decor to user, don't auto-assume | Accountability — user confirms/dismisses, logged in findings |
| Contextual Findings | Room name + timestamp + thumbnail per finding | User knows exactly where/when each issue was detected |

---

## Robustness & Technical Considerations

### Thermal Throttling & Battery
- **Adaptive inference:** 3fps -> 1fps when room is certain. Resume on motion.
- **Resolution switching:** 1080p preview, 4K only for comparison captures.
- **Battery estimate:** Show remaining inspection time in UI.

### Lighting Inconsistency
- **Multiple baselines:** Encourage lights-on + lights-off photos during training.
- **CLIP robustness:** Embeddings encode semantics, not pixel values — naturally handles lighting variation.
- **Prompt context:** Tell Claude to ignore lighting/shadow differences.

### AI Hallucination (False Positives)
- **Human-in-the-loop:** All findings are "Suggested" — Confirm or Dismiss.
- **Confidence threshold:** >70% shown normally, <70% in "Review" section.
- **Negative feedback:** Dismissed findings tracked for prompt refinement.

### Baseline Quality
- **Laplacian variance gate:** Reject blurry baseline images during training.
- **User guidance:** "Hold steady, ensure good lighting" prompts during capture.
- **Re-capture:** Flag low-quality baselines and prompt retake.

### Embedding Model Consistency (Critical)
Server and mobile MUST use the **exact same MobileCLIP-S0 ONNX model weights**. If there's any model version mismatch, cosine similarity scores are meaningless.
- **Solution:** ONNX format everywhere. Server loads via `onnxruntime-node`, mobile via `onnxruntime-react-native`. Same weights = identical embeddings.
- Store model version hash alongside embeddings. If model updated, flag old embeddings for regeneration.

### SSE Client in React Native
React Native's `fetch` does not natively support SSE. Use `react-native-sse` or an `EventSource` polyfill. Have polling fallback ready.

### Face Detection Library
`expo-face-detector` is deprecated in Expo SDK 52+. Use `react-native-vision-camera` with ML Kit plugin or `@react-native-ml-kit/face-detection`.

### Technical De-Risking (Prototype Early)

| Item | Risk | Mitigation |
|------|------|------------|
| SSE in React Native | May not work reliably on all devices | Test on real iOS + Android immediately. Have polling fallback. |
| ONNX on-device performance | Thermal throttling over 10+ min | Test MobileCLIP-S0 loading, inference time, thermal on iPhone 14+. Validate 30-80ms estimate. |
| 4K burst with locked AE/AF | More demanding than typical camera usage | Test `expo-camera` burst capture with locked exposure/focus. |
| Face blur pipeline | Must be fast — runs on every frame before upload | Validate `@react-native-ml-kit/face-detection` + image manipulation performance. |
| Open-plan zone credit | Could inflate coverage | Test two-layer model with real open-plan baselines. |
| Offline queue + sync | Timestamp accuracy across offline periods | Test queuing offline, bulk-syncing on reconnect. |

# Atria Inspection Execution Roadmap

## Purpose

This roadmap is the execution plan for evolving Atria from the current angle-guided walkthrough flow into a faster, more reliable, more automated inspection companion.

This is not a generic strategy memo. It is an implementation-oriented roadmap for the current codebase.

## Product North Star

Atria should help an inspector move through a property quickly and confidently while the system:

1. Understands what parts of the room have been meaningfully covered.
2. Detects missing, moved, broken, dirty, or changed items versus the baseline.
3. Surfaces only the most important guidance in the moment.
4. Learns from property-specific feedback over time.
5. Automates the post-inspection follow-up as much as possible.

The operator experience should feel like a calm copilot, not a gatekeeper.

## Core Design Principles

1. Coverage should be fast, forgiving, and mostly on-device.
2. Findings can be slower, richer, and more context-aware.
3. Property-specific memory is more important than online model retraining.
4. The system should combine multiple signals rather than betting everything on one technique.
5. Native iPhone app is the primary inspection client. Web is support/admin, not parity.

## Current Reality

### Working well today

- Angle-guided walkthrough coverage is much healthier than earlier iterations.
- Descriptive labels and final-view guidance now make the missing target understandable.
- Inspection modes are live end-to-end.
- Split-pipeline comparison flow is in place.
- Final-angle messaging has improved.
- Training from video is supported via extracted keyframes.

### Important limitations right now

- Final-angle acquisition is still the most common live bottleneck.
- Video keyframe extraction now does real sharpness scoring (`laplacianVariance`) with file-size fallback, but it still needs more on-device QA before it should be considered fully hardened.
- The new V2 modules exist, but most are not yet wired into the active `InspectionCamera` flow:
  - YOLO object detector
  - item confidence tracker
  - voice notes
- Batch scene analysis is only partially integrated:
  - current wiring still captures a second post-verify frame instead of reusing the verified one
  - current callback still risks attaching findings to the wrong room if the operator moves before the batch returns
  - end-of-inspection lifecycle still needs an explicit batch flush/pause decision
- Summary reload/history still does not persist detector-effective counts.
- Feedback memory is only partially implemented:
  - in-session dismissal suppression works
  - existing server-side known conditions are read and passed to compare
  - but dismiss/known-issue feedback is not yet persisted back to property conditions from mobile

## Recommended System Shape

Atria should be a hybrid inspection system with three layers:

### 1. Coverage Layer

Primary goal: know whether the operator has meaningfully covered the room.

Signals:

- room/area anchors
- visual place recognition
- final-angle targeting
- lightweight item presence as supporting evidence

This layer must be fast and low-friction.

### 2. Findings Layer

Primary goal: detect what changed or needs attention.

Signals:

- single-angle compare pipeline
- batch scene analysis across multiple views
- eventual object/item change reasoning
- user notes / voice notes

This layer can be slower than coverage, but must feel visible and trustworthy.

### 3. Memory / Automation Layer

Primary goal: reduce repeated false positives and automate follow-up.

Signals:

- finding confirmed / dismissed feedback
- known conditions
- repeated property-specific patterns
- recurring missed anchors

This layer should change behavior over time without requiring online model retraining.

## Roadmap

## NOW

These are the highest-leverage changes for the next implementation cycle.

### 1. Replace naive video keyframe selection with sharpness-scored selection

Why:

- Current walkthrough performance is still heavily constrained by baseline quality.
- Dense timestamp sampling helps, but it still keeps the first valid frames, not the best frames.
- Motion blur in training video is likely causing poor baseline embeddings and stubborn final angles.

What to build:

- Sample candidate timestamps across the full video duration.
- Score candidates for sharpness.
- Keep the sharpest, best-spread frames instead of first-come-first-served frames.
- Prefer temporal diversity so training does not keep near-duplicates.

Code entry points:

- `/Users/fin/.openclaw/workspace/TheEye/mobile/src/screens/PropertyTraining.tsx`
- `/Users/fin/.openclaw/workspace/TheEye/mobile/src/lib/api.ts`

Implementation notes:

- If native sharpness scoring is too heavy for the first pass, do a pragmatic JS scoring pass on downsized grayscale frames.
- A file-size proxy is acceptable only as a temporary fallback. The target end state is an image-space sharpness metric, not “largest JPEG wins.”
- The goal is not perfect CV ranking. The goal is “avoid blurry junk and preserve angle diversity.”
- Keep the current video-first workflow intact.

Success criteria:

- New training runs produce visibly sharper keyframes.
- Final-angle failure rate decreases on retrained properties.
- Baseline labels stay descriptive and tied to useful views.

### 2. Strengthen final-angle targeting bias

Why:

- The live UX is now good enough that the dominant failure mode is often “the app knows the target but still doesn’t credit it.”

What to build:

- When exactly one effective target remains:
  - bias candidate ranking toward that target
  - bias target-assist and preview behavior toward that target
  - slightly relax matching only within the confirmed room and only for that target
- Do not weaken trust globally.

Code entry points:

- `/Users/fin/.openclaw/workspace/TheEye/mobile/src/screens/InspectionCamera.tsx`
- `/Users/fin/.openclaw/workspace/TheEye/mobile/src/lib/vision/room-detector.ts`

Guardrails:

- Never apply the relaxed threshold outside final-angle mode.
- Never apply it cross-room.
- Log whether final-angle bias caused the credit.

Success criteria:

- Remaining `1 left` targets become meaningfully easier to capture.
- False-positive room completion does not increase.

### 3. Integrate batch scene analysis into the live inspection flow

Why:

- This is the best next V2 feature to wire in without replacing the current coverage model.
- It improves holistic findings detection without making the operator stop.

What to build:

- Keep current individual compare pipeline for fast per-view analysis.
- Add a sliding batch context pass:
  - every `N` captured views within a room, or
  - on room transition
- Use it to detect:
  - moved objects across views
  - missing items that require multiple views to judge
  - scene-level inconsistencies

Code entry points:

- `/Users/fin/.openclaw/workspace/TheEye/mobile/src/lib/vision/batch-analyzer.ts`
- `/Users/fin/.openclaw/workspace/TheEye/src/app/api/vision/batch-analyze/route.ts`
- `/Users/fin/.openclaw/workspace/TheEye/mobile/src/screens/InspectionCamera.tsx`

Guardrails:

- Respect backpressure.
- Batch frames should come from the already-captured verified frame path, not a second post-verify camera capture.
- Batch findings must be written back to `result.roomId`, not whatever room happens to be current when the callback arrives.
- Batch analyzer must pause/resume/flush with the inspection lifecycle.
- Make batch findings visibly distinct from per-view findings if needed.
- Do not block walkthrough coverage on batch completion.

Latest QA note:

- Treat this item as in progress until the implementation satisfies the three guardrails above in the live `InspectionCamera` path.

Success criteria:

- Findings appear that single-angle analysis misses.
- Walkthrough pacing remains smooth.
- No obvious network/backpressure regressions.

### 4. Build first-pass property feedback memory

Why:

- You need the system to get smarter from user feedback without risky online retraining.

What to build:

- Persist structured finding feedback:
  - confirmed
  - dismissed
  - dismissal reason
- Compute a `findingFingerprint`
- Use property-local suppression rules before surfacing repeated false positives

Code entry points:

- `/Users/fin/.openclaw/workspace/TheEye/mobile/src/lib/inspection/session-manager.ts`
- `/Users/fin/.openclaw/workspace/TheEye/src/app/api/inspections/[id]/bulk/route.ts`
- `/Users/fin/.openclaw/workspace/TheEye/src/lib/vision/compare.ts`

Guardrails:

- Do not retrain models online.
- Start property-local before any global suppression logic.
- Reading known conditions is not enough; the mobile inspection flow must persist dismiss/known-issue feedback back to the server if this item is to count as complete.

Latest QA note:

- The current implementation suppresses dismissed findings within the active inspection and updates local known-condition refs, but it does not yet write that feedback into the property conditions API for future inspections.

Success criteria:

- Repeat false positives are less likely to reappear on the same property.
- Known conditions can be muted cleanly.

## NEXT

These are the next major upgrades after the `NOW` work is stable.

### 5. Wire YOLO into inspection as supporting evidence, not primary truth

Why:

- On-device object detection is a useful assistive signal.
- It should help coverage guidance and findings confidence, but should not replace room/area coverage yet.

What to build:

- Load YOLO sequentially and safely alongside other mobile inference.
- Use detections to:
  - enrich target labels
  - support “what’s still needed” hints
  - assist batch/context analysis

Code entry points:

- `/Users/fin/.openclaw/workspace/TheEye/mobile/src/lib/vision/yolo-model.ts`
- `/Users/fin/.openclaw/workspace/TheEye/mobile/src/screens/InspectionCamera.tsx`

Guardrails:

- Do not block the main capture loop on object detection.
- Be conservative on device memory.

### 6. Integrate item tracker as a secondary coverage signal

Why:

- Item-based evidence is useful, but the current tracker should not replace angle/area completion by itself yet.

What to build:

- Use item confidence for:
  - confidence accumulation
  - “still needed” refinement
  - analytics and room completeness confidence

Code entry points:

- `/Users/fin/.openclaw/workspace/TheEye/mobile/src/lib/vision/item-tracker.ts`
- `/Users/fin/.openclaw/workspace/TheEye/mobile/src/screens/InspectionCamera.tsx`

Guardrails:

- Fix repeated-item over-credit before using it for completion.
- Treat item confidence as supporting evidence, not sole completion truth.

### 7. Add voice notes as optional operator augmentation

Why:

- Audio is useful, but should augment the workflow rather than become required.

What to build:

- Enable hands-free note capture
- Link notes to nearest captured frame / room state
- Keep the interaction lightweight

Code entry points:

- `/Users/fin/.openclaw/workspace/TheEye/mobile/src/lib/audio/voice-notes.ts`
- `/Users/fin/.openclaw/workspace/TheEye/mobile/src/screens/InspectionCamera.tsx`
- missing server endpoint:
  - `/api/vision/transcribe`

Guardrails:

- Do not block inspection if transcription is unavailable.
- Keep notes operator-controlled.

### 8. Persist detector-effective coverage into history/reload

Why:

- Live inspection and summary/history should agree.

What to build:

- Persist effective room counts and scanned counts at submit time
- Use those on reload instead of reconstructing from raw baselines

Code entry points:

- `/Users/fin/.openclaw/workspace/TheEye/mobile/src/screens/InspectionCamera.tsx`
- `/Users/fin/.openclaw/workspace/TheEye/src/app/api/inspections/[id]/bulk/route.ts`
- `/Users/fin/.openclaw/workspace/TheEye/mobile/src/screens/InspectionSummary.tsx`

## LATER

These are strategic upgrades after the hybrid system is stable.

### 9. Move toward scene-graph/object-change reasoning

Goal:

- detect changes independent of exact camera angle

Potential direction:

- object inventory + object relationships
- baseline graph vs current graph comparison
- multi-view consistency checks

This is likely the long-term direction for the findings layer.

### 10. Evolve from “angle required” to “area confidently covered”

Goal:

- reduce the remaining brittleness of angle-based completion

Potential direction:

- area anchors
- item evidence
- scene context
- final completion based on area confidence, not just discrete target count

### 11. Add nightly calibration / feedback analytics

Goal:

- continuously improve thresholds, prompt templates, and suppression rules

Potential outputs:

- recurring false positive patterns
- stubborn final baselines
- weak training-label patterns
- property-type-specific tuning

### 12. Add downstream automation lanes

Goal:

- convert findings into operational action automatically

Examples:

- damage / claim evidence
- maintenance ticket
- restock task
- presentation task

## Explicit Non-Goals For Now

Do not spend the next cycle on:

1. Building full inspection parity in the web app.
2. Replacing the current walkthrough with pure item-based completion.
3. Online model retraining from every user correction.
4. Large prompt-only attempts to solve fundamentally weak training data.

## Recommended Execution Order

Claude should execute in this order:

1. Sharpness-scored video keyframe selection
2. Final-angle targeting bias
3. Batch analyzer integration into `InspectionCamera`
4. Property-local feedback memory for findings
5. YOLO integration as supporting evidence
6. Item tracker integration after repeated-item safeguards
7. Voice note integration
8. Effective coverage persistence in history/reload

## Acceptance Gates

The `NOW` phase is successful when:

1. Retrained video properties produce sharper, more useful baselines.
2. Final-angle completion rate improves without new false positives.
3. Batch analysis finds real issues that single-angle compares miss.
4. Repeated false positives on the same property are reduced by feedback memory.

The `NEXT` phase is successful when:

1. YOLO and item signals improve guidance without destabilizing the walkthrough.
2. Voice notes feel optional and useful.
3. History/reload reflects the same effective coverage the user saw live.

## Code Map

### Current live walkthrough

- `/Users/fin/.openclaw/workspace/TheEye/mobile/src/screens/InspectionCamera.tsx`
- `/Users/fin/.openclaw/workspace/TheEye/mobile/src/lib/vision/room-detector.ts`
- `/Users/fin/.openclaw/workspace/TheEye/mobile/src/lib/vision/comparison-manager.ts`
- `/Users/fin/.openclaw/workspace/TheEye/src/app/api/vision/compare-stream/route.ts`

### Training quality

- `/Users/fin/.openclaw/workspace/TheEye/mobile/src/screens/PropertyTraining.tsx`
- `/Users/fin/.openclaw/workspace/TheEye/src/app/api/properties/[id]/train/route.ts`

### V2 modules staged for integration

- `/Users/fin/.openclaw/workspace/TheEye/mobile/src/lib/vision/yolo-model.ts`
- `/Users/fin/.openclaw/workspace/TheEye/mobile/src/lib/vision/item-tracker.ts`
- `/Users/fin/.openclaw/workspace/TheEye/mobile/src/lib/vision/batch-analyzer.ts`
- `/Users/fin/.openclaw/workspace/TheEye/src/app/api/vision/batch-analyze/route.ts`
- `/Users/fin/.openclaw/workspace/TheEye/mobile/src/lib/audio/voice-notes.ts`

### Memory / persistence / summary

- `/Users/fin/.openclaw/workspace/TheEye/mobile/src/lib/inspection/session-manager.ts`
- `/Users/fin/.openclaw/workspace/TheEye/src/app/api/inspections/[id]/bulk/route.ts`
- `/Users/fin/.openclaw/workspace/TheEye/mobile/src/screens/InspectionSummary.tsx`

## Final Recommendation

Stay on the current path, but think of the roadmap as:

- stabilize training quality first
- improve final-angle acquisition next
- integrate batch scene understanding before fully shifting completion logic
- treat object and item reasoning as additive evidence first
- make property memory a first-class system

That path best supports the actual goal:

Make inspections fast, low-friction, trustworthy, and increasingly automated without turning the operator into a camera technician.

/**
 * Item Contract Round-Trip Tests
 *
 * Verifies that normalize → edit → serialize → normalize round-trips
 * produce consistent results across all finding shapes.
 */

import {
  normalizeFindingFromServer,
  serializeDraftForServer,
  getItemTypeFromFinding,
  deriveCategory,
  createEmptyDraft,
  createDraftFromAiFinding,
  isTempId,
  type ServerFinding,
} from "../item-helpers";
import type { InspectionItemDraft } from "../item-types";

// ── Test Fixtures ──────────────────────────────────────────────────────

const FIXTURES: Record<string, ServerFinding> = {
  // 1. Legacy note with imageUrl only
  legacyNoteWithPhoto: {
    id: "fix-001",
    category: "manual_note",
    description: "Stain on carpet near entrance",
    severity: "maintenance",
    confidence: 1,
    source: "manual_note",
    status: "confirmed",
    createdAt: "2026-03-28T10:00:00Z",
    imageUrl: "https://storage.example.com/photo1.jpg",
  },

  // 2. Legacy note with videoUrl only
  legacyNoteWithVideo: {
    id: "fix-002",
    category: "manual_note",
    description: "Water dripping from faucet",
    severity: "urgent_repair",
    confidence: 1,
    source: "manual_note",
    status: "confirmed",
    createdAt: "2026-03-28T11:00:00Z",
    videoUrl: "https://storage.example.com/video1.mp4",
  },

  // 3. Typed restock item with quantity + supply link
  typedRestock: {
    id: "fix-003",
    category: "restock",
    description: "Guest bath soap low — 2 needed",
    severity: "cosmetic",
    confidence: 1,
    source: "manual_note",
    status: "confirmed",
    itemType: "restock",
    restockQuantity: 2,
    supplyItemId: "supply-abc-123",
    createdAt: "2026-03-28T12:00:00Z",
  },

  // 4. Maintenance item with multiple evidenceItems
  maintenanceWithEvidence: {
    id: "fix-004",
    category: "operational",
    description: "Broken cabinet hinge in kitchen",
    severity: "maintenance",
    confidence: 0.92,
    source: "ai",
    status: "confirmed",
    itemType: "maintenance",
    createdAt: "2026-03-28T13:00:00Z",
    evidenceItems: [
      {
        id: "ev-001",
        kind: "photo",
        url: "https://storage.example.com/photo2.jpg",
        uploadState: "uploaded",
        createdAt: "2026-03-28T13:01:00Z",
      },
      {
        id: "ev-002",
        kind: "photo",
        url: "https://storage.example.com/photo3.jpg",
        uploadState: "uploaded",
        createdAt: "2026-03-28T13:02:00Z",
      },
      {
        id: "ev-003",
        kind: "video",
        url: "https://storage.example.com/video2.mp4",
        durationMs: 15000,
        uploadState: "uploaded",
        createdAt: "2026-03-28T13:03:00Z",
      },
    ],
  },

  // 5. AI finding converted to manual action item
  aiConvertedToAction: {
    id: "fix-005",
    category: "cleanliness",
    description: "Towels appear used in guest bathroom",
    severity: "cosmetic",
    confidence: 0.87,
    source: "manual_note",
    status: "confirmed",
    itemType: "task",
    derivedFromFindingId: "ai-finding-xyz",
    derivedFromComparisonId: "comp-abc-123",
    origin: "ai_prompt_accept",
    createdAt: "2026-03-28T14:00:00Z",
  },

  // 6. Finding with no media
  noMedia: {
    id: "fix-006",
    category: "presentation",
    description: "Pillows misaligned on sofa",
    severity: "cosmetic",
    confidence: 0.65,
    source: "ai",
    status: "confirmed",
    createdAt: "2026-03-28T15:00:00Z",
  },

  // 7. Finding with BOTH legacy fields AND evidenceItems
  bothLegacyAndNew: {
    id: "fix-007",
    category: "damage",
    description: "Scratch on dining table",
    severity: "guest_damage",
    confidence: 0.95,
    source: "ai",
    status: "confirmed",
    imageUrl: "https://storage.example.com/legacy-photo.jpg",
    videoUrl: "https://storage.example.com/legacy-video.mp4",
    evidenceItems: [
      {
        id: "ev-010",
        kind: "photo",
        url: "https://storage.example.com/new-photo.jpg",
        uploadState: "uploaded",
        createdAt: "2026-03-28T16:00:00Z",
      },
    ],
    createdAt: "2026-03-28T16:00:00Z",
  },
};

// ── Round-Trip Tests ───────────────────────────────────────────────────

describe("Item Contract Round-Trip", () => {
  Object.entries(FIXTURES).forEach(([name, fixture]) => {
    it(`round-trips ${name}`, () => {
      // Normalize from server
      const draft = normalizeFindingFromServer(fixture, {
        roomId: "room-1",
        roomName: "Living Room",
      });

      // Draft should have valid shape
      expect(draft.id).toBeTruthy();
      expect(draft.itemType).toBeTruthy();
      expect(draft.description).toBe(fixture.description || "");
      expect(draft.source).toMatch(/^(manual_note|ai)$/);
      expect(draft.origin).toMatch(/^(manual|ai_prompt_accept|template)$/);

      // Serialize back to server format
      const serverPayload = serializeDraftForServer(draft);
      expect(serverPayload.description).toBe(draft.description);
      expect(serverPayload.severity).toBe(draft.severity);
      expect(serverPayload.itemType).toBe(draft.itemType);

      // Re-normalize should produce consistent result
      const roundTripped = normalizeFindingFromServer(
        serverPayload as unknown as ServerFinding,
        { roomId: "room-1", roomName: "Living Room" },
      );

      expect(roundTripped.description).toBe(draft.description);
      expect(roundTripped.severity).toBe(draft.severity);
      expect(roundTripped.itemType).toBe(draft.itemType);
      expect(roundTripped.category).toBe(draft.category);
    });
  });
});

// ── Legacy Evidence Normalization ──────────────────────────────────────

describe("Legacy Evidence Normalization", () => {
  it("converts imageUrl to one photo attachment", () => {
    const draft = normalizeFindingFromServer(FIXTURES.legacyNoteWithPhoto);
    expect(draft.attachments).toHaveLength(1);
    expect(draft.attachments[0].kind).toBe("photo");
    expect(draft.attachments[0].url).toBe("https://storage.example.com/photo1.jpg");
    expect(draft.attachments[0].uploadState).toBe("uploaded");
  });

  it("converts videoUrl to one video attachment", () => {
    const draft = normalizeFindingFromServer(FIXTURES.legacyNoteWithVideo);
    expect(draft.attachments).toHaveLength(1);
    expect(draft.attachments[0].kind).toBe("video");
    expect(draft.attachments[0].url).toBe("https://storage.example.com/video1.mp4");
  });

  it("prefers evidenceItems[] over legacy fields when both present", () => {
    const draft = normalizeFindingFromServer(FIXTURES.bothLegacyAndNew);
    // Should use evidenceItems, not legacy imageUrl/videoUrl
    expect(draft.attachments).toHaveLength(1);
    expect(draft.attachments[0].url).toBe("https://storage.example.com/new-photo.jpg");
  });

  it("handles no media gracefully", () => {
    const draft = normalizeFindingFromServer(FIXTURES.noMedia);
    expect(draft.attachments).toHaveLength(0);
  });

  it("preserves multiple evidenceItems", () => {
    const draft = normalizeFindingFromServer(FIXTURES.maintenanceWithEvidence);
    expect(draft.attachments).toHaveLength(3);
    expect(draft.attachments.filter((a) => a.kind === "photo")).toHaveLength(2);
    expect(draft.attachments.filter((a) => a.kind === "video")).toHaveLength(1);
    expect(draft.attachments[2].durationMs).toBe(15000);
  });
});

// ── Serialize Backfill Tests ───────────────────────────────────────────

describe("Serialize Backfill", () => {
  it("backfills imageUrl from first photo attachment", () => {
    const draft = normalizeFindingFromServer(FIXTURES.maintenanceWithEvidence);
    const payload = serializeDraftForServer(draft);
    expect(payload.imageUrl).toBe("https://storage.example.com/photo2.jpg");
    expect(payload.videoUrl).toBe("https://storage.example.com/video2.mp4");
  });

  it("sets imageUrl/videoUrl to null when no attachments", () => {
    const draft = normalizeFindingFromServer(FIXTURES.noMedia);
    const payload = serializeDraftForServer(draft);
    expect(payload.imageUrl).toBeNull();
    expect(payload.videoUrl).toBeNull();
  });
});

// ── ItemType Inference ─────────────────────────────────────────────────

describe("getItemTypeFromFinding", () => {
  it("returns explicit itemType when present", () => {
    expect(getItemTypeFromFinding({ itemType: "restock" })).toBe("restock");
    expect(getItemTypeFromFinding({ itemType: "task" })).toBe("task");
  });

  it("infers from category when itemType missing", () => {
    expect(getItemTypeFromFinding({ category: "restock" })).toBe("restock");
    expect(getItemTypeFromFinding({ category: "operational" })).toBe("maintenance");
    expect(getItemTypeFromFinding({ category: "safety" })).toBe("maintenance");
    expect(getItemTypeFromFinding({ category: "manual_note" })).toBe("note");
    expect(getItemTypeFromFinding({ category: "missing" })).toBe("restock");
    expect(getItemTypeFromFinding({ category: "damage" })).toBe("maintenance");
    expect(getItemTypeFromFinding({ category: "cleanliness" })).toBe("maintenance");
  });

  it("defaults to note when nothing recognizable", () => {
    expect(getItemTypeFromFinding({})).toBe("note");
    expect(getItemTypeFromFinding({ category: "unknown_cat" })).toBe("note");
  });
});

// ── Category Derivation ────────────────────────────────────────────────

describe("deriveCategory", () => {
  it("maps itemType to correct default category", () => {
    expect(deriveCategory("restock")).toBe("restock");
    expect(deriveCategory("maintenance")).toBe("operational");
    expect(deriveCategory("task")).toBe("manual_note");
    expect(deriveCategory("note")).toBe("manual_note");
  });
});

// ── Empty Draft Creation ───────────────────────────────────────────────

describe("createEmptyDraft", () => {
  it("creates draft with correct defaults", () => {
    const draft = createEmptyDraft("restock", { roomId: "r1", roomName: "Kitchen" });
    expect(draft.itemType).toBe("restock");
    expect(draft.category).toBe("restock");
    expect(draft.severity).toBe("maintenance");
    expect(draft.source).toBe("manual_note");
    expect(draft.origin).toBe("manual");
    expect(draft.attachments).toHaveLength(0);
    expect(draft.roomId).toBe("r1");
    expect(draft.roomName).toBe("Kitchen");
    expect(isTempId(draft.id)).toBe(true);
  });
});

// ── AI-to-Action Conversion ────────────────────────────────────────────

describe("createDraftFromAiFinding", () => {
  it("creates new draft with provenance from AI finding", () => {
    const aiFinding: ServerFinding = {
      id: "ai-finding-123",
      category: "cleanliness",
      description: "Low soap in guest bath",
      severity: "cosmetic",
      confidence: 0.91,
      source: "ai",
    };

    const draft = createDraftFromAiFinding(aiFinding, "restock", {
      roomId: "r2",
      roomName: "Guest Bath",
    });

    expect(draft.itemType).toBe("restock");
    expect(draft.category).toBe("restock"); // derived from target type
    expect(draft.description).toBe("Low soap in guest bath");
    expect(draft.source).toBe("manual_note");
    expect(draft.origin).toBe("ai_prompt_accept");
    expect(draft.derivedFromFindingId).toBe("ai-finding-123");
    expect(isTempId(draft.id)).toBe(true);
    expect(draft.id).not.toBe("ai-finding-123"); // new ID, not mutating original
  });
});

// ── Provenance Preservation ────────────────────────────────────────────

describe("Provenance", () => {
  it("preserves derivedFromFindingId through round-trip", () => {
    const draft = normalizeFindingFromServer(FIXTURES.aiConvertedToAction);
    expect(draft.derivedFromFindingId).toBe("ai-finding-xyz");
    expect(draft.derivedFromComparisonId).toBe("comp-abc-123");
    expect(draft.origin).toBe("ai_prompt_accept");

    const serialized = serializeDraftForServer(draft);
    expect(serialized.derivedFromFindingId).toBe("ai-finding-xyz");
    expect(serialized.derivedFromComparisonId).toBe("comp-abc-123");
    expect(serialized.origin).toBe("ai_prompt_accept");
  });
});

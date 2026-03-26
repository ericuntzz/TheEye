/**
 * Item Tracker — Confidence Accumulator for Item-Based Coverage
 *
 * Tracks detected objects across multiple frames and accumulates confidence
 * that each expected item in a room has been seen. This replaces the
 * angle-based coverage model with an item-based one.
 *
 * Design principles:
 * - Partial views accumulate evidence (no single frame needs to be perfect)
 * - Item confidence decays slightly over time (recent sightings worth more)
 * - Coverage = items verified / total expected items
 * - Works alongside YOLO detection + MobileCLIP room detection
 */

/** Four-class inventory doctrine from technical architecture */
export type InventoryClass = "fixed_structural" | "durable_movable" | "decorative" | "consumable";

export interface ExpectedItem {
  id: string;
  name: string;
  category: string; // furniture, decor, appliance, fixture, etc.
  /** Four-class inventory doctrine — drives alert routing */
  inventoryClass: InventoryClass;
  importance: "critical" | "high" | "normal" | "low";
  roomId: string;
  /** Optional: specific COCO class name(s) that match this item */
  cocoClasses?: string[];
}

/** Map COCO classes to inventory doctrine classes */
export const COCO_TO_INVENTORY_CLASS: Record<string, InventoryClass> = {
  // Fixed/structural — deviations ALWAYS trigger alerts
  "refrigerator": "fixed_structural",
  "oven": "fixed_structural",
  "microwave": "fixed_structural",
  "sink": "fixed_structural",
  "toilet": "fixed_structural",
  "tv": "fixed_structural",
  "toaster": "fixed_structural",
  // Durable movable — tolerance for repositioning
  "chair": "durable_movable",
  "couch": "durable_movable",
  "bed": "durable_movable",
  "dining table": "durable_movable",
  "laptop": "durable_movable",
  "remote": "durable_movable",
  "keyboard": "durable_movable",
  "cell phone": "durable_movable",
  // Decorative — high tolerance, only alert if completely absent
  "potted plant": "decorative",
  "clock": "decorative",
  "vase": "decorative",
  "teddy bear": "decorative",
  "book": "decorative",
  // Consumables — route to restock lane, not condition
  "bottle": "consumable",
  "cup": "consumable",
  "wine glass": "consumable",
  "toothbrush": "consumable",
  "hair drier": "consumable",
};

export interface ItemConfidence {
  itemId: string;
  confidence: number; // 0-1, accumulated across frames
  framesSeen: number;
  lastSeenAt: number;
  bestConfidence: number; // highest single-frame confidence
  verified: boolean; // confidence >= threshold
}

export interface ItemCoverageResult {
  roomId: string;
  verified: number;
  total: number;
  percentage: number;
  items: ItemConfidence[];
  unverifiedItems: ExpectedItem[];
}

const VERIFICATION_THRESHOLD = 0.70; // accumulated confidence to mark verified
const CONFIDENCE_PER_DETECTION = 0.25; // each YOLO detection adds this much
const CONFIDENCE_DECAY_RATE = 0.995; // per-frame decay (very gentle — takes ~140 frames to halve)
const MAX_CONFIDENCE = 1.0;

/**
 * Maps COCO class names to common property item categories.
 * Used when matching YOLO detections to expected items.
 */
const COCO_TO_PROPERTY_MAP: Record<string, string[]> = {
  "chair": ["chair", "recliner", "armchair", "reading chair", "dining chair", "office chair"],
  "couch": ["sofa", "couch", "loveseat", "sectional"],
  "bed": ["bed", "mattress", "bunk"],
  "dining table": ["dining table", "kitchen table", "table"],
  "tv": ["tv", "television", "monitor", "screen", "display"],
  "laptop": ["laptop", "computer", "macbook"],
  "refrigerator": ["refrigerator", "fridge"],
  "oven": ["oven", "stove", "range"],
  "microwave": ["microwave"],
  "sink": ["sink", "basin"],
  "toilet": ["toilet"],
  "potted plant": ["plant", "potted plant", "flower", "planter"],
  "book": ["book", "books", "bookshelf", "book collection"],
  "clock": ["clock", "wall clock"],
  "vase": ["vase", "decorative vase"],
  "bottle": ["bottle", "wine bottle", "water bottle"],
  "cup": ["cup", "mug", "glass"],
  "remote": ["remote", "remote control"],
  "toothbrush": ["toothbrush"],
  "hair drier": ["hair dryer", "blow dryer"],
  "cell phone": ["phone", "cell phone", "iphone", "smartphone", "mobile"],
  "keyboard": ["keyboard"],
  "teddy bear": ["teddy bear", "stuffed animal", "plush"],
  "wine glass": ["wine glass", "champagne glass", "stemware", "goblet"],
  "toaster": ["toaster"],
};

/** Event callback for integration with event-driven architecture */
export type ItemEventCallback = (event: {
  eventType: "item_verified" | "item_coverage_milestone";
  roomId: string;
  itemId?: string;
  itemName?: string;
  inventoryClass?: InventoryClass;
  coverage?: number;
  metadata?: Record<string, unknown>;
}) => void;

export type ItemCompletionTier = "not_started" | "minimum" | "standard" | "thorough";
export type CompletionTier = ItemCompletionTier;

export class ItemTracker {
  private expectedItems: Map<string, ExpectedItem[]> = new Map();
  private confidence: Map<string, ItemConfidence> = new Map();
  private onEvent: ItemEventCallback | null = null;

  /** Register event callback for event-driven architecture integration */
  setEventCallback(callback: ItemEventCallback): void {
    this.onEvent = callback;
  }

  /**
   * Load expected items for a property from the training inventory.
   */
  loadExpectedItems(items: ExpectedItem[]): void {
    this.expectedItems.clear();
    this.confidence.clear();

    for (const item of items) {
      const roomItems = this.expectedItems.get(item.roomId) || [];
      roomItems.push(item);
      this.expectedItems.set(item.roomId, roomItems);

      this.confidence.set(item.id, {
        itemId: item.id,
        confidence: 0,
        framesSeen: 0,
        lastSeenAt: 0,
        bestConfidence: 0,
        verified: false,
      });
    }
  }

  /**
   * Process YOLO detections for a frame and accumulate confidence.
   * Returns which items gained confidence this frame.
   */
  processDetections(
    roomId: string,
    detections: Array<{ className: string; confidence: number }>,
    timestamp: number = Date.now(),
  ): string[] {
    const roomItems = this.expectedItems.get(roomId);
    if (!roomItems || roomItems.length === 0) return [];

    const gainedConfidence: string[] = [];

    // Apply slight decay to all room items (recency weighting)
    for (const item of roomItems) {
      const conf = this.confidence.get(item.id);
      if (conf && !conf.verified) {
        conf.confidence *= CONFIDENCE_DECAY_RATE;
      }
    }

    // Match detections to expected items.
    // IMPORTANT: Each detection only boosts ONE expected item (the least-verified
    // unverified match). This prevents one chair detection from advancing
    // multiple "chair" entries simultaneously and over-completing rooms.
    const boostedThisFrame = new Set<string>();
    for (const detection of detections) {
      const matchedItems = this.findMatchingItems(roomId, detection.className);

      // Pick the single best target: lowest confidence among unverified, unboosted matches
      const candidates = matchedItems
        .filter(item => {
          const conf = this.confidence.get(item.id);
          return conf && !conf.verified && !boostedThisFrame.has(item.id);
        })
        .sort((a, b) => {
          const ca = this.confidence.get(a.id)?.confidence ?? 0;
          const cb = this.confidence.get(b.id)?.confidence ?? 0;
          return ca - cb; // lowest confidence first
        });

      const item = candidates[0];
      if (!item) continue;
      boostedThisFrame.add(item.id);

      {
        const conf = this.confidence.get(item.id)!;

        // Accumulate confidence weighted by detection confidence
        const gain = CONFIDENCE_PER_DETECTION * detection.confidence;
        conf.confidence = Math.min(MAX_CONFIDENCE, conf.confidence + gain);
        conf.framesSeen++;
        conf.lastSeenAt = timestamp;
        conf.bestConfidence = Math.max(conf.bestConfidence, detection.confidence);

        // Check verification threshold
        if (conf.confidence >= VERIFICATION_THRESHOLD) {
          conf.verified = true;
          gainedConfidence.push(item.id);

          // Emit event for event-driven architecture (try/catch to not crash detection loop)
          try {
            this.onEvent?.({
              eventType: "item_verified",
              roomId,
              itemId: item.id,
              itemName: item.name,
              inventoryClass: item.inventoryClass,
              metadata: {
                confidence: conf.confidence,
                framesSeen: conf.framesSeen,
                bestConfidence: conf.bestConfidence,
              },
            });
          } catch (eventErr) {
            console.warn("[ItemTracker] Event callback error:", eventErr);
          }
        }
      }
    }

    return gainedConfidence;  // eslint-disable-line -- end of processDetections
  }

  /**
   * Get coverage for a specific room.
   */
  getRoomCoverage(roomId: string): ItemCoverageResult {
    const roomItems = this.expectedItems.get(roomId) || [];
    const items = roomItems.map(
      (item) => this.confidence.get(item.id) || {
        itemId: item.id,
        confidence: 0,
        framesSeen: 0,
        lastSeenAt: 0,
        bestConfidence: 0,
        verified: false,
      },
    );

    const verified = items.filter((i) => i.verified).length;
    const total = roomItems.length;

    return {
      roomId,
      verified,
      total,
      percentage: total > 0 ? Math.round((verified / total) * 100) : 0,
      items,
      unverifiedItems: roomItems.filter(
        (item) => !this.confidence.get(item.id)?.verified,
      ),
    };
  }

  /**
   * Get overall coverage across all rooms.
   */
  getOverallCoverage(): { verified: number; total: number; percentage: number } {
    let totalVerified = 0;
    let totalItems = 0;

    for (const [roomId] of this.expectedItems) {
      const coverage = this.getRoomCoverage(roomId);
      totalVerified += coverage.verified;
      totalItems += coverage.total;
    }

    return {
      verified: totalVerified,
      total: totalItems,
      percentage: totalItems > 0 ? Math.round((totalVerified / totalItems) * 100) : 0,
    };
  }

  /**
   * Get completion tier for a room (progressive completion per tech architecture).
   * minimum: at least 1 critical/high item verified
   * standard: 60%+ items verified
   * thorough: 100% items verified
   */
  getCompletionTier(roomId: string): ItemCompletionTier {
    const coverage = this.getRoomCoverage(roomId);
    if (coverage.total === 0) return "minimum";
    if (coverage.percentage >= 100) return "thorough";
    if (coverage.percentage >= 60) return "standard";
    // Below 60%: check if at least 1 critical/high item is verified
    const roomItems = this.expectedItems.get(roomId) || [];
    const hasCritical = roomItems.some(
      (item) =>
        (item.importance === "critical" || item.importance === "high") &&
        this.confidence.get(item.id)?.verified,
    );
    return hasCritical ? "minimum" : "not_started";
  }

  /**
   * Serialize state for persistence (event emission / offline queue).
   * Returns a snapshot that can be stored in the bulk submission payload.
   */
  serializeState(): Array<{
    roomId: string;
    items: Array<{
      itemId: string;
      name: string;
      inventoryClass: InventoryClass;
      verified: boolean;
      confidence: number;
      framesSeen: number;
    }>;
    tier: ItemCompletionTier;
    percentage: number;
  }> {
    const result: ReturnType<ItemTracker["serializeState"]> = [];
    for (const [roomId, items] of this.expectedItems) {
      result.push({
        roomId,
        items: items.map((item) => {
          const conf = this.confidence.get(item.id);
          return {
            itemId: item.id,
            name: item.name,
            inventoryClass: item.inventoryClass,
            verified: conf?.verified ?? false,
            confidence: conf?.confidence ?? 0,
            framesSeen: conf?.framesSeen ?? 0,
          };
        }),
        tier: this.getCompletionTier(roomId),
        percentage: this.getRoomCoverage(roomId).percentage,
      });
    }
    return result;
  }

  /**
   * Get the next unverified items for guidance (sorted by importance).
   */
  getNextUnverifiedItems(roomId: string, limit: number = 3): ExpectedItem[] {
    const coverage = this.getRoomCoverage(roomId);
    const importanceOrder = { critical: 0, high: 1, normal: 2, low: 3 };

    return coverage.unverifiedItems
      .sort((a, b) => importanceOrder[a.importance] - importanceOrder[b.importance])
      .slice(0, limit);
  }

  /**
   * Manually mark an item as verified (e.g., from server-side Claude analysis).
   */
  markVerified(itemId: string): void {
    const conf = this.confidence.get(itemId);
    if (conf) {
      conf.verified = true;
      conf.confidence = MAX_CONFIDENCE;
    }
  }

  /**
   * Match a COCO class name to expected items in a room.
   */
  private findMatchingItems(roomId: string, cocoClassName: string): ExpectedItem[] {
    const roomItems = this.expectedItems.get(roomId) || [];
    const matches: ExpectedItem[] = [];
    const normalizedCoco = cocoClassName.toLowerCase();

    for (const item of roomItems) {
      // Direct COCO class match
      if (item.cocoClasses?.includes(normalizedCoco)) {
        matches.push(item);
        continue;
      }

      // Fuzzy match via COCO-to-property map
      const propertyNames = COCO_TO_PROPERTY_MAP[normalizedCoco];
      if (propertyNames) {
        const itemNameLower = item.name.toLowerCase();
        for (const propName of propertyNames) {
          if (itemNameLower.includes(propName) || propName.includes(itemNameLower)) {
            matches.push(item);
            break;
          }
        }
      }

      // Substring match on item name
      if (matches.indexOf(item) === -1) {
        const itemNameLower = item.name.toLowerCase();
        if (itemNameLower.includes(normalizedCoco) || normalizedCoco.includes(itemNameLower)) {
          matches.push(item);
        }
      }
    }

    return matches;
  }

  /**
   * Reset all confidence for a fresh inspection.
   */
  reset(): void {
    for (const conf of this.confidence.values()) {
      conf.confidence = 0;
      conf.framesSeen = 0;
      conf.lastSeenAt = 0;
      conf.bestConfidence = 0;
      conf.verified = false;
    }
  }
}

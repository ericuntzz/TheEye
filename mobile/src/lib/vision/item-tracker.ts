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

export interface ExpectedItem {
  id: string;
  name: string;
  category: string; // furniture, decor, appliance, fixture, etc.
  importance: "critical" | "high" | "normal" | "low";
  roomId: string;
  /** Optional: specific COCO class name(s) that match this item */
  cocoClasses?: string[];
}

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
const CONFIDENCE_DECAY_RATE = 0.98; // per-frame decay (slight, keeps recent frames relevant)
const MAX_CONFIDENCE = 1.0;

/**
 * Maps COCO class names to common property item categories.
 * Used when matching YOLO detections to expected items.
 */
const COCO_TO_PROPERTY_MAP: Record<string, string[]> = {
  "chair": ["chair", "recliner", "armchair", "reading chair", "dining chair", "office chair"],
  "couch": ["sofa", "couch", "loveseat", "sectional"],
  "bed": ["bed", "mattress", "bunk"],
  "dining table": ["table", "dining table", "desk", "coffee table", "side table", "end table"],
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
};

export class ItemTracker {
  private expectedItems: Map<string, ExpectedItem[]> = new Map(); // roomId -> items
  private confidence: Map<string, ItemConfidence> = new Map(); // itemId -> confidence

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

    // Match detections to expected items
    for (const detection of detections) {
      const matchedItems = this.findMatchingItems(roomId, detection.className);

      for (const item of matchedItems) {
        const conf = this.confidence.get(item.id);
        if (!conf || conf.verified) continue;

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
        }
      }
    }

    return gainedConfidence;
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

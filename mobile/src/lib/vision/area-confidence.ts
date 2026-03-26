/**
 * Area Confidence Model
 *
 * Replaces brittle angle-based completion with area-based confidence.
 * Instead of "match 7 specific camera angles," the model tracks
 * "how confident are we that each area of the room has been covered?"
 *
 * Confidence signals:
 * - Room detection (MobileCLIP embedding match) — coarse signal
 * - Angle/baseline match — strong signal for specific areas
 * - YOLO item detection — supporting evidence
 * - Time spent in view — longer exposure = more confident
 * - Motion stability — stable views contribute more than motion blur
 *
 * This is the evolution path toward "area confidently covered"
 * as described in the architecture roadmap.
 */

export interface AreaAnchor {
  id: string;
  name: string;
  /** Baselines that cover this area */
  baselineIds: string[];
  /** Expected items in this area */
  itemIds: string[];
  /** Room this area belongs to */
  roomId: string;
}

export interface AreaConfidence {
  areaId: string;
  /** Overall confidence that this area has been adequately covered (0-1) */
  confidence: number;
  /** Signals that contributed to confidence */
  signals: {
    baselineMatch: number; // 0-1, from angle/baseline coverage
    itemVerification: number; // 0-1, from YOLO item tracker
    timeInView: number; // seconds spent pointing at this area
    motionStability: number; // 0-1, average stability while viewing
  };
  /** Whether the area is considered "covered" for completion purposes */
  covered: boolean;
  /** Timestamp of last confidence update */
  lastUpdatedAt: number;
}

export interface RoomAreaModel {
  roomId: string;
  areas: AreaAnchor[];
  confidence: Map<string, AreaConfidence>;
}

/** Threshold for an area to be considered "covered" */
const AREA_COVERAGE_THRESHOLD = 0.65;

/** Weight factors for different confidence signals */
const SIGNAL_WEIGHTS = {
  baselineMatch: 0.40, // Strongest signal — exact angle matched
  itemVerification: 0.25, // Supporting — items in this area detected
  timeInView: 0.20, // Moderate — user spent time here
  motionStability: 0.15, // Weak but useful — stable viewing
};

/**
 * Area Confidence Tracker
 *
 * Manages area-based confidence for a room, accumulating signals
 * from multiple sources over time.
 */
export class AreaConfidenceTracker {
  private rooms: Map<string, RoomAreaModel> = new Map();

  /**
   * Initialize areas for a room from baselines and items.
   * Groups baselines into logical areas using labels and clustering.
   */
  initializeRoom(
    roomId: string,
    baselines: Array<{ id: string; label: string | null; clusterId?: string }>,
    items: Array<{ id: string; name: string }>,
  ): void {
    // Group baselines by cluster (each cluster = one logical area)
    const clusterMap = new Map<string, string[]>();
    for (const bl of baselines) {
      const key = bl.clusterId || bl.id; // Unclustered baselines are their own area
      const list = clusterMap.get(key) || [];
      list.push(bl.id);
      clusterMap.set(key, list);
    }

    const areas: AreaAnchor[] = [];
    let areaIdx = 0;
    for (const [clusterId, baselineIds] of clusterMap) {
      const representativeBaseline = baselines.find((b) => b.id === baselineIds[0]);
      areas.push({
        id: `area_${roomId}_${areaIdx++}`,
        name: representativeBaseline?.label || `Area ${areaIdx}`,
        baselineIds,
        itemIds: [], // Will be populated by item-to-area mapping
        roomId,
      });
    }

    // Simple item-to-area mapping: distribute items evenly across areas
    // (In the future, use spatial proximity from training)
    for (let i = 0; i < items.length; i++) {
      const areaIndex = i % areas.length;
      if (areas[areaIndex]) {
        areas[areaIndex].itemIds.push(items[i].id);
      }
    }

    const confidence = new Map<string, AreaConfidence>();
    for (const area of areas) {
      confidence.set(area.id, {
        areaId: area.id,
        confidence: 0,
        signals: {
          baselineMatch: 0,
          itemVerification: 0,
          timeInView: 0,
          motionStability: 0,
        },
        covered: false,
        lastUpdatedAt: Date.now(),
      });
    }

    this.rooms.set(roomId, { roomId, areas, confidence });
  }

  /**
   * Update confidence when a baseline is matched (angle scanned).
   */
  onBaselineMatched(roomId: string, baselineId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    for (const area of room.areas) {
      if (area.baselineIds.includes(baselineId)) {
        const conf = room.confidence.get(area.id);
        if (!conf) continue;

        // Strong signal — baseline match contributes heavily
        conf.signals.baselineMatch = Math.min(1.0, conf.signals.baselineMatch + 0.5);
        this.recomputeConfidence(conf);
      }
    }
  }

  /**
   * Update confidence when items are detected by YOLO.
   */
  onItemsDetected(roomId: string, itemIds: string[]): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    for (const area of room.areas) {
      const matchedItems = area.itemIds.filter((id) => itemIds.includes(id));
      if (matchedItems.length > 0 && area.itemIds.length > 0) {
        const conf = room.confidence.get(area.id);
        if (!conf) continue;

        const ratio = matchedItems.length / area.itemIds.length;
        conf.signals.itemVerification = Math.min(1.0, conf.signals.itemVerification + ratio * 0.3);
        this.recomputeConfidence(conf);
      }
    }
  }

  /**
   * Update time-in-view for areas based on current locked baseline.
   */
  onTimeInView(roomId: string, baselineId: string, deltaMs: number): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    for (const area of room.areas) {
      if (area.baselineIds.includes(baselineId)) {
        const conf = room.confidence.get(area.id);
        if (!conf) continue;

        const deltaSec = deltaMs / 1000;
        // Diminishing returns: each second adds less
        const gain = Math.min(0.1, deltaSec * 0.02);
        conf.signals.timeInView = Math.min(1.0, conf.signals.timeInView + gain);
        this.recomputeConfidence(conf);
      }
    }
  }

  /**
   * Update motion stability signal.
   */
  onMotionStability(roomId: string, baselineId: string, stability: number): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    for (const area of room.areas) {
      if (area.baselineIds.includes(baselineId)) {
        const conf = room.confidence.get(area.id);
        if (!conf) continue;

        // Exponential moving average
        conf.signals.motionStability = conf.signals.motionStability * 0.8 + stability * 0.2;
        this.recomputeConfidence(conf);
      }
    }
  }

  /**
   * Get the overall room coverage as a percentage.
   */
  getRoomCoverage(roomId: string): { covered: number; total: number; percentage: number } {
    const room = this.rooms.get(roomId);
    if (!room) return { covered: 0, total: 0, percentage: 0 };

    const total = room.areas.length;
    const covered = Array.from(room.confidence.values()).filter((c) => c.covered).length;
    return {
      covered,
      total,
      percentage: total > 0 ? Math.round((covered / total) * 100) : 0,
    };
  }

  /**
   * Get the areas that still need coverage.
   */
  getUncoveredAreas(roomId: string): AreaAnchor[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];

    return room.areas.filter((area) => {
      const conf = room.confidence.get(area.id);
      return !conf?.covered;
    });
  }

  /**
   * Serialize the current state for persistence/telemetry.
   */
  serializeState(): Array<{
    roomId: string;
    areas: Array<{
      id: string;
      name: string;
      confidence: number;
      covered: boolean;
      signals: AreaConfidence["signals"];
    }>;
  }> {
    const result: ReturnType<AreaConfidenceTracker["serializeState"]> = [];
    for (const [roomId, room] of this.rooms) {
      result.push({
        roomId,
        areas: room.areas.map((area) => {
          const conf = room.confidence.get(area.id);
          return {
            id: area.id,
            name: area.name,
            confidence: conf?.confidence ?? 0,
            covered: conf?.covered ?? false,
            signals: conf?.signals ?? {
              baselineMatch: 0,
              itemVerification: 0,
              timeInView: 0,
              motionStability: 0,
            },
          };
        }),
      });
    }
    return result;
  }

  /**
   * Reset all confidence for a fresh inspection.
   */
  reset(): void {
    for (const room of this.rooms.values()) {
      for (const conf of room.confidence.values()) {
        conf.confidence = 0;
        conf.covered = false;
        conf.signals = {
          baselineMatch: 0,
          itemVerification: 0,
          timeInView: 0,
          motionStability: 0,
        };
      }
    }
  }

  // ── Private ──────────────────────────────────────────────────

  private recomputeConfidence(conf: AreaConfidence): void {
    conf.confidence =
      conf.signals.baselineMatch * SIGNAL_WEIGHTS.baselineMatch +
      conf.signals.itemVerification * SIGNAL_WEIGHTS.itemVerification +
      conf.signals.timeInView * SIGNAL_WEIGHTS.timeInView +
      conf.signals.motionStability * SIGNAL_WEIGHTS.motionStability;

    conf.covered = conf.confidence >= AREA_COVERAGE_THRESHOLD;
    conf.lastUpdatedAt = Date.now();
  }
}

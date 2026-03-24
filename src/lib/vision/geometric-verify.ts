/**
 * Geometric Verification for Inspection Localization
 *
 * Pluggable verifier interface — the compare pipeline depends ONLY on this contract.
 * No jsfeat-specific types, shapes, or assumptions leak outside the verifier.
 *
 * Default implementation: ORB feature detection + RANSAC homography via jsfeat.
 * Can be swapped for OpenCV, SuperPoint/LightGlue, or other backends without
 * reworking the pipeline code.
 *
 * All thresholds are config-driven via environment variables for benchmark tuning.
 */

// Dynamic import — sharp is a native binary that may not be available in all
// serverless environments.  A static `import sharp from "sharp"` would crash
// the entire module (and every API route that transitively imports it) if the
// binary is missing.  Lazy-loading keeps the module importable everywhere and
// only fails at the point where sharp is actually needed.
let _sharpModule: ((input?: Buffer | Uint8Array | string) => any) | null = null;

async function getSharp() {
  if (!_sharpModule) {
    _sharpModule = (await import("sharp")).default;
  }
  return _sharpModule;
}

// ─── Pluggable Interface ─────────────────────────────────────────

export interface GeometricVerifier {
  verify(
    baselineGray: Buffer,
    currentGray: Buffer,
    width: number,
    height: number,
  ): Promise<GeometricVerifyResult>;
}

export interface GeometricVerifyResult {
  /** Final pass/fail — did geometric verification accept this pair? */
  verified: boolean;
  /** Total feature matches before RANSAC filtering */
  matchCount: number;
  /** Matches surviving RANSAC */
  inlierCount: number;
  /** inlierCount / matchCount */
  inlierRatio: number;
  /** Spatial coverage 0-1 (fraction of quadrants with inliers) */
  inlierSpread: number;
  /** Projected overlap ratio 0-1 */
  overlapArea: number;
  /** 3x3 flattened homography (null if estimation failed) */
  homography: number[] | null;
  /** Machine-readable rejection reasons */
  rejectionReasons: string[];
  /** Human-readable guidance for the user */
  userGuidance: string;
}

// ─── Configuration ───────────────────────────────────────────────

interface VerifierConfig {
  minInliers: number;
  minInlierRatio: number;
  minQuadrantCoverage: number;
  minOverlap: number;
  maxAreaRatio: number;
  minEdgeRatio: number;
  maxFeatures: number;
  fastThreshold: number;
  matchRatioThreshold: number;
  ransacThreshold: number;
}

function loadConfig(): VerifierConfig {
  return {
    minInliers: envNumber("VERIFY_MIN_INLIERS", 12),
    minInlierRatio: envNumber("VERIFY_MIN_INLIER_RATIO", 0.20),
    minQuadrantCoverage: envNumber("VERIFY_MIN_QUADRANT_COVERAGE", 2),
    minOverlap: envNumber("VERIFY_MIN_OVERLAP", 0.30),
    maxAreaRatio: envNumber("VERIFY_MAX_AREA_RATIO", 5.0),
    minEdgeRatio: envNumber("VERIFY_MIN_EDGE_RATIO", 0.10),
    maxFeatures: envNumber("VERIFY_MAX_FEATURES", 700),
    fastThreshold: envNumber("VERIFY_FAST_THRESHOLD", 12),
    matchRatioThreshold: envNumber("VERIFY_MATCH_RATIO", 0.9),
    ransacThreshold: envNumber("VERIFY_RANSAC_THRESHOLD", 4.0),
  };
}

function envNumber(key: string, defaultVal: number): number {
  const val = process.env[key];
  if (!val) return defaultVal;
  const parsed = parseFloat(val);
  return isNaN(parsed) ? defaultVal : parsed;
}

// ─── Image Preprocessing ────────────────────────────────────────

const VERIFY_WIDTH = 480;
const VERIFY_HEIGHT = 360;

/**
 * Convert an image buffer (JPEG/PNG/etc) to raw grayscale pixels at verification resolution.
 */
export async function imageToGrayscale(imageBuffer: Buffer): Promise<{
  gray: Buffer;
  width: number;
  height: number;
}> {
  const sharp = await getSharp();
  const { data, info } = await sharp(imageBuffer)
    // Respect EXIF orientation so training-derived verification assets
    // and live/current frames are normalized the same way.
    .rotate()
    .resize(VERIFY_WIDTH, VERIFY_HEIGHT, { fit: "cover", position: "centre" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return { gray: data, width: info.width, height: info.height };
}

// ─── JsfeatVerifier Implementation ──────────────────────────────

/**
 * Default geometric verifier using ORB features + RANSAC homography via jsfeat.
 *
 * ~100KB pure JS, no native deps — works in Vercel serverless.
 *
 * Acceptance criteria (all must pass):
 * 1. inliers ≥ minInliers
 * 2. inlierRatio ≥ minInlierRatio
 * 3. Spatial spread: inliers cover ≥ minQuadrantCoverage of 4 quadrants
 * 4. Projected corners form a convex quadrilateral
 * 5. Area ratio: 20%–500% of original (controlled by maxAreaRatio)
 * 6. No collapsed edges: shortest ≥ minEdgeRatio * longest
 * 7. Overlap ≥ minOverlap
 */
export class JsfeatVerifier implements GeometricVerifier {
  private config: VerifierConfig;

  constructor(config?: Partial<VerifierConfig>) {
    const defaults = loadConfig();
    this.config = { ...defaults, ...config };
  }

  async verify(
    baselineGray: Buffer,
    currentGray: Buffer,
    width: number,
    height: number,
  ): Promise<GeometricVerifyResult> {
    const jsfeat = require("jsfeat");

    const rejectionReasons: string[] = [];

    // Create jsfeat matrices
    const imgBase = new jsfeat.matrix_t(width, height, jsfeat.U8_t | jsfeat.C1_t);
    const imgCurr = new jsfeat.matrix_t(width, height, jsfeat.U8_t | jsfeat.C1_t);

    // Copy pixel data
    imgBase.data.set(baselineGray);
    imgCurr.data.set(currentGray);

    // Detect ORB keypoints + descriptors on both images
    const cornersBase = detectORB(
      jsfeat,
      imgBase,
      width,
      height,
      this.config.maxFeatures,
      this.config.fastThreshold,
    );
    const cornersCurr = detectORB(
      jsfeat,
      imgCurr,
      width,
      height,
      this.config.maxFeatures,
      this.config.fastThreshold,
    );

    if (cornersBase.keypoints.length < 8 || cornersCurr.keypoints.length < 8) {
      return {
        verified: false,
        matchCount: 0,
        inlierCount: 0,
        inlierRatio: 0,
        inlierSpread: 0,
        overlapArea: 0,
        homography: null,
        rejectionReasons: ["insufficient_features"],
        userGuidance: "Not enough visual features detected. Avoid pointing at blank walls.",
      };
    }

    // Match descriptors (brute-force Hamming distance)
    const matches = matchDescriptors(
      jsfeat,
      cornersBase.descriptors,
      cornersCurr.descriptors,
      cornersBase.keypoints.length,
      cornersCurr.keypoints.length,
      this.config.matchRatioThreshold,
    );

    const matchCount = matches.length;
    if (matchCount < this.config.minInliers) {
      return {
        verified: false,
        matchCount,
        inlierCount: 0,
        inlierRatio: 0,
        inlierSpread: 0,
        overlapArea: 0,
        homography: null,
        rejectionReasons: [`low_matches (${matchCount}/${this.config.minInliers})`],
        userGuidance: "The view doesn't match closely enough. Try a more similar angle.",
      };
    }

    // Build point correspondences for RANSAC
    const srcPoints: number[][] = [];
    const dstPoints: number[][] = [];
    for (const m of matches) {
      srcPoints.push([cornersBase.keypoints[m.srcIdx].x, cornersBase.keypoints[m.srcIdx].y]);
      dstPoints.push([cornersCurr.keypoints[m.dstIdx].x, cornersCurr.keypoints[m.dstIdx].y]);
    }

    // Estimate homography via RANSAC
    const ransacResult = estimateHomographyRANSAC(
      srcPoints,
      dstPoints,
      1000,
      this.config.ransacThreshold,
    );
    if (!ransacResult) {
      return {
        verified: false,
        matchCount,
        inlierCount: 0,
        inlierRatio: 0,
        inlierSpread: 0,
        overlapArea: 0,
        homography: null,
        rejectionReasons: ["homography_estimation_failed"],
        userGuidance: "Could not establish geometric correspondence. Try adjusting your angle.",
      };
    }

    const { H, inlierMask } = ransacResult;
    const inlierCount = inlierMask.filter(Boolean).length;
    const inlierRatio = matchCount > 0 ? inlierCount / matchCount : 0;

    // Check inlier count
    if (inlierCount < this.config.minInliers) {
      rejectionReasons.push(`low_inliers (${inlierCount}/${this.config.minInliers})`);
    }

    // Check inlier ratio
    if (inlierRatio < this.config.minInlierRatio) {
      rejectionReasons.push(`low_inlier_ratio (${inlierRatio.toFixed(2)}/${this.config.minInlierRatio})`);
    }

    // Check spatial spread (inliers across quadrants)
    const inlierSpread = computeQuadrantCoverage(dstPoints, inlierMask, width, height);
    const quadrantCount = Math.round(inlierSpread * 4);
    if (quadrantCount < this.config.minQuadrantCoverage) {
      rejectionReasons.push(`poor_spread (${quadrantCount}/${this.config.minQuadrantCoverage} quadrants)`);
    }

    // Project corners and validate homography sanity
    const corners = [
      [0, 0], [width, 0], [width, height], [0, height],
    ];
    const projected = corners.map(([x, y]) => projectPoint(H, x, y));

    // Check convexity
    if (!isConvexQuad(projected)) {
      rejectionReasons.push("non_convex_projection");
    }

    // Check area ratio
    const projectedArea = computeQuadArea(projected);
    const originalArea = width * height;
    const areaRatio = projectedArea / originalArea;
    if (areaRatio < (1 / this.config.maxAreaRatio) || areaRatio > this.config.maxAreaRatio) {
      rejectionReasons.push(`extreme_area_ratio (${areaRatio.toFixed(2)})`);
    }

    // Check edge ratios
    const edges = computeEdgeLengths(projected);
    const maxEdge = Math.max(...edges);
    const minEdge = Math.min(...edges);
    if (maxEdge > 0 && (minEdge / maxEdge) < this.config.minEdgeRatio) {
      rejectionReasons.push(`collapsed_edge (ratio=${(minEdge / maxEdge).toFixed(3)})`);
    }

    // Compute overlap area
    const overlapArea = computeOverlap(projected, width, height);
    if (overlapArea < this.config.minOverlap) {
      rejectionReasons.push(`low_overlap (${(overlapArea * 100).toFixed(0)}%/${(this.config.minOverlap * 100).toFixed(0)}%)`);
    }

    const verified = rejectionReasons.length === 0;

    // Generate user guidance based on rejection reasons
    let userGuidance = "View verified — matched to baseline.";
    if (!verified) {
      if (rejectionReasons.some(r => r.startsWith("poor_spread"))) {
        userGuidance = "Move closer and include more of the room.";
      } else if (rejectionReasons.some(r => r.startsWith("low_overlap"))) {
        userGuidance = "Try to align with the target view shown.";
      } else if (rejectionReasons.some(r => r.startsWith("low_inlier"))) {
        userGuidance = "Try a slightly different angle.";
      } else if (rejectionReasons.some(r => r.includes("area_ratio") || r.includes("collapsed"))) {
        userGuidance = "You may be too close or at an extreme angle.";
      } else if (rejectionReasons.some(r => r.includes("convex"))) {
        userGuidance = "Try adjusting your camera angle.";
      } else {
        userGuidance = "Try a slightly different angle.";
      }
    }

    return {
      verified,
      matchCount,
      inlierCount,
      inlierRatio,
      inlierSpread,
      overlapArea,
      homography: H,
      rejectionReasons,
      userGuidance,
    };
  }
}

// ─── ORB Feature Detection ──────────────────────────────────────

interface ORBResult {
  keypoints: Array<{ x: number; y: number; angle: number; score: number }>;
  descriptors: any; // jsfeat matrix
}

function detectORB(
  jsfeat: any,
  grayMatrix: any,
  width: number,
  height: number,
  maxFeatures = 500,
  fastThreshold = 20,
): ORBResult {
  // Apply Gaussian blur to reduce noise
  const blurred = new jsfeat.matrix_t(width, height, jsfeat.U8_t | jsfeat.C1_t);
  jsfeat.imgproc.gaussian_blur(grayMatrix, blurred, 3);

  // Detect FAST corners
  const cornerCapacity = width * height;
  const corners: any[] = [];
  for (let i = 0; i < cornerCapacity; i++) {
    corners.push(new jsfeat.keypoint_t(0, 0, 0, 0));
  }

  jsfeat.fast_corners.set_threshold(fastThreshold);
  let count = jsfeat.fast_corners.detect(blurred, corners, 3);
  count = Math.min(count, cornerCapacity);

  // Non-maximum suppression
  if (count > 0) {
    jsfeat.yape06.laplacian_threshold = 30;
    jsfeat.yape06.min_eigen_value_threshold = 25;
  }

  // Compute ORB descriptors
  const descriptors = new jsfeat.matrix_t(32, maxFeatures, jsfeat.U8_t | jsfeat.C1_t);

  // Sort by score and take top N
  const validCorners = corners.slice(0, count).sort((a: any, b: any) => b.score - a.score);
  const topCorners = validCorners.slice(0, maxFeatures);

  if (topCorners.length > 0) {
    jsfeat.orb.describe(blurred, topCorners, topCorners.length, descriptors);
  }

  return {
    keypoints: topCorners.map((c: any) => ({
      x: c.x,
      y: c.y,
      angle: c.angle,
      score: c.score,
    })),
    descriptors,
  };
}

// ─── Descriptor Matching ────────────────────────────────────────

interface Match {
  srcIdx: number;
  dstIdx: number;
  distance: number;
}

function matchDescriptors(
  jsfeat: any,
  descA: any,
  descB: any,
  countA: number,
  countB: number,
  ratioThreshold = 0.75,
): Match[] {
  const matches: Match[] = [];
  const descSize = 32; // ORB descriptor size in bytes

  for (let i = 0; i < countA; i++) {
    let bestDist = 256 * descSize;
    let secondBest = bestDist;
    let bestIdx = -1;

    for (let j = 0; j < countB; j++) {
      let dist = 0;
      for (let k = 0; k < descSize; k++) {
        dist += popcount(descA.data[i * descSize + k] ^ descB.data[j * descSize + k]);
      }

      if (dist < bestDist) {
        secondBest = bestDist;
        bestDist = dist;
        bestIdx = j;
      } else if (dist < secondBest) {
        secondBest = dist;
      }
    }

    // Lowe's ratio test
    if (bestIdx >= 0 && bestDist < ratioThreshold * secondBest) {
      matches.push({ srcIdx: i, dstIdx: bestIdx, distance: bestDist });
    }
  }

  return matches;
}

function popcount(x: number): number {
  x = x - ((x >> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  return (((x + (x >> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24;
}

// ─── Homography Estimation (RANSAC) ─────────────────────────────

interface RANSACResult {
  H: number[]; // 3x3 flattened
  inlierMask: boolean[];
}

function estimateHomographyRANSAC(
  srcPoints: number[][],
  dstPoints: number[][],
  maxIterations = 1000,
  threshold = 3.0,
): RANSACResult | null {
  const n = srcPoints.length;
  if (n < 4) return null;

  let bestH: number[] | null = null;
  let bestInlierMask: boolean[] = [];
  let bestInlierCount = 0;

  for (let iter = 0; iter < maxIterations; iter++) {
    // Pick 4 random points
    const indices = randomSample(n, 4);
    const src4 = indices.map(i => srcPoints[i]);
    const dst4 = indices.map(i => dstPoints[i]);

    // Compute homography from 4 point correspondences (DLT)
    const H = computeHomography4Points(src4, dst4);
    if (!H) continue;

    // Count inliers
    const inlierMask: boolean[] = [];
    let inlierCount = 0;
    for (let i = 0; i < n; i++) {
      const [px, py] = projectPoint(H, srcPoints[i][0], srcPoints[i][1]);
      const dx = px - dstPoints[i][0];
      const dy = py - dstPoints[i][1];
      const dist = Math.sqrt(dx * dx + dy * dy);
      const isInlier = dist < threshold;
      inlierMask.push(isInlier);
      if (isInlier) inlierCount++;
    }

    if (inlierCount > bestInlierCount) {
      bestInlierCount = inlierCount;
      bestH = H;
      bestInlierMask = inlierMask;

      // Early termination if enough inliers
      if (inlierCount > n * 0.8) break;
    }
  }

  if (!bestH || bestInlierCount < 4) return null;

  // Refine homography using all inliers
  const inlierSrc = srcPoints.filter((_, i) => bestInlierMask[i]);
  const inlierDst = dstPoints.filter((_, i) => bestInlierMask[i]);
  if (inlierSrc.length >= 4) {
    const refined = computeHomographyLeastSquares(inlierSrc, inlierDst);
    if (refined) {
      bestH = refined;
    }
  }

  return { H: bestH, inlierMask: bestInlierMask };
}

function randomSample(n: number, k: number): number[] {
  const indices: number[] = [];
  while (indices.length < k) {
    const idx = Math.floor(Math.random() * n);
    if (!indices.includes(idx)) indices.push(idx);
  }
  return indices;
}

// ─── Homography Computation (DLT) ──────────────────────────────

/**
 * Compute homography from 4 point correspondences using Direct Linear Transform.
 */
function computeHomography4Points(
  src: number[][],
  dst: number[][],
): number[] | null {
  return computeHomographyLeastSquares(src, dst);
}

/**
 * Compute homography from N≥4 point correspondences using DLT + SVD.
 * Simplified SVD via eigenvalue decomposition of AᵀA.
 */
function computeHomographyLeastSquares(
  src: number[][],
  dst: number[][],
): number[] | null {
  const n = src.length;
  if (n < 4) return null;

  // Build the 2n×9 matrix A for DLT
  const A: number[][] = [];
  for (let i = 0; i < n; i++) {
    const [x, y] = src[i];
    const [xp, yp] = dst[i];
    A.push([-x, -y, -1, 0, 0, 0, x * xp, y * xp, xp]);
    A.push([0, 0, 0, -x, -y, -1, x * yp, y * yp, yp]);
  }

  // Compute AᵀA (9×9)
  const AtA = Array.from({ length: 9 }, () => new Array(9).fill(0));
  for (let i = 0; i < 9; i++) {
    for (let j = i; j < 9; j++) {
      let sum = 0;
      for (let k = 0; k < A.length; k++) {
        sum += A[k][i] * A[k][j];
      }
      AtA[i][j] = sum;
      AtA[j][i] = sum;
    }
  }

  // Find eigenvector corresponding to smallest eigenvalue via power iteration
  // on (AtA + λI)⁻¹ (inverse iteration)
  // Simplified: use Jacobi-like approach for smallest eigenvector
  const h = findSmallestEigenvector(AtA);
  if (!h) return null;

  // Normalize so H[8] = 1 (or by Frobenius norm if H[8] ≈ 0)
  const scale = h[8] !== 0 ? h[8] : Math.sqrt(h.reduce((s, v) => s + v * v, 0));
  if (Math.abs(scale) < 1e-12) return null;

  return h.map(v => v / scale);
}

/**
 * Find the eigenvector corresponding to the smallest eigenvalue
 * of a 9×9 symmetric matrix using inverse power iteration.
 */
function findSmallestEigenvector(M: number[][]): number[] | null {
  const n = 9;

  // Shift matrix: M' = M + σI to make it well-conditioned for inversion
  // Use a small shift based on trace
  let trace = 0;
  for (let i = 0; i < n; i++) trace += M[i][i];
  const sigma = Math.abs(trace) * 1e-6 + 1e-10;

  const shifted = M.map((row, i) => row.map((v, j) => v + (i === j ? sigma : 0)));

  // LU decomposition for solving (M + σI)x = b
  const { L, U, P } = luDecompose(shifted);
  if (!L || !U) return null;

  // Inverse power iteration
  let x = Array.from({ length: n }, () => Math.random() - 0.5);
  let norm = Math.sqrt(x.reduce((s, v) => s + v * v, 0));
  x = x.map(v => v / norm);

  for (let iter = 0; iter < 100; iter++) {
    // Solve (M + σI) * y = x
    const y = luSolve(L, U, P, x);
    if (!y) return null;

    norm = Math.sqrt(y.reduce((s, v) => s + v * v, 0));
    if (norm < 1e-14) return null;
    x = y.map(v => v / norm);
  }

  return x;
}

// ─── LU Decomposition (with partial pivoting) ───────────────────

function luDecompose(A: number[][]): {
  L: number[][] | null;
  U: number[][] | null;
  P: number[];
} {
  const n = A.length;
  const L = Array.from({ length: n }, () => new Array(n).fill(0));
  const U = A.map(row => [...row]);
  const P = Array.from({ length: n }, (_, i) => i);

  for (let k = 0; k < n; k++) {
    // Partial pivoting
    let maxVal = Math.abs(U[k][k]);
    let maxRow = k;
    for (let i = k + 1; i < n; i++) {
      if (Math.abs(U[i][k]) > maxVal) {
        maxVal = Math.abs(U[i][k]);
        maxRow = i;
      }
    }
    if (maxVal < 1e-14) return { L: null, U: null, P };

    if (maxRow !== k) {
      [U[k], U[maxRow]] = [U[maxRow], U[k]];
      [L[k], L[maxRow]] = [L[maxRow], L[k]];
      [P[k], P[maxRow]] = [P[maxRow], P[k]];
    }

    for (let i = k + 1; i < n; i++) {
      L[i][k] = U[i][k] / U[k][k];
      for (let j = k; j < n; j++) {
        U[i][j] -= L[i][k] * U[k][j];
      }
    }
    L[k][k] = 1;
  }

  return { L, U, P };
}

function luSolve(
  L: number[][],
  U: number[][],
  P: number[],
  b: number[],
): number[] | null {
  const n = b.length;

  // Apply permutation
  const pb = P.map(i => b[i]);

  // Forward substitution (Ly = Pb)
  const y = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    y[i] = pb[i];
    for (let j = 0; j < i; j++) {
      y[i] -= L[i][j] * y[j];
    }
  }

  // Back substitution (Ux = y)
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    if (Math.abs(U[i][i]) < 1e-14) return null;
    x[i] = y[i];
    for (let j = i + 1; j < n; j++) {
      x[i] -= U[i][j] * x[j];
    }
    x[i] /= U[i][i];
  }

  return x;
}

// ─── Geometric Helpers ──────────────────────────────────────────

function projectPoint(H: number[], x: number, y: number): [number, number] {
  const w = H[6] * x + H[7] * y + H[8];
  if (Math.abs(w) < 1e-12) return [x, y]; // Degenerate — return identity
  return [
    (H[0] * x + H[1] * y + H[2]) / w,
    (H[3] * x + H[4] * y + H[5]) / w,
  ];
}

function computeQuadrantCoverage(
  points: number[][],
  inlierMask: boolean[],
  width: number,
  height: number,
): number {
  const midX = width / 2;
  const midY = height / 2;
  const quadrants = new Set<number>();

  for (let i = 0; i < points.length; i++) {
    if (!inlierMask[i]) continue;
    const [x, y] = points[i];
    const q = (x < midX ? 0 : 1) + (y < midY ? 0 : 2);
    quadrants.add(q);
  }

  return quadrants.size / 4;
}

function isConvexQuad(corners: [number, number][]): boolean {
  if (corners.length !== 4) return false;
  let sign: number | null = null;
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = corners[i];
    const [x2, y2] = corners[(i + 1) % 4];
    const [x3, y3] = corners[(i + 2) % 4];
    const cross = (x2 - x1) * (y3 - y2) - (y2 - y1) * (x3 - x2);
    if (Math.abs(cross) < 1e-6) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === null) sign = s;
    else if (s !== sign) return false;
  }
  return sign !== null;
}

function computeQuadArea(corners: [number, number][]): number {
  // Shoelace formula
  let area = 0;
  const n = corners.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = corners[i];
    const [x2, y2] = corners[(i + 1) % n];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}

function computeEdgeLengths(corners: [number, number][]): number[] {
  const lengths: number[] = [];
  for (let i = 0; i < corners.length; i++) {
    const [x1, y1] = corners[i];
    const [x2, y2] = corners[(i + 1) % corners.length];
    lengths.push(Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2));
  }
  return lengths;
}

/**
 * Approximate overlap between the projected quad and the frame.
 * Uses a grid-sampling approach for simplicity.
 */
function computeOverlap(
  projected: [number, number][],
  width: number,
  height: number,
  gridSize = 20,
): number {
  let inside = 0;
  let total = 0;

  for (let gy = 0; gy < gridSize; gy++) {
    for (let gx = 0; gx < gridSize; gx++) {
      const x = (gx + 0.5) * (width / gridSize);
      const y = (gy + 0.5) * (height / gridSize);
      if (pointInConvexQuad(x, y, projected)) {
        inside++;
      }
      total++;
    }
  }

  return total > 0 ? inside / total : 0;
}

function pointInConvexQuad(
  px: number,
  py: number,
  quad: [number, number][],
): boolean {
  let sign: number | null = null;
  for (let i = 0; i < quad.length; i++) {
    const [x1, y1] = quad[i];
    const [x2, y2] = quad[(i + 1) % quad.length];
    const cross = (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1);
    const s = cross > 0 ? 1 : cross < 0 ? -1 : 0;
    if (s === 0) continue;
    if (sign === null) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

// ─── Top-K Verification Cascade ─────────────────────────────────

export interface CascadeResult {
  verifiedCandidateId: string | null;
  verificationResult: GeometricVerifyResult | null;
  candidatesAttempted: number;
  allResults: Array<{
    candidateId: string;
    result: GeometricVerifyResult;
  }>;
}

/**
 * Run geometric verification on candidates in order until one passes.
 *
 * @param verifier The geometric verifier to use
 * @param candidates Ordered array of { id, grayBuffer } (best embedding match first)
 * @param currentGray The current frame's grayscale pixels
 * @param width Frame width
 * @param height Frame height
 */
export async function runVerificationCascade(
  verifier: GeometricVerifier,
  candidates: Array<{
    id: string;
    gray: Buffer;
    width: number;
    height: number;
  }>,
  currentGray: Buffer,
  currentWidth: number,
  currentHeight: number,
): Promise<CascadeResult> {
  const allResults: CascadeResult["allResults"] = [];
  let candidatesAttempted = 0;

  for (const candidate of candidates) {
    candidatesAttempted++;

    try {
      // Resize both to same dimensions for comparison
      const targetWidth = Math.min(candidate.width, currentWidth);
      const targetHeight = Math.min(candidate.height, currentHeight);

      const result = await verifier.verify(
        candidate.gray,
        currentGray,
        targetWidth,
        targetHeight,
      );

      allResults.push({ candidateId: candidate.id, result });

      if (result.verified) {
        return {
          verifiedCandidateId: candidate.id,
          verificationResult: result,
          candidatesAttempted,
          allResults,
        };
      }
    } catch (err) {
      console.error(`[geometric-verify] Verifier error for candidate ${candidate.id}:`, err);
      allResults.push({
        candidateId: candidate.id,
        result: {
          verified: false,
          matchCount: 0,
          inlierCount: 0,
          inlierRatio: 0,
          inlierSpread: 0,
          overlapArea: 0,
          homography: null,
          rejectionReasons: ["verifier_error"],
          userGuidance: "Try a slightly different angle.",
        },
      });
    }
  }

  // All candidates failed
  return {
    verifiedCandidateId: null,
    verificationResult: allResults[allResults.length - 1]?.result ?? null,
    candidatesAttempted,
    allResults,
  };
}

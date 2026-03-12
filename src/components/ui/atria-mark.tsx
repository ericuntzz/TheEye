/**
 * Atria Mark — Reusable SVG logo component
 *
 * The "Atrium A" — high-contrast serif A with thin left leg,
 * thick curved right leg, bracket serifs, and solid wedge apex.
 *
 * Variants:
 *   - "main"    — full mark with bracket serifs (default)
 *   - "favicon" — simplified for 16–32px (no serifs, thicker left leg)
 *
 * Color presets:
 *   - "navy"  — #1B2A4A (for light backgrounds)
 *   - "white" — #FFFFFF (for dark backgrounds)
 *   - "sky"   — #4DA6FF (accent variant)
 *   - or pass any CSS color string
 */

interface AtriaMarkProps {
  size?: number;
  color?: "navy" | "white" | "sky" | string;
  variant?: "main" | "favicon";
  className?: string;
}

const COLOR_MAP: Record<string, string> = {
  navy: "#1B2A4A",
  white: "#FFFFFF",
  sky: "#4DA6FF",
};

/** Main mark — bracket serifs, calligraphic contrast */
function MainPath({ fill }: { fill: string }) {
  return (
    <>
      <path
        fillRule="nonzero"
        fill={fill}
        d="M 85,5 L 9.6,185.8 Q 6,194 -4,194 L -4,201 L 33,201 L 33,194 L 31,194 Q 22,194 25,185.5 L 88,20 Q 82.3,108.2 125.7,186.1 Q 130,194 121,194 L 119,201 L 201,201 L 201,194 Q 190,194 184.7,186.7 Q 121.6,97.4 91,5 Q 88,2 85,5 Z"
      />
      <path fill={fill} d="M 41.6,109.1 L 94.0,102.9 L 97.4,116.9 L 35.7,123.1 Z" />
    </>
  );
}

/** Favicon variant — no serifs, thicker left leg, heavier crossbar */
function FaviconPath({ fill }: { fill: string }) {
  return (
    <>
      <path
        fillRule="nonzero"
        fill={fill}
        d="M 85,4 L -2,196 L 36,196 L 88,20 Q 82.3,108.2 125.7,186.1 L 118,196 L 204,196 Q 192,186 91,4 L 85,4 Z"
      />
      <path fill={fill} d="M 44,96 L 108,96 L 112,112 L 37,112 Z" />
    </>
  );
}

export function AtriaMark({
  size = 24,
  color = "navy",
  variant = "main",
  className,
}: AtriaMarkProps) {
  const fill = COLOR_MAP[color] ?? color;

  return (
    <svg
      width={size}
      height={size}
      viewBox="-8 0 216 212"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      {variant === "main" ? <MainPath fill={fill} /> : <FaviconPath fill={fill} />}
    </svg>
  );
}

/**
 * Atria Wordmark Lockup — mark + "ATRIA" text
 * For headers, nav bars, and splash contexts.
 */
interface AtriaLockupProps {
  markSize?: number;
  color?: "navy" | "white" | "sky" | string;
  variant?: "main" | "favicon";
  textClassName?: string;
  className?: string;
  direction?: "horizontal" | "stacked";
}

export function AtriaLockup({
  markSize = 32,
  color = "navy",
  variant = "main",
  textClassName,
  className,
  direction = "horizontal",
}: AtriaLockupProps) {
  const textColor = COLOR_MAP[color] ?? color;

  return (
    <div
      className={`flex items-center ${direction === "stacked" ? "flex-col gap-2" : "gap-2.5"} ${className ?? ""}`}
    >
      <AtriaMark size={markSize} color={color} variant={variant} />
      <span
        className={textClassName ?? "font-semibold tracking-[0.26em]"}
        style={{ color: textColor }}
      >
        ATRIA
      </span>
    </div>
  );
}

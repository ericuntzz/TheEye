/**
 * Atria Mark — React Native SVG logo component
 *
 * The "Atrium A" — high-contrast serif A with thin left leg,
 * thick curved right leg, bracket serifs, and solid wedge apex.
 */

import React from "react";
import Svg, { Path } from "react-native-svg";

interface AtriaMarkProps {
  size?: number;
  color?: "navy" | "white" | "sky" | string;
  variant?: "main" | "favicon";
}

const COLOR_MAP: Record<string, string> = {
  navy: "#1B2A4A",
  white: "#FFFFFF",
  sky: "#4DA6FF",
};

export function AtriaMark({
  size = 24,
  color = "navy",
  variant = "main",
}: AtriaMarkProps) {
  const fill = COLOR_MAP[color] ?? color;

  if (variant === "favicon") {
    return (
      <Svg width={size} height={size} viewBox="-8 0 216 212" fill="none">
        <Path
          fillRule="nonzero"
          fill={fill}
          d="M 85,4 L -2,196 L 36,196 L 88,20 Q 82.3,108.2 125.7,186.1 L 118,196 L 204,196 Q 192,186 91,4 L 85,4 Z"
        />
        <Path fill={fill} d="M 44,96 L 108,96 L 112,112 L 37,112 Z" />
      </Svg>
    );
  }

  return (
    <Svg width={size} height={size} viewBox="-8 0 216 212" fill="none">
      <Path
        fillRule="nonzero"
        fill={fill}
        d="M 85,5 L 9.6,185.8 Q 6,194 -4,194 L -4,201 L 33,201 L 33,194 L 31,194 Q 22,194 25,185.5 L 88,20 Q 82.3,108.2 125.7,186.1 Q 130,194 121,194 L 119,201 L 201,201 L 201,194 Q 190,194 184.7,186.7 Q 121.6,97.4 91,5 Q 88,2 85,5 Z"
      />
      <Path fill={fill} d="M 41.6,109.1 L 94.0,102.9 L 97.4,116.9 L 35.7,123.1 Z" />
    </Svg>
  );
}

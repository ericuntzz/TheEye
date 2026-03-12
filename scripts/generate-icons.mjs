/**
 * Generate Atria brand icon PNGs for the mobile app.
 * Uses sharp to render SVG → PNG at required dimensions.
 *
 * Usage: node scripts/generate-icons.mjs
 */
import sharp from "sharp";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const MOBILE_ASSETS = join(import.meta.dirname, "../mobile/assets");

// Atria "A" mark — main variant (bracket serifs)
const MAIN_MARK_PATH = `
  <path fill-rule="nonzero" fill="__FILL__"
    d="M 85,5 L 9.6,185.8 Q 6,194 -4,194 L -4,201 L 33,201 L 33,194 L 31,194 Q 22,194 25,185.5 L 88,20 Q 82.3,108.2 125.7,186.1 Q 130,194 121,194 L 119,201 L 201,201 L 201,194 Q 190,194 184.7,186.7 Q 121.6,97.4 91,5 Q 88,2 85,5 Z"/>
  <path fill="__FILL__" d="M 41.6,109.1 L 94.0,102.9 L 97.4,116.9 L 35.7,123.1 Z"/>
`;

// Atria "A" mark — favicon variant (no serifs, thicker)
const FAVICON_MARK_PATH = `
  <path fill-rule="nonzero" fill="__FILL__"
    d="M 85,4 L -2,196 L 36,196 L 88,20 Q 82.3,108.2 125.7,186.1 L 118,196 L 204,196 Q 192,186 91,4 L 85,4 Z"/>
  <path fill="__FILL__" d="M 44,96 L 108,96 L 112,112 L 37,112 Z"/>
`;

const NAVY = "#1B2A4A";
const WHITE = "#FFFFFF";
const SKY = "#4DA6FF";
const IVORY = "#F8F7F4";

/**
 * Build a complete SVG string.
 * The mark viewBox is "-8 0 216 212". We center it within the target canvas.
 */
function buildSvg({ size, bgColor, bgGradient, markFill, variant = "main", markScale = 0.55 }) {
  const markPaths =
    variant === "main"
      ? MAIN_MARK_PATH.replaceAll("__FILL__", markFill)
      : FAVICON_MARK_PATH.replaceAll("__FILL__", markFill);

  // Mark native width/height from viewBox "-8 0 216 212" → width 216, height 212
  const markW = 216;
  const markH = 212;
  const scaledW = size * markScale;
  const scaledH = scaledW * (markH / markW);
  const tx = (size - scaledW) / 2 + 8 * (scaledW / markW); // offset for viewBox x=-8
  const ty = (size - scaledH) / 2;
  const s = scaledW / markW;

  let bgRect = `<rect width="${size}" height="${size}" fill="${bgColor}"/>`;
  if (bgGradient) {
    bgRect += `
      <defs>
        <radialGradient id="glow" cx="50%" cy="35%" rx="65%" ry="60%">
          <stop offset="0%" stop-color="${SKY}" stop-opacity="0.50"/>
          <stop offset="50%" stop-color="#3C78DC" stop-opacity="0.20"/>
          <stop offset="100%" stop-color="${SKY}" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="${size}" height="${size}" fill="url(#glow)"/>
    `;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    ${bgRect}
    <g transform="translate(${tx}, ${ty}) scale(${s})">
      ${markPaths}
    </g>
  </svg>`;
}

async function generatePng(svgString, outputPath, size) {
  const buf = Buffer.from(svgString);
  await sharp(buf).resize(size, size).png().toFile(outputPath);
  console.log(`  ✓ ${outputPath} (${size}×${size})`);
}

async function main() {
  console.log("Generating Atria mobile app icons...\n");

  // 1. icon.png — 1024×1024, navy bg + sky glow + white mark
  const iconSvg = buildSvg({
    size: 1024,
    bgColor: NAVY,
    bgGradient: true,
    markFill: WHITE,
    variant: "main",
    markScale: 0.52,
  });
  await generatePng(iconSvg, join(MOBILE_ASSETS, "icon.png"), 1024);

  // 2. splash-icon.png — 1024×1024, transparent/ivory bg + navy mark (just the mark, no background)
  const splashSvg = buildSvg({
    size: 1024,
    bgColor: IVORY,
    bgGradient: false,
    markFill: NAVY,
    variant: "main",
    markScale: 0.35,
  });
  await generatePng(splashSvg, join(MOBILE_ASSETS, "splash-icon.png"), 1024);

  // 3. favicon.png — 48×48, navy bg + white favicon variant
  const faviconSvg = buildSvg({
    size: 48,
    bgColor: NAVY,
    bgGradient: false,
    markFill: WHITE,
    variant: "favicon",
    markScale: 0.70,
  });
  await generatePng(faviconSvg, join(MOBILE_ASSETS, "favicon.png"), 48);

  // 4. android-icon-foreground.png — 512×512, transparent bg + white mark (sized for safe zone ~66%)
  const androidFgSvg = buildSvg({
    size: 512,
    bgColor: "transparent",
    bgGradient: false,
    markFill: WHITE,
    variant: "main",
    markScale: 0.40,
  });
  // For transparent bg we need to avoid the rect or set opacity 0
  const androidFgSvgClean = androidFgSvg.replace(
    `<rect width="512" height="512" fill="transparent"/>`,
    ""
  );
  await generatePng(androidFgSvgClean, join(MOBILE_ASSETS, "android-icon-foreground.png"), 512);

  // 5. android-icon-background.png — 512×512, navy + sky glow
  const androidBgSvg = buildSvg({
    size: 512,
    bgColor: NAVY,
    bgGradient: true,
    markFill: "transparent", // no mark, just background
    variant: "main",
    markScale: 0,
  });
  // Remove the mark group entirely for clean bg
  const androidBgClean = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
    <rect width="512" height="512" fill="${NAVY}"/>
    <defs>
      <radialGradient id="glow" cx="50%" cy="35%" rx="65%" ry="60%">
        <stop offset="0%" stop-color="${SKY}" stop-opacity="0.50"/>
        <stop offset="50%" stop-color="#3C78DC" stop-opacity="0.20"/>
        <stop offset="100%" stop-color="${SKY}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="512" height="512" fill="url(#glow)"/>
  </svg>`;
  await generatePng(androidBgClean, join(MOBILE_ASSETS, "android-icon-background.png"), 512);

  // 6. android-icon-monochrome.png — 512×512, black mark on transparent (Android 13+ themed icons)
  const monoSvg = buildSvg({
    size: 512,
    bgColor: "transparent",
    bgGradient: false,
    markFill: "#000000",
    variant: "main",
    markScale: 0.40,
  });
  const monoClean = monoSvg.replace(
    `<rect width="512" height="512" fill="transparent"/>`,
    ""
  );
  await generatePng(monoClean, join(MOBILE_ASSETS, "android-icon-monochrome.png"), 512);

  console.log("\n✅ All icons generated!");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

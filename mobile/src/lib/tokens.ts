/**
 * Atria Design Tokens — React Native
 * Single source of truth for all visual decisions in the mobile app.
 * All components should reference these tokens, never hardcoded values.
 */

export const colors = {
  // ── Core Brand ──────────────────────────
  background: '#F8F7F4',       // Soft Ivory
  foreground: '#1E1F24',       // Deep Graphite (body text)
  heading: '#1B2A4A',          // Deep Navy (headlines, titles)
  muted: '#6B7280',            // Slate (secondary text, labels)
  stone: '#D4C8B8',            // Warm Stone (borders, dividers)

  // ── Interactive ─────────────────────────
  primary: '#2372B8',          // Sky Blue — darkened for WCAG AA (5.04:1 on white)
  primaryForeground: '#FFFFFF',
  gradientViolet: '#8B8CFF',   // Soft Violet (gradient endpoint only)

  // ── Surfaces ────────────────────────────
  card: '#FFFFFF',
  cardBorder: 'rgba(212, 200, 184, 0.3)',
  secondary: '#F1F0ED',
  ivory: '#F8F7F4',

  // ── Sidebar / Nav ───────────────────────
  sidebar: '#1B2A4A',
  sidebarText: 'rgba(255, 255, 255, 0.6)',
  sidebarActive: '#FFFFFF',

  // ── Semantic / Status ───────────────────
  success: '#16A34A',           // Green — darkened for WCAG AA (4.5:1 on white)
  warning: '#FBBF24',
  error: '#F87171',
  destructive: '#DC2626',       // Hard red — delete buttons, stop recording, danger actions
  info: '#2372B8',

  // ── Severity / Category ───────────────
  purple: '#A855F7',           // Guest damage, special category
  cyan: '#06B6D4',             // Vacancy check accent

  // ── Slate Scale (dark context text) ────
  slate300: '#94A3B8',         // Muted text on dark backgrounds
  slate500: '#64748B',         // Cosmetic severity
  slate600: '#475569',         // Subdued labels on dark backgrounds
  slate700: '#334155',         // Placeholders, dark borders

  // ── Severity Colors ──────────────────────
  severity: {
    cosmetic: '#64748B',
    maintenance: '#EAB308',
    safety: '#4DA6FF',
    urgentRepair: '#EF4444',
    guestDamage: '#A855F7',
  },

  // ── Category Colors ────────────────────
  category: {
    missing: '#F97316',
    moved: '#EAB308',
    cleanliness: '#06B6D4',
    damage: '#EF4444',
    inventory: '#A855F7',
    operational: '#3B82F6',
    safety: '#EF4444',
    restock: '#22C55E',
    presentation: '#64748B',
    manualNote: '#4DA6FF',
  },

  // ── Opacity Variants ──────────────────
  primaryBg: 'rgba(35, 114, 184, 0.08)',
  primaryBgStrong: 'rgba(35, 114, 184, 0.12)',
  primaryBorder: 'rgba(35, 114, 184, 0.2)',
  successBg: 'rgba(34, 197, 94, 0.08)',
  successBorder: 'rgba(34, 197, 94, 0.15)',
  errorBg: 'rgba(239, 68, 68, 0.08)',
  errorBorder: 'rgba(239, 68, 68, 0.25)',
  warningBg: 'rgba(234, 179, 8, 0.08)',
  warningBorder: 'rgba(234, 179, 8, 0.25)',
  mutedBg: 'rgba(71, 85, 105, 0.10)',
  mutedBorder: 'rgba(71, 85, 105, 0.25)',

  // ── Camera Context (stays dark) ─────────
  camera: {
    background: '#000000',
    overlay: 'rgba(0, 0, 0, 0.65)',
    overlayBorder: 'rgba(255, 255, 255, 0.08)',
    overlayCard: 'rgba(27, 42, 74, 0.92)',
    overlayCardLight: 'rgba(27, 42, 74, 0.88)',
    sheetBg: 'rgba(10, 14, 23, 0.97)',
    panelBg: 'rgba(2, 6, 23, 0.72)',
    panelBorder: 'rgba(148, 163, 184, 0.16)',
    itemBg: 'rgba(15, 23, 42, 0.55)',
    itemBorder: 'rgba(148, 163, 184, 0.12)',
    pillBg: 'rgba(148, 163, 184, 0.16)',
    pillBorder: 'rgba(148, 163, 184, 0.22)',
    text: '#FFFFFF',
    textBright: 'rgba(255, 255, 255, 0.94)',
    textHigh: 'rgba(255, 255, 255, 0.92)',
    textMedium: 'rgba(255, 255, 255, 0.84)',
    textMuted: 'rgba(255, 255, 255, 0.6)',
    textSubtle: 'rgba(148, 163, 184, 0.72)',
    textBody: '#E2E8F0',
    textBodyMuted: 'rgba(226, 232, 240, 0.75)',
    textAccent: 'rgba(191, 219, 254, 0.78)',
    textAccentMuted: 'rgba(191, 219, 254, 0.68)',
    textSuccess: 'rgba(134, 239, 172, 0.82)',
    dotPending: 'rgba(255, 255, 255, 0.62)',
    dotScannedLabel: 'rgba(34, 197, 94, 0.7)',
    border: 'rgba(148, 163, 184, 0.08)',
    borderSubtle: 'rgba(255, 255, 255, 0.08)',
    borderLight: 'rgba(255, 255, 255, 0.12)',
    borderMedium: 'rgba(255, 255, 255, 0.15)',
    borderPreview: 'rgba(255, 255, 255, 0.2)',
    modalOverlay: 'rgba(0, 0, 0, 0.85)',
    modalButtonBg: 'rgba(255, 255, 255, 0.15)',
  },
} as const;

export const spacing = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
  // Fine-grained intermediates (commonly used across screens)
  tight: 6,      // compact internal gaps, label spacing
  element: 10,   // standard element gap
  content: 12,   // section content padding, common gap
  card: 14,      // card / button internal padding
  container: 18, // container padding variant
  screen: 20,    // screen-edge horizontal padding
  section: 28,   // space between major sections
  safe: 40,      // bottom safe-area / large section spacing
} as const;

export const radius = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 10,
  lg: 12,
  xl: 16,
  full: 9999,
} as const;

export const typography = {
  // ── Display / Hero ─────────────────
  hero:       { fontSize: 48, fontWeight: '600' as const, letterSpacing: -0.96 },
  display:    { fontSize: 56, fontWeight: '600' as const },

  // ── Headings ───────────────────────
  h1:         { fontSize: 32, fontWeight: '600' as const, letterSpacing: -0.48 },
  screenTitle:{ fontSize: 30, fontWeight: '600' as const, letterSpacing: -0.5 },
  pageTitle:  { fontSize: 28, fontWeight: '600' as const, letterSpacing: -0.4 },
  h2:         { fontSize: 24, fontWeight: '600' as const, letterSpacing: -0.24 },
  modalTitle: { fontSize: 22, fontWeight: '600' as const, letterSpacing: -0.3 },
  stat:       { fontSize: 20, fontWeight: '600' as const },
  h3:         { fontSize: 18, fontWeight: '600' as const },

  // ── Body / Content ─────────────────
  button:     { fontSize: 17, fontWeight: '600' as const, letterSpacing: 0.3 },
  bodyLg:     { fontSize: 16, fontWeight: '500' as const },
  body:       { fontSize: 15, fontWeight: '400' as const, lineHeight: 24 },
  label:      { fontSize: 14, fontWeight: '500' as const, letterSpacing: 0.14 },
  data:       { fontSize: 14, fontWeight: '500' as const },

  // ── Small / Supporting ─────────────
  sm:         { fontSize: 13, fontWeight: '400' as const },
  caption:    { fontSize: 12, fontWeight: '500' as const },
  micro:      { fontSize: 11, fontWeight: '500' as const },
  badge:      { fontSize: 10, fontWeight: '700' as const, letterSpacing: 0.8 },
  tiny:       { fontSize: 9,  fontWeight: '600' as const },
} as const;

/** fontSize-only shorthand for use in StyleSheet.create */
export const fontSize = {
  display: 56,
  hero: 48,
  h1: 32,
  screenTitle: 30,
  pageTitle: 28,
  h2: 24,
  modalTitle: 22,
  stat: 20,
  h3: 18,
  button: 17,
  bodyLg: 16,
  body: 15,
  label: 14,
  sm: 13,
  caption: 12,
  micro: 11,
  badge: 10,
  tiny: 9,
} as const;

export const shadows = {
  card: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 12,
    elevation: 3,
  },
  elevated: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 20,
    elevation: 6,
  },
} as const;

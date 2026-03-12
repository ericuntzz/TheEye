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
  primary: '#4DA6FF',          // Sky Blue (buttons, links, active)
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
  success: '#4ADE80',
  warning: '#FBBF24',
  error: '#F87171',
  info: '#4DA6FF',

  // ── Severity / Category ───────────────
  purple: '#A855F7',           // Guest damage, special category
  cyan: '#06B6D4',             // Vacancy check accent

  // ── Slate Scale (dark context text) ────
  slate300: '#94A3B8',         // Muted text on dark backgrounds
  slate500: '#64748B',         // Cosmetic severity
  slate600: '#475569',         // Subdued labels on dark backgrounds
  slate700: '#334155',         // Placeholders, dark borders

  // ── Camera Context (stays dark) ─────────
  camera: {
    background: '#000000',
    overlay: 'rgba(0, 0, 0, 0.65)',
    overlayBorder: 'rgba(255, 255, 255, 0.08)',
    overlayCard: 'rgba(27, 42, 74, 0.92)',
    text: '#FFFFFF',
    textMuted: 'rgba(255, 255, 255, 0.6)',
  },
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const radius = {
  sm: 8,
  md: 10,
  lg: 12,
  xl: 16,
  full: 9999,
} as const;

export const typography = {
  hero:  { fontSize: 48, fontWeight: '600' as const, letterSpacing: -0.96 },
  h1:    { fontSize: 32, fontWeight: '600' as const, letterSpacing: -0.48 },
  h2:    { fontSize: 24, fontWeight: '600' as const, letterSpacing: -0.24 },
  h3:    { fontSize: 18, fontWeight: '600' as const },
  body:  { fontSize: 15, fontWeight: '400' as const, lineHeight: 24 },
  sm:    { fontSize: 13, fontWeight: '400' as const },
  label: { fontSize: 14, fontWeight: '500' as const, letterSpacing: 0.14 },
  data:  { fontSize: 14, fontWeight: '500' as const },
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

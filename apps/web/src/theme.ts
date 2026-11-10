import { alpha, createTheme } from "@mui/material/styles";

/**
 * Warm cream ground, terracotta accent and Georgia headings (the original look, kept on
 * purpose). Body text is Mukta, one family drawn for both Devanagari and Latin, so a Nepali
 * line and its English sit together evenly. Self-hosted from @fontsource (the CSP allows no
 * font host).
 */
export const tokens = {
  // Terracotta accent: buttons, links, time labels, the current nav item.
  plate: "#963a35",
  plateDeep: "#7a2e2a",
  onPlate: "#ffffff",
  onPlateMuted: "#f3d9d5",
  // Warm cream page with lighter paper for the header and panels.
  ground: "#f6f3ef",
  paper: "#fdfcfa",
  groundAlt: "#efe9e2",
  ink: "#2b2724",
  inkMuted: "#635d57",
  rule: "#e2dbd3",
  ruleStrong: "#8a8178",
  // Find-in-page matches, like a highlighter on paper.
  mark: "#f4d58d",
  // "You are here": the line opened from a search, or the one playing.
  here: "#963a35",
  hereTint: "rgba(150, 58, 53, 0.08)",
  serif: 'Georgia, "Times New Roman", serif',
  font: '"Mukta", "Noto Sans Devanagari", "Nirmala UI", system-ui, sans-serif',
} as const;

export const theme = createTheme({
  palette: {
    primary: { main: tokens.plate, dark: tokens.plateDeep, contrastText: tokens.onPlate },
    secondary: { main: tokens.here },
    background: { default: tokens.ground, paper: tokens.paper },
    text: { primary: tokens.ink, secondary: tokens.inkMuted },
    divider: tokens.rule,
    warning: { main: "#9a5b00" },
  },
  shape: { borderRadius: 4 },
  typography: {
    fontFamily: tokens.font,
    fontSize: 15,
    htmlFontSize: 16,
    h1: { fontFamily: tokens.serif, fontSize: "2.5rem", fontWeight: 400, lineHeight: 1.15 },
    h2: { fontFamily: tokens.serif, fontSize: "1.75rem", fontWeight: 400, lineHeight: 1.25 },
    h3: { fontFamily: tokens.serif, fontSize: "1.375rem", fontWeight: 400, lineHeight: 1.3 },
    h6: { fontWeight: 600 },
    subtitle1: { fontSize: "1.0625rem", fontWeight: 600 },
    body1: { fontSize: "1.0625rem", lineHeight: 1.6 },
    body2: { fontSize: "0.9375rem", lineHeight: 1.55 },
    caption: { fontSize: "0.8125rem", lineHeight: 1.4 },
    overline: { fontSize: "0.75rem", fontWeight: 600, letterSpacing: "0.06em", lineHeight: 1.6 },
    button: { textTransform: "none", fontWeight: 600, fontSize: "0.9375rem" },
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: { fontVariantNumeric: "lining-nums" },
        "::selection": { background: alpha(tokens.plate, 0.18) },
        ":focus-visible": { outline: `2px solid ${tokens.plate}`, outlineOffset: 2 },
        a: { textUnderlineOffset: "0.2em" },
        mark: { background: tokens.mark, color: "inherit", padding: "0 1px" },
        "[lang=ne], [lang=new], [lang=hi]": { lineHeight: 1.75 },
      },
    },
    MuiButtonBase: { defaultProps: { disableRipple: true } },
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: {
          minHeight: 40,
          paddingInline: 16,
          // Ripple is off, so keyboard focus needs its own ring.
          "&.Mui-focusVisible": { outline: `2px solid ${tokens.plate}`, outlineOffset: 2 },
        },
        outlined: { borderColor: tokens.ruleStrong },
        sizeSmall: { minHeight: 32 },
      },
    },
    MuiIconButton: {
      styleOverrides: {
        root: { "&.Mui-focusVisible": { outline: `2px solid ${tokens.plate}`, outlineOffset: 2 } },
      },
    },
    MuiPaper: {
      defaultProps: { variant: "outlined" },
      styleOverrides: { outlined: { borderColor: tokens.rule } },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: { backgroundColor: tokens.paper },
        notchedOutline: { borderColor: tokens.ruleStrong },
      },
    },
    MuiTab: {
      styleOverrides: {
        root: {
          minHeight: 40,
          fontWeight: 600,
          "&.Mui-focusVisible": { outline: `2px solid ${tokens.plate}`, outlineOffset: -2 },
        },
      },
    },
    MuiTabs: {
      styleOverrides: { root: { minHeight: 40 }, indicator: { height: 3 } },
    },
    MuiChip: {
      styleOverrides: { root: { fontWeight: 600 } },
    },
    MuiAlert: {
      defaultProps: { variant: "outlined" },
      styleOverrides: { root: { alignItems: "flex-start" } },
    },
    MuiLink: { defaultProps: { underline: "always" } },
    MuiCheckbox: {
      styleOverrides: {
        root: { "&.Mui-focusVisible": { outline: `2px solid ${tokens.plate}`, outlineOffset: -4 } },
      },
    },
    MuiSwitch: {
      styleOverrides: {
        switchBase: {
          "&.Mui-focusVisible + .MuiSwitch-track": { outline: `2px solid ${tokens.plate}` },
        },
      },
    },
  },
});

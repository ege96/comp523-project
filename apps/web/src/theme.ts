import { alpha, createTheme } from "@mui/material/styles";

/**
 * The look comes from Kathmandu's bilingual enamel street signs: a deep blue plate with white
 * lettering, Devanagari above Roman. The plate is the frame (masthead, search band, time
 * labels); the reading column stays white and calm.
 *
 * Mukta is one family drawn for both scripts, so a Nepali line and its English sit together
 * at the same size and weight. It is self-hosted from @fontsource (the CSP allows no font host).
 */
export const tokens = {
  plate: "#173a8c",
  plateDeep: "#0f2a6b",
  onPlate: "#ffffff",
  onPlateMuted: "#c9d6f5",
  ground: "#ffffff",
  groundAlt: "#f2f4f8",
  ink: "#141821",
  inkMuted: "#4a5161",
  rule: "#d6dbe5",
  ruleStrong: "#7f8a9e",
  // Find-in-page matches, like a highlighter on paper.
  mark: "#ffd257",
  // "You are here": the line opened from a search, or the one playing.
  here: "#c2321d",
  font: '"Mukta", "Noto Sans Devanagari", "Nirmala UI", system-ui, sans-serif',
} as const;

export const theme = createTheme({
  palette: {
    primary: { main: tokens.plate, dark: tokens.plateDeep, contrastText: tokens.onPlate },
    secondary: { main: tokens.here },
    background: { default: tokens.ground, paper: tokens.ground },
    text: { primary: tokens.ink, secondary: tokens.inkMuted },
    divider: tokens.rule,
    warning: { main: "#9a5b00" },
  },
  shape: { borderRadius: 2 },
  typography: {
    fontFamily: tokens.font,
    fontSize: 15,
    htmlFontSize: 16,
    h1: { fontSize: "2.25rem", fontWeight: 800, lineHeight: 1.15, letterSpacing: "-0.01em" },
    h2: { fontSize: "1.5rem", fontWeight: 800, lineHeight: 1.25 },
    h3: { fontSize: "1.1875rem", fontWeight: 600, lineHeight: 1.3 },
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
      defaultProps: { variant: "outlined", square: true },
      styleOverrides: { outlined: { borderColor: tokens.rule } },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: { backgroundColor: tokens.ground },
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
      styleOverrides: { root: { borderRadius: 2, fontWeight: 600 } },
    },
    MuiAlert: {
      defaultProps: { variant: "outlined" },
      styleOverrides: { root: { borderRadius: 2, alignItems: "flex-start" } },
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

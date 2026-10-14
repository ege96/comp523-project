import { createTheme } from "@mui/material/styles";

// Colours and type taken from the UI mockups (illustrative). System fonts only: the CSP
// allows no font host, and a webfont isn't worth one yet.
const serif = 'Georgia, "Times New Roman", serif';

export const theme = createTheme({
  palette: {
    primary: { main: "#963a35" },
    background: { default: "#f6f3ef", paper: "#fdfcfa" },
    text: { primary: "#2b2724", secondary: "#635d57" },
  },
  shape: { borderRadius: 4 },
  typography: {
    h1: { fontFamily: serif, fontSize: "2.75rem", fontWeight: 400 },
    h2: { fontFamily: serif, fontSize: "1.75rem", fontWeight: 400 },
    h3: { fontFamily: serif, fontSize: "1.375rem", fontWeight: 400 },
    button: { textTransform: "none" },
  },
  components: {
    MuiButtonBase: { defaultProps: { disableRipple: true } },
    MuiPaper: { defaultProps: { variant: "outlined" } },
  },
});

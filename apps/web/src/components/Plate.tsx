import Box from "@mui/material/Box";
import Container from "@mui/material/Container";
import type { ReactNode } from "react";

import { tokens } from "../theme";

/**
 * The blue enamel band under the masthead that holds a page's search or title. It continues
 * the masthead without a seam, so the frame reads as one sign.
 */
export function Plate({ children, pb = { xs: 4, md: 5 } }: { children: ReactNode; pb?: object }) {
  return (
    <Box
      sx={{
        bgcolor: tokens.plate,
        color: tokens.onPlate,
        pt: { xs: 3, md: 4 },
        pb,
        "& ::selection": { background: "rgba(255,255,255,0.3)" },
        "& :focus-visible": { outlineColor: tokens.onPlate },
      }}
    >
      <Container>{children}</Container>
    </Box>
  );
}

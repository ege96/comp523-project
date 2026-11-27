import Box from "@mui/material/Box";
import Container from "@mui/material/Container";
import type { ReactNode } from "react";

/**
 * The band under the header that holds a page's title and search box, set apart from the
 * results below by a rule.
 */
export function Plate({ children, pb = { xs: 4, md: 5 } }: { children: ReactNode; pb?: object }) {
  return (
    <Box sx={{ pt: { xs: 4, md: 6 }, pb, borderBottom: 1, borderColor: "divider" }}>
      <Container>{children}</Container>
    </Box>
  );
}

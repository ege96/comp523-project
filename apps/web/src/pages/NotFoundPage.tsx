import Container from "@mui/material/Container";
import Typography from "@mui/material/Typography";

import { TextLink } from "../components/links";

export function NotFoundPage() {
  return (
    <Container sx={{ py: 6 }}>
      <Typography variant="h1" gutterBottom>
        Page not found
      </Typography>
      <Typography>
        <TextLink to="/">Go to the archive</TextLink>
      </Typography>
    </Container>
  );
}

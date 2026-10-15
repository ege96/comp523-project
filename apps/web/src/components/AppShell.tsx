import AppBar from "@mui/material/AppBar";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Container from "@mui/material/Container";
import Stack from "@mui/material/Stack";
import Toolbar from "@mui/material/Toolbar";
import Typography from "@mui/material/Typography";
import { Outlet } from "@tanstack/react-router";

import { useAuth } from "../auth/useAuth";
import { WaveformIcon } from "./icons";
import { ButtonLink, TextLink } from "./links";

const activeNav = { style: { boxShadow: "inset 0 -2px 0 currentColor" } } as const;

export function AppShell() {
  const { state, signOut } = useAuth();
  const signedIn = state.status === "signedIn";
  return (
    <Box sx={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <AppBar
        position="static"
        color="inherit"
        elevation={0}
        sx={{ borderBottom: 1, borderColor: "divider" }}
      >
        <Container>
          <Toolbar disableGutters sx={{ gap: 1, minHeight: 72 }}>
            <TextLink
              to="/"
              underline="none"
              color="inherit"
              sx={{ mr: "auto", display: "flex", alignItems: "center", gap: 1.5 }}
            >
              <Box
                aria-hidden
                sx={{
                  display: "grid",
                  placeItems: "center",
                  width: 36,
                  height: 36,
                  borderRadius: 1,
                  bgcolor: "primary.main",
                  color: "primary.contrastText",
                }}
              >
                <WaveformIcon fontSize="small" />
              </Box>
              <Typography variant="h3" component="span">
                Swayambhu Stories
              </Typography>
            </TextLink>
            <nav aria-label="Main">
              <Stack direction="row" spacing={1}>
                <ButtonLink to="/" activeOptions={{ exact: true }} activeProps={activeNav}>
                  Archive
                </ButtonLink>
                {signedIn && state.role === "admin" ? (
                  <ButtonLink to="/admin" activeProps={activeNav}>
                    Upload &amp; review
                  </ButtonLink>
                ) : null}
                {signedIn ? (
                  <Button color="inherit" onClick={() => void signOut()}>
                    Sign out
                  </Button>
                ) : null}
              </Stack>
            </nav>
          </Toolbar>
        </Container>
      </AppBar>
      <Box component="main" sx={{ flex: 1 }}>
        <Outlet />
      </Box>
      <Box component="footer" sx={{ borderTop: 1, borderColor: "divider", py: 3 }}>
        <Container sx={{ display: "flex", justifyContent: "space-between", gap: 2 }}>
          <Typography variant="body2" color="text.secondary">
            Swayambhu Stories · A living oral-history archive
          </Typography>
          {signedIn ? null : (
            <TextLink to="/signin" variant="body2" color="text.secondary">
              Admin sign-in
            </TextLink>
          )}
        </Container>
      </Box>
    </Box>
  );
}

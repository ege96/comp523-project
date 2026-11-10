import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Container from "@mui/material/Container";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { createLink, Outlet, useRouterState } from "@tanstack/react-router";

import { useAuth } from "../auth/useAuth";
import { tokens } from "../theme";
import { WaveformIcon } from "./icons";
import { TextLink } from "./links";

// Terracotta nav lettering; the current page is underlined.
const navItemSx = {
  color: tokens.plate,
  fontWeight: 600,
  fontSize: "0.9375rem",
  px: { xs: 1, sm: 1.5 },
  minHeight: 40,
  textDecoration: "none",
  borderBottom: "3px solid transparent",
  "&:hover": { borderBottomColor: tokens.rule },
  "&[aria-current='page']": { borderBottomColor: tokens.plate },
  "&.Mui-focusVisible, &:focus-visible": {
    outline: `2px solid ${tokens.plate}`,
    outlineOffset: 2,
  },
} as const;

const NavLink = createLink(ButtonBase);

export function AppShell() {
  const { state, signOut } = useAuth();
  const signedIn = state.status === "signedIn";
  const path = useRouterState({ select: (s) => s.location.pathname });
  // Home is the search page's front door, so both count as "Search".
  const onSearch = path === "/" || path === "/search";
  return (
    <Box sx={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <Box
        component="a"
        href="#main"
        sx={{
          position: "absolute",
          left: 8,
          top: -48,
          zIndex: 10,
          bgcolor: tokens.ground,
          color: tokens.ink,
          px: 2,
          py: 1,
          "&:focus": { top: 8 },
        }}
      >
        Skip to content
      </Box>
      <Box
        component="header"
        sx={{ bgcolor: tokens.paper, color: tokens.ink, borderBottom: 1, borderColor: "divider" }}
      >
        <Container>
          <Stack
            direction="row"
            sx={{
              alignItems: "center",
              flexWrap: "wrap",
              columnGap: 3,
              minHeight: { xs: 56, md: 72 },
            }}
          >
            <TextLink
              to="/"
              underline="none"
              color="inherit"
              sx={{ mr: "auto", py: 1, display: "flex", alignItems: "center", gap: 1.5 }}
            >
              <Box
                aria-hidden
                sx={{
                  display: "grid",
                  placeItems: "center",
                  width: 36,
                  height: 36,
                  borderRadius: 1,
                  bgcolor: tokens.plate,
                  color: tokens.onPlate,
                }}
              >
                <WaveformIcon fontSize="small" />
              </Box>
              <Box
                component="span"
                sx={{ fontFamily: tokens.serif, fontSize: { xs: "1.25rem", md: "1.375rem" } }}
              >
                Swayambhu Stories
              </Box>
            </TextLink>
            <Box component="nav" aria-label="Main" sx={{ mx: { xs: -1, sm: 0 } }}>
              <Stack direction="row" sx={{ alignItems: "center", flexWrap: "wrap" }}>
                <NavLink to="/" sx={navItemSx} aria-current={onSearch ? "page" : undefined}>
                  Search
                </NavLink>
                <NavLink to="/interviews" sx={navItemSx} activeProps={{ "aria-current": "page" }}>
                  Interviews
                </NavLink>
                <NavLink to="/about" sx={navItemSx} activeProps={{ "aria-current": "page" }}>
                  About
                </NavLink>
                {signedIn && state.role === "admin" ? (
                  <NavLink to="/admin" sx={navItemSx} activeProps={{ "aria-current": "page" }}>
                    Upload &amp; review
                  </NavLink>
                ) : null}
                {signedIn ? (
                  <ButtonBase sx={navItemSx} onClick={() => void signOut()}>
                    Sign out
                  </ButtonBase>
                ) : null}
              </Stack>
            </Box>
          </Stack>
        </Container>
      </Box>
      <Box component="main" id="main" tabIndex={-1} sx={{ flex: 1, outline: "none" }}>
        <Outlet />
      </Box>
      <Box component="footer" sx={{ borderTop: 1, borderColor: "divider", py: 3, mt: 8 }}>
        <Container
          sx={{
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "space-between",
            gap: 2,
          }}
        >
          <Typography variant="body2" color="text.secondary">
            Swayambhu Stories · A living oral-history archive
          </Typography>
          <Stack direction="row" spacing={3}>
            <TextLink to="/about" variant="body2" color="text.secondary">
              About &amp; Help
            </TextLink>
            {signedIn ? null : (
              <TextLink to="/signin" variant="body2" color="text.secondary">
                Admin sign-in
              </TextLink>
            )}
          </Stack>
        </Container>
      </Box>
    </Box>
  );
}

import Button from "@mui/material/Button";
import MuiLink from "@mui/material/Link";
import { createLink } from "@tanstack/react-router";

// MUI components that navigate with the router (typed `to`, preloading, active state).
export const ButtonLink = createLink(Button);
export const TextLink = createLink(MuiLink);

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import InputBase from "@mui/material/InputBase";
import { useNavigate } from "@tanstack/react-router";
import type { SubmitEvent } from "react";

import type { SearchParams } from "../api/client";
import { tokens } from "../theme";
import { SearchIcon } from "./icons";

export function SearchBox({
  defaultValue = "",
  large = false,
  filters,
}: {
  defaultValue?: string;
  large?: boolean;
  filters?: Omit<SearchParams, "q">;
}) {
  const navigate = useNavigate();
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const q = new FormData(event.currentTarget).get("q");
    if (typeof q === "string" && q.trim())
      void navigate({ to: "/search", search: { ...filters, q: q.trim() } });
  };
  const height = large ? { xs: 52, md: 60 } : { xs: 48, md: 52 };
  return (
    <Box
      component="form"
      role="search"
      onSubmit={submit}
      sx={{
        display: "flex",
        alignItems: "stretch",
        bgcolor: tokens.paper,
        color: tokens.ink,
        borderRadius: 1,
        outline: `1px solid ${tokens.ruleStrong}`,
        "&:focus-within": { outline: `2px solid ${tokens.plate}` },
      }}
    >
      <Box
        aria-hidden
        sx={{
          display: { xs: "none", sm: "flex" },
          alignItems: "center",
          pl: 2,
          color: tokens.plate,
        }}
      >
        <SearchIcon />
      </Box>
      <InputBase
        name="q"
        defaultValue={defaultValue}
        placeholder="Ask a question, or type some words"
        slotProps={{
          input: { "aria-label": "Search interview transcripts", enterKeyHint: "search" },
        }}
        sx={{
          flex: 1,
          minWidth: 0,
          height,
          px: { xs: 1.5, sm: 1.5 },
          fontSize: large ? { xs: "1.0625rem", md: "1.25rem" } : "1.0625rem",
          "& input::placeholder": { color: tokens.inkMuted, opacity: 1 },
          "& input:focus-visible": { outline: "none" },
        }}
      />
      <Button
        type="submit"
        sx={{
          m: "4px",
          px: { xs: 2, md: 3 },
          borderRadius: "3px",
          bgcolor: tokens.plate,
          color: tokens.onPlate,
          fontSize: large ? "1rem" : undefined,
          "&:hover": { bgcolor: tokens.plateDeep },
          "&.Mui-focusVisible": { outline: `2px solid ${tokens.plate}`, outlineOffset: 2 },
        }}
      >
        Search
      </Button>
    </Box>
  );
}

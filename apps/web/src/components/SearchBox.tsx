import Button from "@mui/material/Button";
import Paper from "@mui/material/Paper";
import InputBase from "@mui/material/InputBase";
import { useNavigate } from "@tanstack/react-router";
import type { SubmitEvent } from "react";

/**
 * Uncontrolled on purpose: the query only matters on submit, so typing re-renders nothing.
 * (A single field doesn't need TanStack Form; D-010 applies to the upload metadata form.)
 */
export function SearchBox({ defaultValue = "" }: { defaultValue?: string }) {
  const navigate = useNavigate();
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const q = new FormData(event.currentTarget).get("q");
    if (typeof q === "string" && q.trim())
      void navigate({ to: "/search", search: { q: q.trim() } });
  };
  return (
    <Paper
      component="form"
      role="search"
      onSubmit={submit}
      sx={{ display: "flex", alignItems: "center", gap: 1, p: 1, pl: 2 }}
    >
      <InputBase
        name="q"
        defaultValue={defaultValue}
        placeholder="Search interview transcripts"
        slotProps={{ input: { "aria-label": "Search interview transcripts" } }}
        sx={{ flex: 1 }}
      />
      <Button type="submit" variant="contained" disableElevation>
        Search transcripts
      </Button>
    </Paper>
  );
}

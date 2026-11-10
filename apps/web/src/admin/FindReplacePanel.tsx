import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import { useState, type SubmitEvent } from "react";

import { ApiError } from "../api/client";
import { useReplaceText } from "./api";
import type { Field } from "./findReplace";

export type Search = { find: string; field: Field; matchCase: boolean };

function lines(n: number): string {
  return n === 1 ? "1 line" : `${String(n)} lines`;
}

/**
 * Find a word or phrase in the transcript or its English and replace it in every line at once.
 * The matching lines are counted (and highlighted) by the editor from `onSearch`.
 */
export function FindReplacePanel({
  interviewId,
  matches,
  onSearch,
  onReplaced,
}: {
  interviewId: string;
  matches: number;
  onSearch: (search: Search) => void;
  onReplaced: () => void;
}) {
  const replace = useReplaceText(interviewId);
  const [search, setSearch] = useState<Search>({ find: "", field: "original", matchCase: false });
  const [replacement, setReplacement] = useState("");
  const [result, setResult] = useState<string | null>(null);

  const update = (next: Partial<Search>) => {
    const merged = { ...search, ...next };
    setSearch(merged);
    setResult(null);
    replace.reset();
    onSearch(merged);
  };

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (matches === 0) return;
    try {
      const { items, skipped } = await replace.mutateAsync({
        find: search.find,
        replace: replacement,
        field: search.field,
        match_case: search.matchCase,
      });
      const left = skipped
        ? ` ${lines(skipped)} left as they were, because they would have been empty.`
        : "";
      setResult(`Replaced in ${lines(items.length)}.${left}`);
      onReplaced();
    } catch {
      // Shown below from replace.error.
    }
  };

  const hasFind = search.find.trim() !== "";
  return (
    <Stack
      component="form"
      noValidate
      onSubmit={(e: SubmitEvent<HTMLFormElement>) => void submit(e)}
      spacing={1.5}
      aria-label="Find and replace"
      sx={{ p: 2, border: 1, borderColor: "divider", borderRadius: 1, bgcolor: "background.paper" }}
    >
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
        <TextField
          label="Find"
          size="small"
          value={search.find}
          onChange={(e) => {
            update({ find: e.target.value });
          }}
          fullWidth
          slotProps={{ htmlInput: { maxLength: 200 } }}
          helperText={hasFind ? `${lines(matches)} match` : " "}
        />
        <TextField
          label="Replace with"
          size="small"
          value={replacement}
          onChange={(e) => {
            setReplacement(e.target.value);
            setResult(null);
          }}
          fullWidth
          slotProps={{ htmlInput: { maxLength: 200 } }}
          helperText=" "
        />
      </Stack>
      <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: "wrap", alignItems: "center" }}>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={search.field}
          onChange={(_, field: Field | null) => {
            if (field) update({ field });
          }}
          aria-label="Text to search"
        >
          <ToggleButton value="original">Original</ToggleButton>
          <ToggleButton value="english">English</ToggleButton>
        </ToggleButtonGroup>
        <FormControlLabel
          control={
            <Checkbox
              checked={search.matchCase}
              onChange={(e) => {
                update({ matchCase: e.target.checked });
              }}
            />
          }
          label="Match case"
        />
        <Button
          type="submit"
          variant="contained"
          disabled={!hasFind || matches === 0 || replace.isPending}
        >
          {replace.isPending
            ? "Replacing…"
            : hasFind && matches > 0
              ? `Replace in ${lines(matches)}`
              : "Replace"}
        </Button>
      </Stack>
      {result ? (
        <Typography variant="body2" color="success.main" role="status">
          {result} Each line can still go back to the machine text.
        </Typography>
      ) : null}
      {replace.isError ? (
        <Typography variant="body2" color="error" role="alert">
          {replace.error instanceof ApiError && replace.error.status === 409
            ? "This interview is being transcribed again, which replaces every line. Try again once that has finished."
            : "Couldn't replace the text. Try again."}
        </Typography>
      ) : null}
    </Stack>
  );
}

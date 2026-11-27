import Box from "@mui/material/Box";
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
import { formatClock } from "../format";
import { useReplaceText } from "./api";
import type { Field, ReplaceExample } from "./findReplace";

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
  preview,
  onSearch,
  onReplaced,
}: {
  interviewId: string;
  matches: number;
  /** Before-and-after examples for a replacement, from the lines the editor has loaded. */
  preview: (search: Search, replacement: string) => ReplaceExample[];
  onSearch: (search: Search) => void;
  onReplaced: () => void;
}) {
  const replace = useReplaceText(interviewId);
  const [search, setSearch] = useState<Search>({ find: "", field: "original", matchCase: false });
  const [replacement, setReplacement] = useState("");
  const [result, setResult] = useState<string | null>(null);
  // Replacing changes many lines at once (maybe on a published interview), so it is checked
  // first: the admin sees a few lines before and after, then confirms.
  const [checking, setChecking] = useState(false);

  const update = (next: Partial<Search>) => {
    const merged = { ...search, ...next };
    setSearch(merged);
    setResult(null);
    setChecking(false);
    replace.reset();
    onSearch(merged);
  };

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (matches > 0) setChecking(true);
  };

  const confirm = async () => {
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
      setChecking(false);
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
      onSubmit={submit}
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
            setChecking(false);
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
          variant="outlined"
          disabled={!hasFind || matches === 0 || checking || replace.isPending}
        >
          {hasFind && matches > 0 ? `Check ${lines(matches)}` : "Replace"}
        </Button>
      </Stack>
      {checking ? (
        <Stack
          spacing={1.25}
          role="group"
          aria-labelledby="replace-check"
          sx={{ p: 1.5, borderRadius: 1, bgcolor: "action.hover" }}
        >
          <Typography id="replace-check" variant="body2" sx={{ fontWeight: 600 }}>
            Replace “{search.find.trim()}” with “{replacement}” in the{" "}
            {search.field === "original" ? "original" : "English"} of {lines(matches)}?
            {matches > 3 ? " For example:" : ""}
          </Typography>
          <Stack component="ul" spacing={1} sx={{ m: 0, pl: 2.5 }}>
            {preview(search, replacement).map((ex) => (
              <Typography component="li" variant="body2" key={ex.seq}>
                <Box component="span" sx={{ color: "text.secondary" }}>
                  {formatClock(ex.startMs)}:{" "}
                </Box>
                <Box component="del" sx={{ color: "text.secondary" }}>
                  {ex.before}
                </Box>
                <br />
                <Box component="ins" sx={{ textDecoration: "none", fontWeight: 600 }}>
                  {ex.after}
                </Box>
              </Typography>
            ))}
          </Stack>
          <Typography variant="caption" color="text.secondary">
            Visitors see the change straight away if the interview is published. Each line can still
            go back to the machine text, but not to an earlier correction.
          </Typography>
          <Stack direction="row" spacing={1}>
            <Button variant="contained" disabled={replace.isPending} onClick={() => void confirm()}>
              {replace.isPending ? "Replacing…" : `Replace in ${lines(matches)}`}
            </Button>
            <Button
              disabled={replace.isPending}
              onClick={() => {
                setChecking(false);
              }}
            >
              Back
            </Button>
          </Stack>
        </Stack>
      ) : null}
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

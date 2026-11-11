import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Divider from "@mui/material/Divider";
import FormControlLabel from "@mui/material/FormControlLabel";
import FormHelperText from "@mui/material/FormHelperText";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode, type SubmitEvent } from "react";

import { searchQueries, type InterviewFilters } from "../api/client";
import { useAuth } from "../auth/useAuth";
import { isFiltered, MEDIA_LABELS, useFilterSummary } from "../filters";
import { ChevronIcon } from "./icons";

// Show the "All …" choice (value "") as the selection rather than an empty box.
const allOption = { select: { displayEmpty: true }, inputLabel: { shrink: true } } as const;

/**
 * Language, interviewee, recording date and media type filters, used by search results and
 * the interview list. Uncontrolled: the choices only matter when applied, and then the page
 * puts them in the URL through `onApply`.
 */
export function FilterPanel({
  filters,
  heading,
  onApply,
  onClear,
  note,
}: {
  filters: InterviewFilters;
  heading: string;
  onApply: (filters: InterviewFilters) => void;
  onClear: () => void;
  note?: ReactNode;
}) {
  const { viewer } = useAuth();
  // Choices come only from interviews this viewer may see (the API filters them).
  const { data, isError } = useQuery({ ...searchQueries.filters(viewer), enabled: viewer.ready });
  const active = [
    filters.language,
    filters.interviewee,
    filters.from ?? filters.to,
    filters.media,
  ].filter((v) => v !== undefined).length;
  const filtered = active > 0;
  // On phones the filters fold away above the results; on wide screens they stay open.
  const [open, setOpen] = useState(false);
  // "Undated" only means something next to a year range, so it waits for a year.
  const [years, setYears] = useState({
    from: filters.from?.slice(0, 4) ?? "",
    to: filters.to?.slice(0, 4) ?? "",
  });
  const hasYear = Boolean(years.from.trim() || years.to.trim());

  const apply = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" && value ? value : undefined;
    };
    const interviewee = text("interviewee");
    const media = text("media");
    // Years typed the wrong way round still mean the span between them.
    const span = [text("fromYear"), text("toYear")];
    if (span[0] && span[1] && span[0] > span[1]) span.reverse();
    const from = span[0] && `${span[0]}-01-01`;
    const to = span[1] && `${span[1]}-12-31`;
    onApply({
      language: text("language"),
      interviewee:
        interviewee === undefined || interviewee === "unknown" ? interviewee : Number(interviewee),
      from,
      to,
      undated: (from ?? to) && form.get("undated") ? true : undefined,
      media: media === "audio" || media === "video" ? media : undefined,
    });
  };

  return (
    <Box sx={{ position: { md: "sticky" }, top: { md: 24 } }}>
      <Button
        variant="outlined"
        aria-expanded={open}
        aria-controls="filters"
        onClick={() => {
          setOpen(!open);
        }}
        sx={{
          display: { md: "none" },
          width: 1,
          justifyContent: "space-between",
          color: "text.primary",
        }}
        endIcon={<ChevronIcon sx={{ transform: open ? "rotate(180deg)" : undefined }} />}
      >
        {filtered ? `Filters · ${String(active)} on` : "Filters"}
      </Button>
      <Stack
        component="form"
        id="filters"
        spacing={2.5}
        onSubmit={apply}
        aria-label={heading}
        sx={{ display: { xs: open ? "flex" : "none", md: "flex" }, mt: { xs: 2, md: 0 } }}
      >
        <Typography
          variant="subtitle1"
          component="h2"
          sx={{ display: { xs: "none", md: "block" } }}
        >
          {heading}
        </Typography>
        {isError ? <Alert severity="warning">Filter choices couldn&apos;t be loaded.</Alert> : null}
        <TextField
          select
          name="language"
          slotProps={allOption}
          label="Language"
          defaultValue={filters.language ?? ""}
          helperText="Any language heard in the interview"
        >
          <MenuItem value="">All languages</MenuItem>
          {data?.languages.map((l) => (
            <MenuItem key={l.code} value={l.code}>
              {l.name}
            </MenuItem>
          ))}
          {/* Keeps a value from a shared link selectable before (or without) the list. */}
          {filters.language && !data?.languages.some((l) => l.code === filters.language) ? (
            <MenuItem value={filters.language}>{filters.language}</MenuItem>
          ) : null}
        </TextField>
        <TextField
          select
          name="interviewee"
          slotProps={allOption}
          label="Interviewee"
          defaultValue={filters.interviewee === undefined ? "" : String(filters.interviewee)}
        >
          <MenuItem value="">All interviewees</MenuItem>
          {data?.interviewees.map((p) => (
            <MenuItem key={p.id} value={String(p.id)}>
              {p.name}
            </MenuItem>
          ))}
          <MenuItem value="unknown">Unknown</MenuItem>
          {typeof filters.interviewee === "number" &&
          !data?.interviewees.some((p) => p.id === filters.interviewee) ? (
            <MenuItem value={String(filters.interviewee)}>
              Interviewee {filters.interviewee}
            </MenuItem>
          ) : null}
        </TextField>
        <TextField
          select
          name="media"
          slotProps={allOption}
          label="Recording"
          defaultValue={filters.media ?? ""}
        >
          <MenuItem value="">Audio and video</MenuItem>
          <MenuItem value="video">{MEDIA_LABELS.video} only</MenuItem>
          <MenuItem value="audio">{MEDIA_LABELS.audio} only</MenuItem>
        </TextField>
        <Stack spacing={1.5}>
          <Typography variant="body2" component="p" sx={{ fontWeight: 600 }}>
            Recording date
          </Typography>
          {/* Proposal: whole years, like the rest of the app's dates; most are known only
              to the year. The URL keeps full dates, so a shared link still works. */}
          <Stack direction="row" spacing={1.5}>
            <TextField
              name="fromYear"
              label="From year"
              defaultValue={years.from}
              onChange={(e) => {
                setYears({ ...years, from: e.target.value });
              }}
              slotProps={{ htmlInput: { inputMode: "numeric", pattern: "[0-9]{4}", maxLength: 4 } }}
              sx={{ flex: 1, minWidth: 0 }}
            />
            <TextField
              name="toYear"
              label="To year"
              defaultValue={years.to}
              onChange={(e) => {
                setYears({ ...years, to: e.target.value });
              }}
              slotProps={{ htmlInput: { inputMode: "numeric", pattern: "[0-9]{4}", maxLength: 4 } }}
              sx={{ flex: 1, minWidth: 0 }}
            />
          </Stack>
          <Box>
            <FormControlLabel
              control={
                <Checkbox
                  name="undated"
                  defaultChecked={filters.undated ?? false}
                  slotProps={{ input: { "aria-describedby": "undated-help" } }}
                />
              }
              disabled={!hasYear}
              label="Also show undated interviews"
              slotProps={{ typography: { variant: "body2" } }}
            />
            <FormHelperText id="undated-help" sx={{ mt: 0 }}>
              Only applies with a year range.
            </FormHelperText>
          </Box>
        </Stack>
        <Stack direction="row" spacing={1}>
          <Button type="submit" variant="outlined">
            Apply filters
          </Button>
          {filtered ? <Button onClick={onClear}>Clear</Button> : null}
        </Stack>
        {note ? (
          <>
            <Divider />
            <Typography variant="body2" color="text.secondary">
              {note}
            </Typography>
          </>
        ) : null}
      </Stack>
    </Box>
  );
}

/** "Filtered by: …" with a Clear button (left out when the page shows its own). */
export function FilterSummary({
  filters,
  onClear,
  showClear = true,
}: {
  filters: InterviewFilters;
  onClear: () => void;
  showClear?: boolean;
}) {
  const summary = useFilterSummary(filters);
  if (!isFiltered(filters)) return null;
  return (
    <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
      <Typography variant="body2">
        <Box component="span" sx={{ color: "text.secondary" }}>
          Filtered by:{" "}
        </Box>
        {summary.join(" · ")}
      </Typography>
      {showClear ? (
        <Button size="small" onClick={onClear}>
          Clear filters
        </Button>
      ) : null}
    </Stack>
  );
}

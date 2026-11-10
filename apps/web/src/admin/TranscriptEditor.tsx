import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Collapse from "@mui/material/Collapse";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import { useForm } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type KeyboardEvent, type SubmitEvent } from "react";

import { ApiError } from "../api/client";
import type { AdminSegment } from "../api/schemas";
import { useAuth } from "../auth/useAuth";
import { PlayIcon, StopIcon } from "../components/icons";
import { formatClock } from "../format";
import { tokens } from "../theme";
import { adminQueries, useEditSegment, useRetranslate } from "./api";
import { FindReplacePanel, type Search } from "./FindReplacePanel";
import {
  countMatchingLines,
  isEnglishSpeech,
  matcher,
  splitMatches,
  type EditorInterview as Interview,
} from "./findReplace";
import { buildEdit } from "./segmentEdit";
import { useSegmentPlayer } from "./useSegmentPlayer";

type Player = ReturnType<typeof useSegmentPlayer>;
/** Where to go after a line closes: stay put, or open the next or previous line. */
type Move = "next" | "prev" | null;

/** Which lines the editor shows. */
export type LineFilter = "all" | "corrected" | "missing";

function isCorrected(line: AdminSegment): boolean {
  return line.original_edited !== null || line.english_edited !== null;
}

/** A line that should have English but has none (Nepal Bhasa often ends up here). */
function isMissingEnglish(line: AdminSegment, interview: Interview): boolean {
  return (
    !isEnglishSpeech(line, interview) && (line.english_edited ?? line.english_machine) === null
  );
}

/** The line the recording is at, or null before anything has played. */
function lineAt(items: AdminSegment[], ms: number | null): AdminSegment | null {
  if (ms === null) return null;
  let found: AdminSegment | null = null;
  for (const line of items) {
    if (line.start_ms > ms) break;
    found = line;
  }
  return found && ms < found.end_ms + 1_000 ? found : null;
}

const JUMP_STEP_MS = 5 * 60_000;

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

/**
 * Line-by-line correction of an interview's transcript and English translation, led by the
 * recording: the player stays at the top, the transcript follows it, and the line playing can
 * be opened for editing in one press. The machine text is never overwritten, so every edit can
 * be undone with "Use machine text".
 */
export function TranscriptEditor({ interview }: { interview: Interview }) {
  const { viewer } = useAuth();
  const { data, isPending, isError } = useQuery({
    ...adminQueries.transcript(viewer, interview.id),
    enabled: viewer.ready,
  });
  const [editing, setEditing] = useState<number | null>(null);
  const [saved, setSaved] = useState(false);
  const [search, setSearch] = useState<Search | null>(null);
  const [finding, setFinding] = useState(false);
  const [filter, setFilter] = useState<LineFilter>("all");
  const [follow, setFollow] = useState(true);
  const player = useSegmentPlayer(interview.id);
  const lineRefs = useRef(new Map<number, HTMLLIElement>());
  const scroller = useRef<HTMLDivElement>(null);
  const isVideo = interview.media?.content_type.startsWith("video/") ?? false;

  const items = data?.items ?? [];
  const re = finding && search ? matcher(search.find, search.matchCase) : null;
  const matches = search ? countMatchingLines(items, search.field, re, interview) : 0;
  const corrected = items.filter(isCorrected).length;
  const missing = items.filter((line) => isMissingEnglish(line, interview)).length;
  const shown =
    filter === "corrected"
      ? items.filter(isCorrected)
      : filter === "missing"
        ? items.filter((line) => isMissingEnglish(line, interview))
        : items;
  const current = lineAt(items, player.currentMs);
  const lastEnd = items.at(-1)?.end_ms ?? 0;
  const jumps = Array.from(
    { length: Math.floor(lastEnd / JUMP_STEP_MS) + 1 },
    (_, i) => i * JUMP_STEP_MS,
  );

  // Scrolls the transcript box only, never the page, so the player stays where it is.
  const scrollTo = (seq: number) => {
    const box = scroller.current;
    const line = lineRefs.current.get(seq);
    if (!box || !line) return;
    const top = line.offsetTop - box.clientHeight / 2 + line.clientHeight / 2;
    if (typeof box.scrollTo === "function")
      box.scrollTo({ top, behavior: prefersReducedMotion() ? "auto" : "smooth" });
    else box.scrollTop = top;
  };

  // Follow the recording: keep the line playing in view, unless a line is open for editing.
  const currentSeq = current?.seq ?? null;
  useEffect(() => {
    if (follow && !player.paused && editing === null && currentSeq !== null) scrollTo(currentSeq);
  }, [currentSeq, follow, player.paused, editing]);

  const open = (seq: number) => {
    setEditing(seq);
    setSaved(false);
  };

  const close = (seq: number, didSave: boolean, move: Move) => {
    if (didSave) setSaved(true);
    const i = shown.findIndex((line) => line.seq === seq);
    const next = move === "next" ? shown[i + 1] : move === "prev" ? shown[i - 1] : undefined;
    setEditing(next?.seq ?? null);
  };

  const jump = (ms: number) => {
    player.seek(ms, !player.paused);
    const first = shown.find((line) => line.end_ms > ms);
    if (first) scrollTo(first.seq);
  };

  const toolbar =
    items.length > 0 ? (
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", alignItems: "center" }}>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={filter}
          onChange={(_e, next: LineFilter | null) => {
            if (next) {
              setFilter(next);
              setEditing(null);
            }
          }}
          aria-label="Show lines"
        >
          <ToggleButton value="all">All {items.length}</ToggleButton>
          <ToggleButton value="corrected">Corrected {corrected}</ToggleButton>
          {missing > 0 ? <ToggleButton value="missing">No English {missing}</ToggleButton> : null}
        </ToggleButtonGroup>
        <Button
          size="small"
          variant={finding ? "contained" : "outlined"}
          aria-expanded={finding}
          aria-controls="find-replace"
          onClick={() => {
            setFinding((f) => !f);
          }}
        >
          Find and replace
        </Button>
        {interview.media ? (
          <>
            <Button
              size="small"
              variant="outlined"
              disabled={current === null}
              onClick={() => {
                if (!current) return;
                player.stop();
                setFilter("all");
                open(current.seq);
                scrollTo(current.seq);
              }}
            >
              Edit the line playing
            </Button>
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={follow}
                  onChange={(e) => {
                    setFollow(e.target.checked);
                  }}
                />
              }
              label="Follow the recording"
              slotProps={{ typography: { variant: "body2" } }}
              sx={{ ml: { sm: "auto" }, mr: 0 }}
            />
          </>
        ) : null}
      </Stack>
    ) : null;

  const jumpTo =
    items.length > 0 && jumps.length > 1 ? (
      <Stack
        component="nav"
        aria-label="Jump to a time"
        direction="row"
        spacing={0.5}
        useFlexGap
        sx={{ flexWrap: "wrap", alignItems: "center" }}
      >
        <Typography variant="caption" color="text.secondary" sx={{ pr: 0.5 }}>
          Jump to
        </Typography>
        {jumps.map((ms) => {
          const here =
            player.currentMs !== null &&
            player.currentMs >= ms &&
            player.currentMs < ms + JUMP_STEP_MS;
          return (
            <Button
              key={ms}
              size="small"
              variant={here ? "contained" : "text"}
              aria-current={here ? "time" : undefined}
              onClick={() => {
                jump(ms);
              }}
              sx={{ minWidth: 0, minHeight: 28, px: 1, fontVariantNumeric: "tabular-nums" }}
            >
              {formatClock(ms)}
            </Button>
          );
        })}
      </Stack>
    ) : null;

  const lines = isError ? (
    <Alert severity="error">The transcript couldn&apos;t be loaded.</Alert>
  ) : isPending ? (
    <Skeleton variant="rounded" height={240} />
  ) : items.length === 0 ? (
    <Typography color="text.secondary" sx={{ p: 2 }}>
      There&apos;s no transcript yet. Lines appear here once transcription has finished.
    </Typography>
  ) : shown.length === 0 ? (
    <Typography color="text.secondary" sx={{ p: 2 }}>
      {filter === "corrected" ? "No lines have been corrected yet." : "Every line has English."}
    </Typography>
  ) : (
    <Box component="ol" sx={{ listStyle: "none", m: 0, p: 0 }}>
      {shown.map((line) => (
        <Box
          component="li"
          key={line.seq}
          ref={(el: HTMLLIElement | null) => {
            if (el) lineRefs.current.set(line.seq, el);
            else lineRefs.current.delete(line.seq);
          }}
          sx={{
            px: { xs: 0.5, sm: 1 },
            py: 1,
            borderBottom: 1,
            borderColor: "divider",
            "&:last-of-type": { borderBottom: 0 },
          }}
        >
          {editing === line.seq ? (
            <LineForm
              interview={interview}
              line={line}
              player={player}
              onDone={(didSave, move) => {
                close(line.seq, didSave, move);
              }}
            />
          ) : (
            <LineView
              interview={interview}
              line={line}
              player={player}
              current={current?.seq === line.seq}
              highlight={search && re ? { field: search.field, re } : null}
              onEdit={() => {
                open(line.seq);
              }}
            />
          )}
        </Box>
      ))}
    </Box>
  );

  return (
    <Paper component="section" aria-labelledby="transcript-title" sx={{ p: { xs: 2, sm: 3 } }}>
      <Stack spacing={2}>
        <Stack spacing={0.5}>
          <Typography id="transcript-title" variant="h3" component="h2">
            Transcript
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ maxWidth: "75ch" }}>
            Play the recording and follow along. When a line is wrong, press “Edit the line playing”
            or click the line. Enter saves, Tab saves and opens the next line. The machine text is
            kept, so any line can go back to it.
          </Typography>
        </Stack>
        {toolbar}
        <Collapse in={finding} id="find-replace" unmountOnExit>
          <FindReplacePanel
            interviewId={interview.id}
            matches={matches}
            onSearch={setSearch}
            onReplaced={() => {
              // An open line would still hold the text from before the replace.
              setEditing(null);
            }}
          />
        </Collapse>
        {saved ? (
          <Typography variant="body2" color="success.main" role="status">
            Saved. Search finds the corrected words within a minute.
          </Typography>
        ) : null}
        {/* Unmounted at zero, so a later batch of edits starts with a fresh button. */}
        {data?.items.some((line) => line.english_stale) ? (
          <StaleEnglish interviewId={interview.id} lines={data.items} />
        ) : null}

        <Box
          sx={{
            display: "grid",
            gap: { xs: 2, md: 3 },
            gridTemplateColumns: {
              xs: "minmax(0, 1fr)",
              md: interview.media
                ? `${isVideo ? "360px" : "280px"} minmax(0, 1fr)`
                : "minmax(0, 1fr)",
            },
            alignItems: "start",
          }}
        >
          {interview.media ? (
            <Stack spacing={1.5}>
              <Box
                component={isVideo ? "video" : "audio"}
                src={interview.media.url}
                controls
                playsInline
                aria-label="Recording"
                {...player.audioProps}
                sx={{
                  width: 1,
                  display: "block",
                  borderRadius: 1,
                  ...(isVideo ? { bgcolor: "#000", aspectRatio: "16 / 9" } : { height: 40 }),
                }}
              />
              {jumpTo}
            </Stack>
          ) : null}
          {/* The lines scroll inside this box, so the recording stays beside them. */}
          <Box
            ref={scroller}
            tabIndex={0}
            role="region"
            aria-label="Transcript lines"
            sx={{
              position: "relative",
              maxHeight: { xs: "65vh", md: "72vh" },
              overflowY: "auto",
              overscrollBehavior: "contain",
              border: 1,
              borderColor: "divider",
              borderRadius: 1,
              bgcolor: "background.paper",
            }}
          >
            {lines}
          </Box>
        </Box>
      </Stack>
    </Paper>
  );
}

/** The line's time; plays the recording straight through from there. */
function Timestamp({
  interview,
  line,
  player,
}: {
  interview: Interview;
  line: AdminSegment;
  player: Player;
}) {
  const clock = formatClock(line.start_ms);
  if (!interview.media)
    return (
      <Typography
        variant="body2"
        color="text.secondary"
        sx={{ fontVariantNumeric: "tabular-nums", minWidth: 56, pt: 0.75 }}
      >
        {clock}
      </Typography>
    );
  return (
    <Button
      size="small"
      onClick={() => {
        player.seek(line.start_ms, true);
      }}
      aria-label={`Play from ${clock}`}
      sx={{ minWidth: 56, px: 0.5, fontVariantNumeric: "tabular-nums", fontWeight: 400 }}
    >
      {clock}
    </Button>
  );
}

/** Plays just this line's audio, or stops it. Hidden when there's no recording to play yet. */
function PlayLine({
  interview,
  line,
  player,
}: {
  interview: Interview;
  line: AdminSegment;
  player: Player;
}) {
  if (!interview.media) return null;
  const playing = player.playing === line.seq;
  const clock = formatClock(line.start_ms);
  return (
    <IconButton
      size="small"
      color="primary"
      onClick={() => {
        player.toggle(line);
      }}
      aria-label={playing ? `Stop line at ${clock}` : `Play line at ${clock}`}
      aria-pressed={playing}
    >
      {playing ? <StopIcon fontSize="small" /> : <PlayIcon fontSize="small" />}
    </IconButton>
  );
}

function Highlighted({ text, re }: { text: string; re: RegExp | null }) {
  return splitMatches(text, re).map((part, i) =>
    part.match ? (
      <Box component="mark" key={i} sx={{ bgcolor: "warning.light", color: "inherit" }}>
        {part.text}
      </Box>
    ) : (
      part.text
    ),
  );
}

function LineView({
  interview,
  line,
  player,
  current,
  highlight,
  onEdit,
}: {
  interview: Interview;
  line: AdminSegment;
  player: Player;
  current: boolean;
  highlight: { field: "original" | "english"; re: RegExp } | null;
  onEdit: () => void;
}) {
  const english = line.english_edited ?? line.english_machine;
  const edited = line.original_edited !== null || line.english_edited !== null;
  const playing = player.playing === line.seq;
  const reFor = (field: "original" | "english") =>
    highlight?.field === field ? highlight.re : null;
  return (
    <Box
      sx={{
        ...lineGrid,
        gridTemplateAreas: {
          xs: '"play time . edit" "text text text text"',
          sm: '"play time text edit"',
        },
        borderRadius: 1,
        bgcolor: playing || current ? tokens.hereTint : undefined,
        boxShadow: current ? `inset 3px 0 0 ${tokens.here}` : undefined,
      }}
      aria-current={current ? "time" : undefined}
    >
      <Box sx={{ gridArea: "play" }}>
        <PlayLine interview={interview} line={line} player={player} />
      </Box>
      <Box sx={{ gridArea: "time" }}>
        <Timestamp interview={interview} line={line} player={player} />
      </Box>
      <Stack
        spacing={0.5}
        // Clicking the text opens the line for editing (the Edit button does the same for
        // keyboards). Selecting text to copy it doesn't.
        onClick={() => {
          const selection = window.getSelection();
          if (selection && !selection.isCollapsed) return;
          onEdit();
        }}
        sx={{
          gridArea: "text",
          minWidth: 0,
          py: 0.75,
          px: 1,
          borderRadius: 1,
          cursor: "text",
          "&:hover": { bgcolor: "action.hover" },
        }}
      >
        <Typography sx={{ overflowWrap: "anywhere" }}>
          <Highlighted
            text={line.original_edited ?? line.original_machine}
            re={reFor("original")}
          />
        </Typography>
        {isEnglishSpeech(line, interview) ? null : (
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ overflowWrap: "anywhere", fontStyle: english === null ? "italic" : undefined }}
          >
            {english === null ? (
              "No English translation"
            ) : (
              <Highlighted text={english} re={reFor("english")} />
            )}
          </Typography>
        )}
        {line.english_edit_stale ? (
          <Typography variant="caption" color="warning.main">
            The original changed after this English was edited. Check the English and save it.
          </Typography>
        ) : line.english_stale ? (
          <Typography variant="caption" color="text.secondary">
            English update pending
          </Typography>
        ) : null}
        {edited ? (
          <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
            <Chip size="small" variant="outlined" label="Edited" />
            {line.edited_by ? (
              <Typography variant="caption" color="text.secondary">
                by {line.edited_by}
              </Typography>
            ) : null}
          </Stack>
        ) : null}
      </Stack>
      <Button
        size="small"
        onClick={onEdit}
        aria-label={`Edit line at ${formatClock(line.start_ms)}`}
        sx={{ gridArea: "edit" }}
      >
        Edit
      </Button>
    </Box>
  );
}

// Play, time, text and Edit in a row; on phones the text gets its own full-width row.
const lineGrid = {
  display: "grid",
  gridTemplateColumns: "auto auto minmax(0, 1fr) auto",
  columnGap: 1,
  alignItems: "start",
} as const;

function saveErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 409)
    return "This interview is being transcribed again, which replaces every line. Try again once that has finished.";
  return "Couldn't save the line. Try again.";
}

function LineForm({
  interview,
  line,
  player,
  onDone,
}: {
  interview: Interview;
  line: AdminSegment;
  player: Player;
  onDone: (saved: boolean, move: Move) => void;
}) {
  const save = useEditSegment(interview.id);
  const englishSpeech = isEnglishSpeech(line, interview);
  // Set by the key that submitted the form, so a save can go on to the next line.
  const move = useRef<Move>(null);
  const form = useForm({
    defaultValues: {
      original: line.original_edited ?? line.original_machine,
      english: line.english_edited ?? line.english_machine ?? "",
    },
    onSubmit: async ({ value }) => {
      const edit = englishSpeech
        ? buildEdit(line, { ...value, english: "" })
        : buildEdit(line, value, { confirmEnglish: line.english_edit_stale });
      if (edit === null) {
        onDone(false, move.current);
        return;
      }
      try {
        await save.mutateAsync({ seq: line.seq, edit });
        onDone(true, move.current);
      } catch {
        // Shown below from save.error; the form stays open with what was typed.
      }
    },
  });
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    void form.handleSubmit();
  };
  const submitAndMove = (to: Move) => {
    move.current = to;
    void form.handleSubmit();
  };
  const lastField = englishSpeech ? "original" : "english";

  // Enter saves (Shift+Enter starts a new line in the text), Tab from the last box saves and
  // opens the next line, Shift+Tab from the first box the previous one, Escape cancels, and
  // Alt+P plays or stops the line's audio.
  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    const target = event.target as HTMLElement;
    if (target.tagName !== "TEXTAREA") return;
    // Typing with an input method (common for Devanagari) uses Enter to pick a word.
    if (event.nativeEvent.isComposing) return;
    const name = target.getAttribute("name");
    if (event.key === "Enter" && !event.shiftKey && !event.altKey && !event.ctrlKey) {
      event.preventDefault();
      submitAndMove(null);
    } else if (event.key === "Tab" && !event.shiftKey && name === lastField) {
      event.preventDefault();
      submitAndMove("next");
    } else if (event.key === "Tab" && event.shiftKey && name === "original") {
      event.preventDefault();
      submitAndMove("prev");
    } else if (event.key === "Escape" && !save.isPending) {
      event.preventDefault();
      onDone(false, null);
    } else if (event.altKey && event.code === "KeyP") {
      event.preventDefault();
      player.toggle(line);
    }
  };
  const clock = formatClock(line.start_ms);

  return (
    <Box
      component="form"
      noValidate
      onSubmit={submit}
      onKeyDown={onKeyDown}
      sx={{
        ...lineGrid,
        gridTemplateAreas: {
          xs: '"play time . ." "text text text text"',
          sm: '"play time text ."',
        },
        rowGap: 1,
      }}
      aria-label={`Edit line at ${clock}`}
    >
      <Box sx={{ gridArea: "play" }}>
        <PlayLine interview={interview} line={line} player={player} />
      </Box>
      <Box sx={{ gridArea: "time" }}>
        <Timestamp interview={interview} line={line} player={player} />
      </Box>
      <Stack spacing={1.5} sx={{ gridArea: "text", minWidth: 0, pt: { sm: 0.5 } }}>
        <form.Field
          name="original"
          validators={{
            onChange: ({ value }) =>
              value.trim() ? undefined : "The original text can't be empty.",
          }}
        >
          {(field) => (
            <MachineAware
              name="original"
              label="Original"
              machine={line.original_machine}
              value={field.state.value}
              error={field.state.meta.errors[0]}
              onChange={field.handleChange}
              autoFocus
            />
          )}
        </form.Field>
        {englishSpeech ? null : (
          <form.Field
            name="english"
            validators={{
              onChange: ({ value }) =>
                !value.trim() && line.english_machine !== null
                  ? "The English can't be empty. Use the machine text to undo your edit."
                  : undefined,
            }}
          >
            {(field) => (
              <MachineAware
                name="english"
                label="English"
                machine={line.english_machine}
                value={field.state.value}
                error={field.state.meta.errors[0]}
                onChange={field.handleChange}
              />
            )}
          </form.Field>
        )}
        {save.isError ? (
          <Typography variant="body2" color="error" role="alert">
            {saveErrorMessage(save.error)}
          </Typography>
        ) : null}
        <form.Subscribe selector={(s) => s.canSubmit}>
          {(canSubmit) => (
            <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
              <Button type="submit" variant="contained" disabled={!canSubmit || save.isPending}>
                {save.isPending ? "Saving…" : "Save"}
              </Button>
              <Button
                onClick={() => {
                  onDone(false, null);
                }}
                disabled={save.isPending}
              >
                Cancel
              </Button>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: { xs: "none", sm: "block" } }}
              >
                Enter saves · Tab saves and goes to the next line · Esc cancels
                {interview.media ? " · Alt+P plays the line" : ""}
              </Typography>
            </Stack>
          )}
        </form.Subscribe>
      </Stack>
    </Box>
  );
}

/** A text box that shows the machine text under it whenever the value differs from it. */
function MachineAware({
  name,
  label,
  machine,
  value,
  error,
  onChange,
  autoFocus = false,
}: {
  name: string;
  label: string;
  machine: string | null;
  value: string;
  error: string | undefined;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}) {
  const differs = machine !== null && value.trim() !== machine;
  return (
    <Stack spacing={0.5}>
      <TextField
        name={name}
        label={label}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        multiline
        minRows={1}
        fullWidth
        autoFocus={autoFocus}
        // Start typing at the end of the line, where corrections usually go.
        onFocus={(e) => {
          const box = e.target as HTMLTextAreaElement;
          box.setSelectionRange(box.value.length, box.value.length);
        }}
        error={Boolean(error)}
        helperText={error ?? (machine === null ? "No machine text for this line." : undefined)}
      />
      {differs ? (
        <Stack direction="row" spacing={1} sx={{ alignItems: "baseline" }}>
          <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
            Machine: {machine}
          </Typography>
          <Button
            size="small"
            onClick={() => {
              onChange(machine);
            }}
            aria-label={`Use machine text for ${label}`}
          >
            Use machine text
          </Button>
        </Stack>
      ) : null}
    </Stack>
  );
}

/** How many lines' English is out of date, with a way to refresh it without waiting. */
function StaleEnglish({ interviewId, lines }: { interviewId: string; lines: AdminSegment[] }) {
  const retranslate = useRetranslate(interviewId);
  const stale = lines.filter((line) => line.english_stale).length;
  return (
    <Alert
      severity="info"
      action={
        <Button
          color="inherit"
          size="small"
          disabled={retranslate.isPending || retranslate.isSuccess}
          onClick={() => {
            retranslate.mutate();
          }}
        >
          Update English now
        </Button>
      }
    >
      {retranslate.isSuccess
        ? "Updating the English now. It appears here in a moment."
        : `The English of ${stale === 1 ? "1 line is" : `${String(stale)} lines are`} out of date because the original changed. It updates on its own a few minutes after the last edit.`}
      {retranslate.isError ? (
        <Typography variant="body2" color="error" role="alert">
          {retranslate.error instanceof ApiError && retranslate.error.status === 409
            ? "This interview is being transcribed again. Try once that has finished."
            : "Couldn't start the update. Try again."}
        </Typography>
      ) : null}
    </Alert>
  );
}

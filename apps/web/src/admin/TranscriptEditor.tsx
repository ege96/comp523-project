import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useForm } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState, type KeyboardEvent, type SubmitEvent } from "react";

import { ApiError } from "../api/client";
import type { AdminSegment } from "../api/schemas";
import { useAuth } from "../auth/useAuth";
import { PlayIcon, StopIcon } from "../components/icons";
import { TextLink } from "../components/links";
import { formatClock } from "../format";
import { adminQueries, useEditSegment } from "./api";
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

/**
 * Line-by-line correction of an interview's transcript and English translation. The machine
 * text is never overwritten, so every edit can be undone with "Use machine text".
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
  const player = useSegmentPlayer(interview.id);

  const items = data?.items ?? [];
  const re = search ? matcher(search.find, search.matchCase) : null;
  const matches = search ? countMatchingLines(items, search.field, re, interview) : 0;

  const close = (seq: number, didSave: boolean, move: Move) => {
    if (didSave) setSaved(true);
    const i = items.findIndex((line) => line.seq === seq);
    const next = move === "next" ? items[i + 1] : move === "prev" ? items[i - 1] : undefined;
    setEditing(next?.seq ?? null);
  };

  return (
    <Paper sx={{ p: { xs: 2, sm: 3 } }}>
      <Stack spacing={2}>
        <Typography variant="h2">Transcript review</Typography>
        <Typography color="text.secondary">
          Correct the transcript or its English one line at a time: click a line to edit it, press
          Enter to save, or Tab to save and go to the next line. The machine text is kept, so you
          can always go back to it.
        </Typography>
        {saved ? (
          <Typography variant="body2" color="success.main" role="status">
            Saved. Search will find the corrected words once the line is re-indexed, usually within
            a minute.
          </Typography>
        ) : null}
        {interview.media ? (
          // One hidden player for every line's play button. An <audio> element plays the
          // sound of a video file too.
          <Box component="audio" src={interview.media.url} {...player.audioProps} hidden />
        ) : null}
        {isError ? (
          <Alert severity="error">The transcript couldn&apos;t be loaded.</Alert>
        ) : isPending ? (
          <Skeleton variant="rounded" height={240} />
        ) : items.length === 0 ? (
          <Typography color="text.secondary">
            There&apos;s no transcript yet. Lines appear here once transcription has finished.
          </Typography>
        ) : (
          <>
            <FindReplacePanel
              interviewId={interview.id}
              matches={matches}
              onSearch={setSearch}
              onReplaced={() => {
                // An open line would still hold the text from before the replace.
                setEditing(null);
              }}
            />
            <Stack component="ol" spacing={1.5} sx={{ listStyle: "none", m: 0, p: 0 }}>
              {items.map((line) => (
                <li key={line.seq}>
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
                      highlight={search && re ? { field: search.field, re } : null}
                      onEdit={() => {
                        setEditing(line.seq);
                        setSaved(false);
                      }}
                    />
                  )}
                </li>
              ))}
            </Stack>
          </>
        )}
      </Stack>
    </Paper>
  );
}

function Timestamp({ interview, line }: { interview: Interview; line: AdminSegment }) {
  return (
    <TextLink
      to="/interviews/$interviewId"
      params={{ interviewId: interview.id }}
      search={{ t: line.start_ms }}
      variant="body2"
      sx={{ fontVariantNumeric: "tabular-nums", minWidth: 56, pt: 0.75 }}
    >
      {formatClock(line.start_ms)}
    </TextLink>
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
  highlight,
  onEdit,
}: {
  interview: Interview;
  line: AdminSegment;
  player: Player;
  highlight: { field: "original" | "english"; re: RegExp } | null;
  onEdit: () => void;
}) {
  const english = line.english_edited ?? line.english_machine;
  const edited = line.original_edited !== null || line.english_edited !== null;
  const playing = player.playing === line.seq;
  const reFor = (field: "original" | "english") =>
    highlight?.field === field ? highlight.re : null;
  return (
    <Stack
      direction="row"
      spacing={1}
      sx={{
        alignItems: "flex-start",
        borderRadius: 1,
        bgcolor: playing ? "action.selected" : undefined,
      }}
    >
      <PlayLine interview={interview} line={line} player={player} />
      <Timestamp interview={interview} line={line} />
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
          flex: 1,
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
      >
        Edit
      </Button>
    </Stack>
  );
}

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
      const edit = buildEdit(line, englishSpeech ? { ...value, english: "" } : value);
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
    <Stack
      component="form"
      noValidate
      onSubmit={submit}
      onKeyDown={onKeyDown}
      spacing={1}
      direction="row"
      sx={{ alignItems: "flex-start" }}
      aria-label={`Edit line at ${clock}`}
    >
      <PlayLine interview={interview} line={line} player={player} />
      <Timestamp interview={interview} line={line} />
      <Stack spacing={1.5} sx={{ flex: 1, minWidth: 0 }}>
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
    </Stack>
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

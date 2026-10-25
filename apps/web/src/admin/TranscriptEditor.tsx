import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Paper from "@mui/material/Paper";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useForm } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { useState, type SubmitEvent } from "react";

import { ApiError } from "../api/client";
import type { AdminSegment, InterviewDetail } from "../api/schemas";
import { useAuth } from "../auth/useAuth";
import { TextLink } from "../components/links";
import { formatClock } from "../format";
import { adminQueries, useEditSegment, useRetranslate } from "./api";
import { buildEdit } from "./segmentEdit";

type Interview = Pick<InterviewDetail, "id" | "primary_language">;

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

  return (
    <Paper sx={{ p: { xs: 2, sm: 3 } }}>
      <Stack spacing={2}>
        <Typography variant="h2">Transcript review</Typography>
        <Typography color="text.secondary">
          Correct the transcript or its English one line at a time. The machine text is kept, so you
          can always go back to it.
        </Typography>
        {saved ? (
          <Typography variant="body2" color="success.main" role="status">
            Saved. Search will find the corrected words once the line is re-indexed, usually within
            a minute.
          </Typography>
        ) : null}
        {/* Unmounted at zero, so a later batch of edits starts with a fresh button. */}
        {data?.items.some((line) => line.english_stale) ? (
          <StaleEnglish interviewId={interview.id} lines={data.items} />
        ) : null}
        {isError ? (
          <Alert severity="error">The transcript couldn&apos;t be loaded.</Alert>
        ) : isPending ? (
          <Skeleton variant="rounded" height={240} />
        ) : data.items.length === 0 ? (
          <Typography color="text.secondary">
            There&apos;s no transcript yet. Lines appear here once transcription has finished.
          </Typography>
        ) : (
          <Stack component="ol" spacing={1.5} sx={{ listStyle: "none", m: 0, p: 0 }}>
            {data.items.map((line) => (
              <li key={line.seq}>
                {editing === line.seq ? (
                  <LineForm
                    interview={interview}
                    line={line}
                    onDone={(didSave) => {
                      setEditing(null);
                      if (didSave) setSaved(true);
                    }}
                  />
                ) : (
                  <LineView
                    interview={interview}
                    line={line}
                    onEdit={() => {
                      setEditing(line.seq);
                      setSaved(false);
                    }}
                  />
                )}
              </li>
            ))}
          </Stack>
        )}
      </Stack>
    </Paper>
  );
}

/** English speech has no separate English translation (english_* stays empty). */
function isEnglishSpeech(line: AdminSegment, interview: Interview): boolean {
  return (line.language ?? interview.primary_language?.code) === "en";
}

function Timestamp({ interview, line }: { interview: Interview; line: AdminSegment }) {
  return (
    <TextLink
      to="/interviews/$interviewId"
      params={{ interviewId: interview.id }}
      search={{ t: line.start_ms }}
      variant="body2"
      sx={{ fontVariantNumeric: "tabular-nums", minWidth: 56 }}
    >
      {formatClock(line.start_ms)}
    </TextLink>
  );
}

function LineView({
  interview,
  line,
  onEdit,
}: {
  interview: Interview;
  line: AdminSegment;
  onEdit: () => void;
}) {
  const english = line.english_edited ?? line.english_machine;
  const edited = line.original_edited !== null || line.english_edited !== null;
  return (
    <Stack direction="row" spacing={2} sx={{ alignItems: "flex-start" }}>
      <Timestamp interview={interview} line={line} />
      <Stack spacing={0.5} sx={{ flex: 1, minWidth: 0 }}>
        <Typography sx={{ overflowWrap: "anywhere" }}>
          {line.original_edited ?? line.original_machine}
        </Typography>
        {isEnglishSpeech(line, interview) ? null : (
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ overflowWrap: "anywhere", fontStyle: english === null ? "italic" : undefined }}
          >
            {english ?? "No English translation"}
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
  onDone,
}: {
  interview: Interview;
  line: AdminSegment;
  onDone: (saved: boolean) => void;
}) {
  const save = useEditSegment(interview.id);
  const englishSpeech = isEnglishSpeech(line, interview);
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
        onDone(false);
        return;
      }
      try {
        await save.mutateAsync({ seq: line.seq, edit });
        onDone(true);
      } catch {
        // Shown below from save.error; the form stays open with what was typed.
      }
    },
  });
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    void form.handleSubmit();
  };
  const clock = formatClock(line.start_ms);

  return (
    <Stack
      component="form"
      noValidate
      onSubmit={submit}
      spacing={1.5}
      direction="row"
      sx={{ alignItems: "flex-start" }}
      aria-label={`Edit line at ${clock}`}
    >
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
              label="Original"
              machine={line.original_machine}
              value={field.state.value}
              error={field.state.meta.errors[0]}
              onChange={field.handleChange}
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
            <Stack direction="row" spacing={1}>
              <Button type="submit" variant="contained" disabled={!canSubmit || save.isPending}>
                {save.isPending ? "Saving…" : "Save"}
              </Button>
              <Button
                onClick={() => {
                  onDone(false);
                }}
                disabled={save.isPending}
              >
                Cancel
              </Button>
            </Stack>
          )}
        </form.Subscribe>
      </Stack>
    </Stack>
  );
}

/** A text box that shows the machine text under it whenever the value differs from it. */
function MachineAware({
  label,
  machine,
  value,
  error,
  onChange,
}: {
  label: string;
  machine: string | null;
  value: string;
  error: string | undefined;
  onChange: (value: string) => void;
}) {
  const differs = machine !== null && value.trim() !== machine;
  return (
    <Stack spacing={0.5}>
      <TextField
        label={label}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        multiline
        minRows={1}
        fullWidth
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

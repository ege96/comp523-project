import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Collapse from "@mui/material/Collapse";
import LinearProgress from "@mui/material/LinearProgress";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useForm } from "@tanstack/react-form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import { useEffect, useRef, useState, type DragEvent, type SubmitEvent } from "react";

import { searchQueries } from "../api/client";
import { useAuth } from "../auth/useAuth";
import { UploadIcon } from "../components/icons";
import { TextLink } from "../components/links";
import { formatBytes } from "../format";
import { adminQueries } from "./api";
import { datePartsError, partsToText } from "./recordedOn";
import { RecordedOnField } from "./RecordedOnField";
import { startUpload, uploadErrorMessage, type UploadHandle } from "./upload";
import { IntervieweeField, LanguageField } from "./UploadFields";
import {
  bytesToSend,
  droppedFiles,
  isLocked,
  isPending,
  listNames,
  NO_SHARED_DETAILS,
  rowsForFiles,
  titleError,
  withSharedDetails,
  type QueueRow,
  type RowStatus,
  type SharedDetails,
} from "./uploadQueue";

const LEAVE_WARNING = "Leave this page? The upload will stop.";
const FILE_ERROR_ID = "upload-file-error";

type Skipped = { notMedia: string[]; duplicates: string[] };

/** Thrown into a waiting upload when the admin presses Stop: tus's abort never settles it. */
class Stopped extends Error {}

/** The form field of one row's detail. */
function rowField<K extends keyof QueueRow>(index: number, key: K) {
  return `rows[${String(index)}].${key}` as `rows[${number}].${K}`;
}

/** A field's first error, once the admin has been in it or pressed Upload. */
function shownError(meta: { isTouched: boolean; errors: (string | undefined)[] }) {
  return meta.isTouched ? meta.errors[0] : undefined;
}

function metadataOf(row: QueueRow) {
  const name = row.interviewee.name.trim();
  return {
    title: row.title.trim(),
    language: row.language || undefined,
    intervieweeId: row.interviewee.id ?? undefined,
    intervieweeName: row.interviewee.id === null && name ? name : undefined,
    recordedOn: partsToText(row.recordedOn) || undefined,
  };
}

/**
 * Add one recording or many. Each file becomes a row with its own title and details; the
 * files are sent one after another, each resuming where it stopped if the connection drops.
 */
export function UploadCard() {
  const { viewer } = useAuth();
  const queryClient = useQueryClient();
  // Interviewees who already have an interview; names aren't unique, so pick by id.
  const { data: filters } = useQuery({ ...searchQueries.filters(viewer), enabled: viewer.ready });
  const { data: space } = useQuery({ ...adminQueries.storage(viewer), enabled: viewer.ready });
  const [status, setStatus] = useState<Record<string, RowStatus>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [skipped, setSkipped] = useState<Skipped | null>(null);
  const [running, setRunning] = useState(false);
  const current = useRef<{ handle: UploadHandle; stop: () => void } | null>(null);
  const stopped = useRef(false);
  const wasStopped = () => stopped.current; // read afresh after each await
  const statusRef = useRef(status);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);
  const formRef = useRef<HTMLFormElement>(null);

  const setRow = (key: string, next: RowStatus) => {
    setStatus((s) => ({ ...s, [key]: next }));
  };

  // Leaving the page stops the upload, so ask first, whether the admin closes the tab or follows
  // a link in the app. Changing tabs or pages of the list stays on this page, so it isn't asked.
  // An upload resumes if the same file is added again with the same details.
  useBlocker({
    shouldBlockFn: ({ current: here, next }) =>
      here.pathname !== next.pathname && !window.confirm(LEAVE_WARNING),
    enableBeforeUnload: running,
    disabled: !running,
  });
  // Leaving after saying yes stops the upload, as the question says.
  useEffect(
    () => () => {
      stopped.current = true;
      current.current?.handle.abort();
      current.current?.stop();
    },
    [],
  );

  const form = useForm({
    defaultValues: { rows: [] as QueueRow[] },
    onSubmit: async ({ value }) => {
      // The form keeps the options it was made with, so read the statuses as they are now.
      const pending = value.rows.filter((r) => isPending(statusRef.current[r.key]));
      if (pending.length === 0) return;
      stopped.current = false;
      setRunning(true);
      setStatus((s) => ({
        ...s,
        ...Object.fromEntries(pending.map((r) => [r.key, { phase: "waiting" } as const])),
      }));
      for (const row of pending) {
        if (wasStopped()) {
          setRow(row.key, { phase: "ready" });
          continue;
        }
        await sendOne(row);
      }
      current.current = null;
      setRunning(false);
      await queryClient.invalidateQueries({ queryKey: ["storage", viewer.key] });
    },
  });

  async function sendOne(row: QueueRow) {
    setRow(row.key, { phase: "uploading", sent: 0 });
    const handle = startUpload(row.file, metadataOf(row), {
      getToken: viewer.getToken,
      onProgress: (sent) => {
        setRow(row.key, { phase: "uploading", sent });
      },
    });
    const stop = new Promise<never>((_resolve, reject) => {
      current.current = {
        handle,
        stop: () => {
          reject(new Stopped());
        },
      };
    });
    try {
      const interviewId = await Promise.race([handle.done, stop]);
      setRow(row.key, { phase: "done", interviewId });
      await Promise.all(
        ["interviews", "search"].map((prefix) =>
          queryClient.invalidateQueries({ queryKey: [prefix, viewer.key] }),
        ),
      );
    } catch (error) {
      setRow(
        row.key,
        error instanceof Stopped
          ? { phase: "ready" }
          : { phase: "failed", message: uploadErrorMessage(error) },
      );
    }
  }

  const stop = () => {
    stopped.current = true;
    current.current?.handle.abort();
    current.current?.stop();
  };

  const addFiles = (files: File[]) => {
    const rows = form.getFieldValue("rows");
    const added = rowsForFiles(rows, files);
    setSkipped(added.notMedia.length || added.duplicates.length ? added : null);
    if (added.rows.length) form.setFieldValue("rows", [...rows, ...added.rows]);
  };

  const removeRow = (key: string) => {
    form.setFieldValue(
      "rows",
      form.getFieldValue("rows").filter((r) => r.key !== key),
    );
    setStatus((s) => Object.fromEntries(Object.entries(s).filter(([k]) => k !== key)));
  };

  const clearFinished = () => {
    form.setFieldValue(
      "rows",
      form.getFieldValue("rows").filter((r) => status[r.key]?.phase !== "done"),
    );
  };

  const fillShared = (shared: SharedDetails) => {
    form.setFieldValue(
      "rows",
      form
        .getFieldValue("rows")
        .map((r) => (isLocked(status[r.key]) ? r : withSharedDetails(r, shared))),
    );
  };

  // A plain render function, not a component: its fields belong to this card's form.
  function renderRow(row: QueueRow, index: number, rows: readonly QueueRow[]) {
    const rowStatus = status[row.key];
    const maxUploadBytes = space?.max_upload_bytes;
    const interviewees = filters?.interviewees ?? [];
    const foldable = rows.length > 1;
    const isOpen = !foldable || (open[row.key] ?? false);
    const locked = isLocked(rowStatus);
    const tooBig = maxUploadBytes !== undefined && row.file.size > maxUploadBytes;
    const detailsId = `upload-details-${row.key}`;
    return (
      <Paper
        key={row.key}
        variant="outlined"
        role="group"
        aria-label={row.file.name}
        sx={{ p: { xs: 1.5, sm: 2 } }}
      >
        <Stack spacing={2}>
          <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography sx={{ fontWeight: 600, overflowWrap: "anywhere" }}>
                {row.file.name}
              </Typography>
              <Typography variant="body2" color={tooBig ? "error" : "text.secondary"}>
                {formatBytes(row.file.size)}
                {tooBig ? ` · larger than the ${formatBytes(maxUploadBytes)} limit` : ""}
              </Typography>
            </Box>
            {locked ? null : (
              <Button
                size="small"
                onClick={() => {
                  removeRow(row.key);
                }}
                aria-label={`Remove ${row.file.name}`}
              >
                Remove
              </Button>
            )}
          </Stack>

          <form.Field
            name={rowField(index, "title")}
            validators={{ onChange: ({ value }) => titleError(value) }}
          >
            {(field) => (
              <TextField
                label="Interview title"
                required
                value={field.state.value}
                disabled={locked}
                onChange={(e) => {
                  field.handleChange(e.target.value);
                }}
                onBlur={field.handleBlur}
                error={shownError(field.state.meta) !== undefined}
                helperText={shownError(field.state.meta)}
              />
            )}
          </form.Field>

          {foldable ? (
            <Button
              size="small"
              onClick={() => {
                setOpen((o) => ({ ...o, [row.key]: !(o[row.key] ?? false) }));
              }}
              aria-expanded={isOpen}
              aria-controls={detailsId}
              sx={{ alignSelf: "flex-start" }}
            >
              {isOpen ? "Hide other details" : "Interviewee, language and date"}
            </Button>
          ) : null}
          <Collapse in={isOpen} id={detailsId} unmountOnExit={false}>
            <Stack spacing={2.5}>
              <form.Field name={rowField(index, "interviewee")}>
                {(field) => (
                  <IntervieweeField
                    value={field.state.value}
                    options={interviewees}
                    disabled={locked}
                    onChange={field.handleChange}
                  />
                )}
              </form.Field>
              <form.Field name={rowField(index, "language")}>
                {(field) => (
                  <LanguageField
                    value={field.state.value}
                    disabled={locked}
                    onChange={field.handleChange}
                  />
                )}
              </form.Field>
              <form.Field
                name={rowField(index, "recordedOn")}
                validators={{ onChange: ({ value }) => datePartsError(value) }}
              >
                {(field) => (
                  <RecordedOnField
                    value={field.state.value}
                    onChange={field.handleChange}
                    onBlur={field.handleBlur}
                    error={shownError(field.state.meta)}
                    disabled={locked}
                  />
                )}
              </form.Field>
            </Stack>
          </Collapse>

          <RowProgress
            row={row}
            status={rowStatus}
            onRetry={() => {
              if (!running) void form.handleSubmit();
            }}
          />
        </Stack>
      </Paper>
    );
  }

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    void form.handleSubmit().then(() => {
      if (form.state.isValid) return;
      // A bad date hides in a folded row: unfold those, then take the admin to the first error.
      const bad = form.getFieldValue("rows").filter((r) => datePartsError(r.recordedOn));
      setOpen((o) => ({ ...o, ...Object.fromEntries(bad.map((r) => [r.key, true])) }));
      window.setTimeout(() => {
        formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      }, 0);
    });
  };

  return (
    <Paper sx={{ p: { xs: 2, sm: 3 } }}>
      <Stack component="form" ref={formRef} spacing={2.5} noValidate onSubmit={submit}>
        <Stack spacing={0.5}>
          <Typography variant="h2">Add interviews</Typography>
          <Typography variant="body2" color="text.secondary">
            Add one recording or several. Only a title is needed for each; everything else can be
            added later.
          </Typography>
        </Stack>

        <form.Field
          name="rows"
          mode="array"
          validators={{
            onChange: ({ value }) => (value.length ? undefined : "Choose a recording to upload"),
          }}
        >
          {(field) => {
            const rows = field.state.value;
            const pending = rows.filter((r) => isPending(status[r.key])).length;
            const finished = rows.filter((r) => status[r.key]?.phase === "done").length;
            const toSend = bytesToSend(rows, status);
            return (
              <>
                <FileDrop
                  compact={rows.length > 0}
                  error={shownError(field.state.meta)}
                  onFiles={(files) => {
                    addFiles(files);
                    field.handleBlur();
                  }}
                />
                {skipped ? <SkippedNote skipped={skipped} /> : null}

                {rows.length > 1 ? (
                  <SharedDetailsBar
                    interviewees={filters?.interviewees ?? []}
                    disabled={pending === 0}
                    onFill={fillShared}
                  />
                ) : null}

                {rows.map((row, i) => renderRow(row, i, rows))}

                {rows.length > 0 && toSend > 0 && space ? (
                  toSend > space.usable_bytes ? (
                    <Alert severity="warning">
                      {formatBytes(toSend)} to upload, but only {formatBytes(space.usable_bytes)} of
                      space is left. Upload fewer recordings, or ask the archive&rsquo;s operator to
                      add storage.
                    </Alert>
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      {formatBytes(toSend)} to upload · {formatBytes(space.usable_bytes)} of space
                      left
                    </Typography>
                  )
                ) : null}

                <Stack
                  direction={{ xs: "column", sm: "row" }}
                  spacing={2}
                  sx={{ alignItems: { sm: "center" }, justifyContent: "space-between" }}
                >
                  <Typography variant="body2" color="text.secondary">
                    {running
                      ? "Keep this page open. If the connection drops, each upload carries on from where it stopped."
                      : "They stay Private until you publish them. Transcripts are made automatically once each upload finishes."}
                  </Typography>
                  <Stack direction="row" spacing={1} sx={{ flexShrink: 0 }}>
                    {finished > 0 && !running ? (
                      <Button onClick={clearFinished}>Clear finished</Button>
                    ) : null}
                    {running ? (
                      <Button onClick={stop}>Stop</Button>
                    ) : (
                      <Button type="submit" variant="contained">
                        {pending > 1 ? `Upload ${String(pending)} recordings` : "Upload"}
                      </Button>
                    )}
                  </Stack>
                </Stack>
              </>
            );
          }}
        </form.Field>
      </Stack>
    </Paper>
  );
}

function RowProgress({
  row,
  status,
  onRetry,
}: {
  row: QueueRow;
  status: RowStatus | undefined;
  onRetry: () => void;
}) {
  switch (status?.phase) {
    case undefined:
    case "ready":
      return null;
    case "waiting":
      return (
        <Typography variant="body2" color="text.secondary">
          Waiting to upload
        </Typography>
      );
    case "uploading": {
      const total = row.file.size;
      const percent = total > 0 ? Math.floor((status.sent / total) * 100) : 0;
      return (
        <Stack spacing={1}>
          <Stack direction="row" spacing={2} sx={{ justifyContent: "space-between" }}>
            <Typography variant="body2">
              Uploading · {formatBytes(status.sent)} of {formatBytes(total)}
            </Typography>
            <Typography variant="body2" color="primary">
              {percent}%
            </Typography>
          </Stack>
          <LinearProgress
            variant="determinate"
            value={percent}
            aria-label={`Upload progress of ${row.file.name}`}
          />
        </Stack>
      );
    }
    case "done":
      return (
        <Alert severity="success">
          Uploaded. Processing has started.{" "}
          <TextLink
            to="/admin/interviews/$interviewId"
            params={{ interviewId: status.interviewId }}
          >
            Follow its progress
          </TextLink>
        </Alert>
      );
    case "failed":
      return (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={onRetry}>
              Retry
            </Button>
          }
        >
          {status.message} Retry carries on from where it stopped.
        </Alert>
      );
  }
}

function SharedDetailsBar({
  interviewees,
  disabled,
  onFill,
}: {
  interviewees: readonly { id: number; name: string }[];
  disabled: boolean;
  onFill: (shared: SharedDetails) => void;
}) {
  const [shown, setShown] = useState(false);
  const [shared, setShared] = useState<SharedDetails>(NO_SHARED_DETAILS);
  const dateError = datePartsError(shared.recordedOn);
  return (
    <Box>
      <Button
        size="small"
        onClick={() => {
          setShown((s) => !s);
        }}
        aria-expanded={shown}
        disabled={disabled}
      >
        Same details for all recordings
      </Button>
      <Collapse in={shown}>
        <Paper
          variant="outlined"
          role="group"
          aria-label="Same details for all recordings"
          sx={{ p: { xs: 1.5, sm: 2 }, mt: 1 }}
        >
          <Stack spacing={2.5}>
            <Typography variant="body2" color="text.secondary">
              Fills in what each recording leaves empty. What you have typed for a recording stays.
            </Typography>
            <IntervieweeField
              value={shared.interviewee}
              options={interviewees}
              onChange={(interviewee) => {
                setShared((s) => ({ ...s, interviewee }));
              }}
            />
            <LanguageField
              value={shared.language}
              emptyLabel="Leave as it is"
              onChange={(language) => {
                setShared((s) => ({ ...s, language }));
              }}
            />
            <RecordedOnField
              value={shared.recordedOn}
              error={dateError}
              onChange={(recordedOn) => {
                setShared((s) => ({ ...s, recordedOn }));
              }}
            />
            <Button
              variant="outlined"
              disabled={dateError !== undefined}
              onClick={() => {
                onFill(shared);
              }}
              sx={{ alignSelf: "flex-start" }}
            >
              Fill in all recordings
            </Button>
          </Stack>
        </Paper>
      </Collapse>
    </Box>
  );
}

function SkippedNote({ skipped }: { skipped: Skipped }) {
  return (
    <Alert severity="info">
      {skipped.notMedia.length
        ? `Skipped ${listNames(skipped.notMedia)}: not audio or video. `
        : ""}
      {skipped.duplicates.length ? `${listNames(skipped.duplicates)} already in the list.` : ""}
    </Alert>
  );
}

function FileDrop({
  compact,
  error,
  onFiles,
}: {
  compact: boolean;
  error: string | undefined;
  onFiles: (files: File[]) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  useEffect(() => {
    // Not a React prop: lets the second picker choose a whole folder (and its subfolders).
    if (folderInput.current) folderInput.current.webkitdirectory = true;
  }, []);
  const drop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    void droppedFiles(event.dataTransfer).then(onFiles);
  };
  const picked = (input: HTMLInputElement) => {
    onFiles(Array.from(input.files ?? []));
    input.value = ""; // so choosing the same files again still fires
  };
  return (
    <Box>
      <Box
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => {
          setOver(false);
        }}
        onDrop={drop}
        sx={{
          px: 2,
          py: compact ? 1.5 : 3,
          border: "1px dashed",
          borderColor: error ? "error.main" : over ? "primary.main" : "text.disabled",
          borderRadius: 1,
          bgcolor: over ? "action.hover" : "background.default",
          display: "flex",
          flexDirection: compact ? "row" : "column",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          gap: 1.5,
        }}
      >
        {compact ? null : <UploadIcon aria-hidden sx={{ color: "primary.main", fontSize: 32 }} />}
        <Box sx={{ minWidth: 0, maxWidth: 1 }}>
          <Typography sx={{ fontWeight: 600 }}>
            {compact
              ? "Drop more files or folders here"
              : "Drop video or audio files, or a folder, here"}
          </Typography>
          {compact ? null : (
            <Typography variant="body2" color="text.secondary">
              For example MP4, MOV, MP3 or WAV
            </Typography>
          )}
        </Box>
        <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", justifyContent: "center" }}>
          <Button
            variant="outlined"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? FILE_ERROR_ID : undefined}
            onClick={() => fileInput.current?.click()}
          >
            Choose files
          </Button>
          <Button variant="outlined" onClick={() => folderInput.current?.click()}>
            Choose a folder
          </Button>
        </Stack>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          accept="audio/*,video/*"
          aria-label="Recording files"
          aria-describedby={error ? FILE_ERROR_ID : undefined}
          onChange={(e) => {
            picked(e.target);
          }}
        />
        <input
          ref={folderInput}
          type="file"
          hidden
          aria-label="Folder of recordings"
          onChange={(e) => {
            picked(e.target);
          }}
        />
      </Box>
      {error ? (
        <Typography
          id={FILE_ERROR_ID}
          role="alert"
          variant="caption"
          color="error"
          component="p"
          sx={{ mx: 1.75 }}
        >
          {error}
        </Typography>
      ) : null}
    </Box>
  );
}

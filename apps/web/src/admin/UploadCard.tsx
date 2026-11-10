import Alert from "@mui/material/Alert";
import Autocomplete from "@mui/material/Autocomplete";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import LinearProgress from "@mui/material/LinearProgress";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useForm } from "@tanstack/react-form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type DragEvent, type SubmitEvent } from "react";

import { searchQueries } from "../api/client";
import { useAuth } from "../auth/useAuth";
import { UploadIcon } from "../components/icons";
import { TextLink } from "../components/links";
import { formatBytes } from "../format";
import { UPLOAD_LANGUAGES } from "./status";
import { datePartsError, NO_DATE, partsToText } from "./recordedOn";
import { RecordedOnField } from "./RecordedOnField";
import { startUpload, uploadErrorMessage, type UploadHandle } from "./upload";

type Interviewee = { id: number | null; name: string };

type UploadState =
  | { phase: "idle" }
  | { phase: "uploading"; fileName: string; sent: number; total: number; handle: UploadHandle }
  | { phase: "done"; interviewId: string; title: string }
  | { phase: "error"; message: string };

const NO_INTERVIEWEE: Interviewee = { id: null, name: "" };

function baseName(file: File): string {
  return file.name.replace(/\.[^.]+$/, "");
}

/** A field's first error, once the admin has been in it or pressed Upload. */
function shownError(meta: { isTouched: boolean; errors: (string | undefined)[] }) {
  return meta.isTouched ? meta.errors[0] : undefined;
}

function fileError(file: File | null): string | undefined {
  if (!file) return "Choose a recording to upload";
  if (!/^(audio|video)\//.test(file.type)) return "Choose an audio or video file";
  return undefined;
}

/**
 * Upload a recording with its metadata (D-004: only the title is required). The file goes
 * up in resumable chunks; the interview appears once the last byte is in, Private, and
 * processing starts on its own.
 */
export function UploadCard() {
  const { viewer } = useAuth();
  const queryClient = useQueryClient();
  const [upload, setUpload] = useState<UploadState>({ phase: "idle" });
  const uploading = upload.phase === "uploading";
  // Interviewees who already have an interview; names aren't unique, so pick by id.
  const { data: filters } = useQuery({
    ...searchQueries.filters(viewer),
    enabled: viewer.ready,
  });

  // Leaving the page stops the upload, so ask first. It resumes if the same file is chosen
  // again with the same details.
  useEffect(() => {
    if (!uploading) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
    };
  }, [uploading]);

  const form = useForm({
    defaultValues: {
      file: null as File | null,
      title: "",
      interviewee: NO_INTERVIEWEE,
      language: "",
      recordedOn: NO_DATE,
    },
    onSubmit: async ({ value, formApi }) => {
      const file = value.file;
      if (!file) return;
      const name = value.interviewee.name.trim();
      const title = value.title.trim();
      const handle = startUpload(
        file,
        {
          title,
          language: value.language || undefined,
          intervieweeId: value.interviewee.id ?? undefined,
          intervieweeName: value.interviewee.id === null && name ? name : undefined,
          recordedOn: partsToText(value.recordedOn) || undefined,
        },
        {
          getToken: viewer.getToken,
          onProgress: (sent, total) => {
            setUpload((s) => (s.phase === "uploading" ? { ...s, sent, total } : s));
          },
        },
      );
      setUpload({ phase: "uploading", fileName: file.name, sent: 0, total: file.size, handle });
      try {
        const interviewId = await handle.done;
        setUpload({ phase: "done", interviewId, title });
        formApi.reset();
        await Promise.all(
          ["interviews", "search"].map((prefix) =>
            queryClient.invalidateQueries({ queryKey: [prefix, viewer.key] }),
          ),
        );
      } catch (error) {
        setUpload({ phase: "error", message: uploadErrorMessage(error) });
      }
    },
  });

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    void form.handleSubmit();
  };

  const cancel = () => {
    if (upload.phase !== "uploading") return;
    upload.handle.abort();
    setUpload({ phase: "idle" });
  };

  return (
    <Paper sx={{ p: { xs: 2, sm: 3 } }}>
      <Stack component="form" spacing={2.5} noValidate onSubmit={submit}>
        <Stack spacing={0.5}>
          <Typography variant="h2">Add a recording</Typography>
          <Typography variant="body2" color="text.secondary">
            Only the file and a title are needed. Everything else can be added later.
          </Typography>
        </Stack>

        <form.Field name="file" validators={{ onChange: ({ value }) => fileError(value) }}>
          {(field) => (
            <FileDrop
              file={field.state.value}
              disabled={uploading}
              error={shownError(field.state.meta)}
              onFile={(file) => {
                // Prefill the title from the file name, unless the admin has typed their own.
                const title = form.getFieldValue("title").trim();
                const previous = field.state.value;
                if (!title || (previous && title === baseName(previous)))
                  form.setFieldValue("title", baseName(file));
                field.handleChange(file);
              }}
            />
          )}
        </form.Field>

        <form.Field
          name="title"
          validators={{
            onChange: ({ value }) =>
              !value.trim()
                ? "Enter a title"
                : value.trim().length > 500
                  ? "Keep the title under 500 characters"
                  : undefined,
          }}
        >
          {(field) => (
            <TextField
              label="Interview title"
              required
              name={field.name}
              value={field.state.value}
              disabled={uploading}
              onChange={(e) => {
                field.handleChange(e.target.value);
              }}
              onBlur={field.handleBlur}
              error={shownError(field.state.meta) !== undefined}
              helperText={shownError(field.state.meta)}
            />
          )}
        </form.Field>

        <Stack spacing={2.5}>
          <form.Field name="interviewee">
            {(field) => (
              <Autocomplete
                freeSolo
                fullWidth
                disabled={uploading}
                options={filters?.interviewees ?? []}
                getOptionLabel={(o) => (typeof o === "string" ? o : o.name)}
                getOptionKey={(o) => (typeof o === "string" ? o : o.id)}
                value={filters?.interviewees.find((o) => o.id === field.state.value.id) ?? null}
                inputValue={field.state.value.name}
                onChange={(_e, option) => {
                  field.handleChange(
                    typeof option === "object" && option
                      ? { id: option.id, name: option.name }
                      : { id: null, name: option ?? "" },
                  );
                }}
                onInputChange={(_e, text, reason) => {
                  // "reset" follows picking an option, which onChange already handled.
                  if (reason !== "reset") field.handleChange({ id: null, name: text });
                }}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label="Interviewee"
                    helperText={
                      field.state.value.id !== null
                        ? "An existing interviewee"
                        : field.state.value.name.trim()
                          ? "A new interviewee will be added"
                          : "Optional. Leave empty if unknown."
                    }
                  />
                )}
              />
            )}
          </form.Field>
          <form.Field name="language">
            {(field) => (
              <TextField
                select
                fullWidth
                label="Original language"
                name={field.name}
                value={field.state.value}
                disabled={uploading}
                onChange={(e) => {
                  field.handleChange(e.target.value);
                }}
                helperText="Leave on detect unless you know it. Nepal Bhasa is often detected as Nepali."
              >
                <MenuItem value="">Detect from the audio</MenuItem>
                {UPLOAD_LANGUAGES.map((l) => (
                  <MenuItem key={l.code} value={l.code}>
                    {l.name}
                  </MenuItem>
                ))}
              </TextField>
            )}
          </form.Field>
        </Stack>

        <form.Field
          name="recordedOn"
          validators={{ onChange: ({ value }) => datePartsError(value) }}
        >
          {(field) => (
            <RecordedOnField
              value={field.state.value}
              onChange={field.handleChange}
              onBlur={field.handleBlur}
              error={shownError(field.state.meta)}
              disabled={uploading}
            />
          )}
        </form.Field>

        <UploadStatus upload={upload} onCancel={cancel} />

        <Stack
          direction={{ xs: "column", sm: "row" }}
          spacing={2}
          sx={{ alignItems: { sm: "center" }, justifyContent: "space-between" }}
        >
          <Typography variant="body2" color="text.secondary">
            It stays Private until you publish it. The transcript is made automatically once the
            upload finishes.
          </Typography>
          <Button type="submit" variant="contained" disabled={uploading} sx={{ flexShrink: 0 }}>
            Upload
          </Button>
        </Stack>
      </Stack>
    </Paper>
  );
}

function FileDrop({
  file,
  disabled,
  error,
  onFile,
}: {
  file: File | null;
  disabled: boolean;
  error: string | undefined;
  onFile: (file: File) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const drop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    const dropped = event.dataTransfer.files[0];
    if (dropped && !disabled) onFile(dropped);
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
          py: 3,
          border: "1px dashed",
          borderColor: error ? "error.main" : over ? "primary.main" : "text.disabled",
          borderRadius: 1,
          bgcolor: over ? "action.hover" : "background.default",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          textAlign: "center",
          gap: 1.5,
        }}
      >
        <UploadIcon aria-hidden sx={{ color: "primary.main", fontSize: 32 }} />
        <Box sx={{ minWidth: 0, maxWidth: 1 }}>
          <Typography sx={{ fontWeight: 600, overflowWrap: "anywhere" }}>
            {file ? file.name : "Drop a video or audio file here"}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {file ? formatBytes(file.size) : "For example MP4, MOV, MP3 or WAV"}
          </Typography>
        </Box>
        <Button variant="outlined" disabled={disabled} onClick={() => input.current?.click()}>
          {file ? "Choose another file" : "Choose file"}
        </Button>
        <input
          ref={input}
          type="file"
          hidden
          accept="audio/*,video/*"
          aria-label="Recording file"
          onChange={(e) => {
            const chosen = e.target.files?.[0];
            if (chosen) onFile(chosen);
            e.target.value = ""; // so choosing the same file again still fires
          }}
        />
      </Box>
      {error ? (
        <Typography variant="caption" color="error" sx={{ mx: 1.75 }}>
          {error}
        </Typography>
      ) : null}
    </Box>
  );
}

function UploadStatus({ upload, onCancel }: { upload: UploadState; onCancel: () => void }) {
  switch (upload.phase) {
    case "idle":
      return null;
    case "uploading": {
      const percent = upload.total > 0 ? Math.floor((upload.sent / upload.total) * 100) : 0;
      return (
        <Stack spacing={1}>
          <Stack direction="row" spacing={2} sx={{ justifyContent: "space-between" }}>
            <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
              Uploading {upload.fileName} · {formatBytes(upload.sent)} of{" "}
              {formatBytes(upload.total)}
            </Typography>
            <Typography variant="body2" color="primary">
              {percent}%
            </Typography>
          </Stack>
          <LinearProgress variant="determinate" value={percent} aria-label="Upload progress" />
          <Stack direction="row" spacing={2} sx={{ alignItems: "center" }}>
            <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
              Keep this page open. If the connection drops, the upload carries on from where it
              stopped.
            </Typography>
            <Button size="small" onClick={onCancel}>
              Cancel
            </Button>
          </Stack>
        </Stack>
      );
    }
    case "done":
      return (
        <Alert severity="success">
          Uploaded &ldquo;{upload.title}&rdquo;. Processing has started.{" "}
          <TextLink
            to="/admin/interviews/$interviewId"
            params={{ interviewId: upload.interviewId }}
          >
            Follow its progress
          </TextLink>
        </Alert>
      );
    case "error":
      return (
        <Alert severity="error">
          {upload.message} Press Upload to try again; it carries on from where it stopped.
        </Alert>
      );
  }
}

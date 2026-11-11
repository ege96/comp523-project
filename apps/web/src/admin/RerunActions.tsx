import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useState, type ReactNode } from "react";

import type { InterviewDetail, Job } from "../api/schemas";
import { CorrectionsWouldBeLost, useRerun, useRetranslate } from "./api";
import { languageMismatch, retryStepFor } from "./rerun";

function languageOf(interview: InterviewDetail): string {
  return interview.primary_language?.name ?? "the detected language";
}

export function RerunActions({ interview }: { interview: InterviewDetail }) {
  const rerun = useRerun(interview.id);
  const [confirming, setConfirming] = useState<"transcribe" | "replace" | null>(null);
  const busy = interview.status === "processing" || rerun.isPending;
  const mismatch = languageMismatch(interview);
  const corrected = rerun.error instanceof CorrectionsWouldBeLost ? rerun.error.correctedLines : 0;
  const failed = rerun.isError && !(rerun.error instanceof CorrectionsWouldBeLost);

  const transcribe = (replaceCorrections: boolean) => {
    rerun.mutate(
      { step: "transcribe", replaceCorrections },
      {
        onSuccess: () => {
          setConfirming(null);
        },
        onError: (error) => {
          setConfirming(error instanceof CorrectionsWouldBeLost ? "replace" : null);
        },
      },
    );
  };
  const close = () => {
    setConfirming(null);
    rerun.reset();
  };

  return (
    <Stack spacing={2}>
      {mismatch ? (
        <Alert severity="info">
          The language was set to {mismatch} after the transcript was made. Translate again to redo
          the English from {mismatch}. If the transcript itself is wrong, transcribe again.
        </Alert>
      ) : null}
      <RerunOption
        title="Transcribe again"
        text="When the transcript is mostly wrong, for example because the language was wrong. It replaces the transcript and the English."
      >
        <Button
          variant="outlined"
          size="small"
          disabled={busy}
          onClick={() => {
            rerun.reset();
            setConfirming("transcribe");
          }}
        >
          Transcribe again
        </Button>
      </RerunOption>
      <RerunOption
        title="Translate again"
        text="When the English is poor or missing. The transcript and your corrections to it stay as they are."
      >
        <Button
          variant="outlined"
          size="small"
          disabled={busy}
          onClick={() => {
            rerun.mutate({ step: "translate" });
          }}
        >
          Translate again
        </Button>
      </RerunOption>
      {busy && interview.status === "processing" ? (
        <Typography variant="body2" color="text.secondary">
          These can be used once processing has finished.
        </Typography>
      ) : null}
      {failed ? (
        <Alert severity="error">That step couldn&apos;t be started. Try again.</Alert>
      ) : null}

      <Dialog open={confirming !== null} onClose={close} aria-labelledby="rerun-title">
        <DialogTitle id="rerun-title">Transcribe again in {languageOf(interview)}?</DialogTitle>
        <DialogContent>
          {confirming === "replace" ? (
            <DialogContentText>
              {corrected === 1 ? "1 line has" : `${String(corrected)} lines have`} corrections.
              Transcribing again replaces every line with new machine text, and the corrections are
              lost. This can&apos;t be undone.
            </DialogContentText>
          ) : (
            <DialogContentText>
              This makes a new transcript and English from the audio, replacing the current ones. It
              takes a while and uses the transcription service again.
            </DialogContentText>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="contained"
            color={confirming === "replace" ? "error" : "primary"}
            disabled={rerun.isPending}
            onClick={() => {
              transcribe(confirming === "replace");
            }}
          >
            {confirming === "replace" ? "Replace corrections" : "Transcribe again"}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

function RerunOption({
  title,
  text,
  children,
}: {
  title: string;
  text: string;
  children: ReactNode;
}) {
  return (
    <Stack
      direction={{ xs: "column", sm: "row" }}
      spacing={{ xs: 1, sm: 2 }}
      sx={{ alignItems: { sm: "center" }, justifyContent: "space-between" }}
    >
      <Stack spacing={0.25} sx={{ minWidth: 0 }}>
        <Typography sx={{ fontWeight: 600 }}>{title}</Typography>
        <Typography variant="body2" color="text.secondary">
          {text}
        </Typography>
      </Stack>
      <Stack sx={{ flexShrink: 0, alignItems: "flex-start" }}>{children}</Stack>
    </Stack>
  );
}

/** Run a failed step again. Re-transcribing goes through the same warning as above. */
export function RetryButton({
  interview,
  job,
  label = "Try again",
  variant = "outlined",
}: {
  interview: InterviewDetail;
  job: Job;
  label?: string;
  variant?: "outlined" | "contained";
}) {
  const step = retryStepFor(job.kind);
  const rerun = useRerun(interview.id);
  const retranslate = useRetranslate(interview.id);
  const pending = rerun.isPending || retranslate.isPending;
  if (step === null) return null;
  if (rerun.error instanceof CorrectionsWouldBeLost)
    return (
      <Typography variant="body2">
        Lines have corrections. Use &ldquo;Transcribe again&rdquo; under &ldquo;Fix a
        problem&rdquo;.
      </Typography>
    );
  return (
    <Stack spacing={0.5} sx={{ alignItems: "flex-start" }}>
      <Button
        variant={variant}
        size="small"
        disabled={pending}
        onClick={() => {
          if (step === "retranslate") retranslate.mutate();
          else rerun.mutate({ step });
        }}
      >
        {label}
      </Button>
      {rerun.isError || retranslate.isError ? (
        <Typography variant="body2" color="error" role="alert">
          That didn&apos;t start. Check your connection and try again.
        </Typography>
      ) : null}
    </Stack>
  );
}

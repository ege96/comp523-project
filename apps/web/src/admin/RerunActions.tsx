import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import Stack from "@mui/material/Stack";
import { useState } from "react";

import type { InterviewDetail, Job } from "../api/schemas";
import { CorrectionsWouldBeLost, useRerun, useRetranslate } from "./api";
import { languageMismatch, retryStepFor } from "./rerun";

function languageOf(interview: InterviewDetail): string {
  return interview.primary_language?.name ?? "the detected language";
}

/**
 * "Transcribe again" and "Translate again", for after the language was corrected (D-004) or
 * when the machine output is poor. Transcribing again asks first, and warns when it would
 * replace corrections (P-013).
 */
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
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
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
      </Stack>
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

/** Run a failed step again. Re-transcribing goes through the same warning as above. */
export function RetryButton({ interview, job }: { interview: InterviewDetail; job: Job }) {
  const step = retryStepFor(job.kind);
  const rerun = useRerun(interview.id);
  const retranslate = useRetranslate(interview.id);
  const pending = rerun.isPending || retranslate.isPending;
  if (step === null) return null;
  if (rerun.error instanceof CorrectionsWouldBeLost)
    return <span>Use &ldquo;Transcribe again&rdquo; above: lines have corrections.</span>;
  return (
    <>
      <Button
        size="small"
        disabled={pending}
        onClick={() => {
          if (step === "retranslate") retranslate.mutate();
          else rerun.mutate({ step });
        }}
      >
        Retry
      </Button>
      {rerun.isError || retranslate.isError ? (
        <span role="alert">Couldn&apos;t retry. Try again.</span>
      ) : null}
    </>
  );
}

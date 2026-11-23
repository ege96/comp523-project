import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import type { InterviewDetail } from "../api/schemas";
import { useAuth } from "../auth/useAuth";
import { formatClock } from "../format";
import { adminQueries, StillPublished, useDeleteInterview } from "./api";

// Typing a fixed word rather than the title: titles can be long or in Devanagari.
const CONFIRM_WORD = "delete";

declare module "@tanstack/react-router" {
  interface HistoryState {
    /** The title of the interview just deleted, for the notice on the admin page. */
    deletedTitle?: string;
  }
}

/** Where "Wrong file? Delete this interview" links to. */
export const DELETE_SECTION_ID = "delete";

/** The last thing on an admin's interview page: removing it from the archive for good. */
export function DeleteInterview({ interview }: { interview: InterviewDetail }) {
  const [open, setOpen] = useState(false);
  const published = interview.visibility === "public";
  return (
    <Paper
      component="section"
      id={DELETE_SECTION_ID}
      aria-labelledby="delete-interview"
      variant="outlined"
      sx={{ p: { xs: 2, sm: 3 }, bgcolor: "transparent", scrollMarginTop: 16 }}
    >
      <Stack spacing={1.5} sx={{ maxWidth: "70ch" }}>
        <Typography id="delete-interview" variant="h3" component="h2">
          Delete this interview
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {published
            ? "It's published, so visitors may be looking at it. To delete it, unpublish it first (in Next step above)."
            : "Removes the recording, transcript, English and every correction from the archive for good. Use it for a wrong upload or when someone withdraws their consent."}
        </Typography>
        {published ? null : (
          <Box>
            <Button
              variant="outlined"
              color="error"
              onClick={() => {
                setOpen(true);
              }}
            >
              Delete interview
            </Button>
          </Box>
        )}
      </Stack>
      {open ? (
        <ConfirmDelete
          interview={interview}
          onClose={() => {
            setOpen(false);
          }}
        />
      ) : null}
    </Paper>
  );
}

function ConfirmDelete({
  interview,
  onClose,
}: {
  interview: InterviewDetail;
  onClose: () => void;
}) {
  const { viewer } = useAuth();
  const navigate = useNavigate();
  const remove = useDeleteInterview(interview.id);
  const transcript = useQuery({
    ...adminQueries.transcript(viewer, interview.id),
    enabled: viewer.ready,
  });
  const [typed, setTyped] = useState("");
  const lines = transcript.data?.items ?? [];
  const corrected = lines.filter((l) => l.original_edited !== null || l.english_edited !== null);
  const processing = interview.status === "processing";
  const confirmed = typed.trim().toLowerCase() === CONFIRM_WORD;
  const titleId = `delete-title-${interview.id}`;

  const lost = [
    interview.media
      ? `The recording${interview.duration_ms ? ` (${formatClock(interview.duration_ms)})` : ""}`
      : "The uploaded recording",
    lines.length > 0 ? `The transcript: ${String(lines.length)} lines` : null,
    interview.translation_status === "done" ? "The English translation" : null,
    corrected.length > 0
      ? `${String(corrected.length)} ${corrected.length === 1 ? "line" : "lines"} corrected by admins`
      : null,
    "Its details and its place in search",
  ].filter((x): x is string => x !== null);

  return (
    <Dialog
      open
      onClose={remove.isPending ? undefined : onClose}
      aria-labelledby={titleId}
      aria-describedby={`delete-body-${interview.id}`}
      fullWidth
      maxWidth="xs"
    >
      <DialogTitle id={titleId}>Delete “{interview.title}” for good?</DialogTitle>
      <DialogContent id={`delete-body-${interview.id}`}>
        <Stack spacing={2}>
          <Box>
            <DialogContentText component="h3" sx={{ fontWeight: 600, color: "text.primary" }}>
              This removes
            </DialogContentText>
            <Box component="ul" sx={{ m: 0, mt: 0.5, pl: 2.5 }}>
              {lost.map((item) => (
                <Typography component="li" variant="body2" key={item}>
                  {item}
                </Typography>
              ))}
            </Box>
          </Box>
          {processing ? (
            <DialogContentText variant="body2">Processing stops as well.</DialogContentText>
          ) : null}
          <DialogContentText sx={{ color: "text.primary" }}>
            It can&apos;t be undone. To use this recording again, you&apos;d upload it as a new
            interview.
          </DialogContentText>
          <TextField
            label={`Type “${CONFIRM_WORD}” to confirm`}
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value);
            }}
            autoComplete="off"
            size="small"
            disabled={remove.isPending}
          />
          {remove.isError ? (
            <Alert severity="error">
              {remove.error instanceof StillPublished
                ? "Someone published it meanwhile. Unpublish it first, then delete it."
                : "It couldn't be deleted. Try again."}
            </Alert>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={remove.isPending} autoFocus>
          Cancel
        </Button>
        <Button
          variant="contained"
          color="error"
          disabled={!confirmed || remove.isPending}
          onClick={() => {
            remove.mutate(undefined, {
              onSuccess: () => {
                void navigate({
                  to: "/admin",
                  state: { deletedTitle: interview.title },
                  // Unsaved transcript drafts were for the deleted interview: don't ask.
                  ignoreBlocker: true,
                });
              },
            });
          }}
        >
          {remove.isPending ? "Deleting…" : "Delete for good"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

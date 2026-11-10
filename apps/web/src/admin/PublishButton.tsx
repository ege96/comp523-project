import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useState } from "react";

import type { InterviewSummary } from "../api/schemas";
import { useSetVisibility } from "./api";

/**
 * Publish (Private -> Public) or Unpublish. Publishing is allowed at any time, even while
 * processing (D-008); visitors see the transcript labelled as in progress, then as
 * machine-generated. Publishing asks first, because it can expose a sensitive recording
 * (handoff §6). Unpublishing happens at once: it only hides.
 */
export function PublishButton({
  interview,
  fullWidth = false,
}: {
  interview: Pick<InterviewSummary, "id" | "title" | "visibility">;
  fullWidth?: boolean;
}) {
  const setVisibility = useSetVisibility();
  const [confirming, setConfirming] = useState(false);
  // Show the requested state while the request is in flight, then whatever the API says.
  const visibility = setVisibility.isPending
    ? setVisibility.variables.visibility
    : interview.visibility;
  const titleId = `publish-title-${interview.id}`;
  return (
    <Stack spacing={0.5} sx={{ alignItems: fullWidth ? "stretch" : "flex-start" }}>
      {visibility === "public" ? (
        <Button
          variant="outlined"
          fullWidth={fullWidth}
          disabled={setVisibility.isPending}
          onClick={() => {
            setVisibility.mutate({ id: interview.id, visibility: "private" });
          }}
        >
          Unpublish
        </Button>
      ) : (
        <Button
          variant="contained"
          fullWidth={fullWidth}
          disabled={setVisibility.isPending}
          onClick={() => {
            setConfirming(true);
          }}
        >
          Publish
        </Button>
      )}
      {setVisibility.isError ? (
        <Typography variant="caption" color="error" role="alert">
          {setVisibility.variables.visibility === "public"
            ? "Couldn't publish it."
            : "Couldn't unpublish it."}{" "}
          Try again.
        </Typography>
      ) : null}
      {/* Proposal: dialog wording (not yet in the decisions log). */}
      <Dialog
        open={confirming}
        onClose={() => {
          setConfirming(false);
        }}
        aria-labelledby={titleId}
      >
        <DialogTitle id={titleId}>Publish “{interview.title}”?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Anyone on the web will be able to find it in search, read its transcript and play the
            recording. Only continue if the people in it agreed to share it publicly.
          </DialogContentText>
          <DialogContentText sx={{ mt: 2 }}>You can unpublish it at any time.</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setConfirming(false);
            }}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={() => {
              setConfirming(false);
              setVisibility.mutate({ id: interview.id, visibility: "public" });
            }}
          >
            Publish
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

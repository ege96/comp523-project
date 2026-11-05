import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import Switch from "@mui/material/Switch";
import Typography from "@mui/material/Typography";
import { useState } from "react";

import type { InterviewSummary } from "../api/schemas";
import { useSetVisibility } from "./api";

/**
 * Public / Private toggle. Publishing is allowed at any time, even while processing (D-008);
 * visitors see the transcript labelled as in progress, then as machine-generated.
 * Making an interview Public asks first, because it can expose a sensitive recording
 * (handoff §6). Making it Private again happens at once.
 */
export function VisibilitySwitch({
  interview,
}: {
  interview: Pick<InterviewSummary, "id" | "title" | "visibility">;
}) {
  const setVisibility = useSetVisibility();
  const [confirming, setConfirming] = useState(false);
  // Show the requested state while the request is in flight, then whatever the API says.
  const visibility = setVisibility.isPending
    ? setVisibility.variables.visibility
    : interview.visibility;
  const titleId = `publish-title-${interview.id}`;
  return (
    <>
      <FormControlLabel
        label={visibility === "public" ? "Public" : "Private"}
        sx={{ m: 0, gap: 0.5 }}
        control={
          <Switch
            checked={visibility === "public"}
            disabled={setVisibility.isPending}
            onChange={(_e, checked) => {
              if (checked) {
                setConfirming(true);
              } else {
                setVisibility.mutate({ id: interview.id, visibility: "private" });
              }
            }}
            slotProps={{ input: { "aria-label": `Public: ${interview.title}` } }}
          />
        }
      />
      {setVisibility.isError ? (
        <Typography variant="caption" color="error" role="alert">
          Couldn&apos;t change visibility. Try again.
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
        <DialogTitle id={titleId}>Make “{interview.title}” Public?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Anyone on the web will be able to find it in search, read its transcript and play the
            recording. Only continue if the people in it agreed to share it publicly.
          </DialogContentText>
          <DialogContentText sx={{ mt: 2 }}>
            You can make it Private again at any time.
          </DialogContentText>
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
            Make Public
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

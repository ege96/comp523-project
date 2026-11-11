import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useState } from "react";

import type { InterviewDetail, Job } from "../api/schemas";
import { CheckIcon } from "../components/icons";
import { useSetVisibility } from "./api";
import { visitorGets } from "./workflow";

// Confirm before making a recording public. Publishing can happen during processing.
export function PublishButton({
  interview,
  jobs,
  quiet = false,
}: {
  interview: Pick<
    InterviewDetail,
    "id" | "title" | "visibility" | "status" | "translation_status" | "media"
  >;
  /** The interview's processing jobs, when loaded: they say whether search indexing finished. */
  jobs?: readonly Job[];
  /** Outlined Publish, for a page whose main action is something else (e.g. Retry processing). */
  quiet?: boolean;
}) {
  const setVisibility = useSetVisibility();
  const [confirming, setConfirming] = useState(false);
  // Show the requested state while the request is in flight, then whatever the API says.
  const visibility = setVisibility.isPending
    ? setVisibility.variables.visibility
    : interview.visibility;
  const titleId = `publish-title-${interview.id}`;
  const bodyId = `publish-body-${interview.id}`;
  return (
    <Stack spacing={0.5} sx={{ alignItems: "stretch" }}>
      {visibility === "public" ? (
        <Button
          variant="outlined"
          disabled={setVisibility.isPending}
          onClick={() => {
            setVisibility.mutate({ id: interview.id, visibility: "private" });
          }}
        >
          Unpublish
        </Button>
      ) : (
        <Button
          variant={quiet ? "outlined" : "contained"}
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
      <Dialog
        open={confirming}
        onClose={() => {
          setConfirming(false);
        }}
        aria-labelledby={titleId}
        aria-describedby={bodyId}
      >
        <DialogTitle id={titleId}>Publish “{interview.title}”?</DialogTitle>
        <DialogContent id={bodyId}>
          <DialogContentText component="h3" sx={{ fontWeight: 600, color: "text.primary" }}>
            What visitors will get
          </DialogContentText>
          <Box component="ul" sx={{ listStyle: "none", m: 0, mt: 1, p: 0 }}>
            {visitorGets(interview, jobs).map((item) => (
              <Box
                component="li"
                key={item.text}
                sx={{
                  display: "grid",
                  gridTemplateColumns: "20px minmax(0, 1fr)",
                  columnGap: 1,
                  py: 0.25,
                  color: item.available ? "text.primary" : "text.secondary",
                }}
              >
                {item.available ? (
                  <CheckIcon sx={{ fontSize: 18, mt: "3px", color: "#2f5a33" }} aria-hidden />
                ) : (
                  // A short dash: not there yet.
                  <Box
                    component="span"
                    aria-hidden
                    sx={{ width: 8, height: 0, mt: "11px", ml: "5px", borderTop: 2 }}
                  />
                )}
                <Typography variant="body2" component="span" sx={{ color: "inherit" }}>
                  {item.text}
                </Typography>
              </Box>
            ))}
          </Box>
          <DialogContentText sx={{ mt: 2 }}>You can unpublish it at any time.</DialogContentText>
          <DialogContentText sx={{ mt: 2, color: "text.primary" }}>
            Anyone on the web will be able to see it. Only continue if the people in it agreed to
            share it publicly.
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
            Publish
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

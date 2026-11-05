import FormControlLabel from "@mui/material/FormControlLabel";
import Switch from "@mui/material/Switch";
import Typography from "@mui/material/Typography";

import type { InterviewSummary } from "../api/schemas";
import { useSetVisibility } from "./api";

/**
 * Public / Private toggle. Publishing is allowed at any time, even while processing (D-008);
 * visitors see the transcript labelled as in progress, then as machine-generated.
 */
export function VisibilitySwitch({
  interview,
}: {
  interview: Pick<InterviewSummary, "id" | "title" | "visibility">;
}) {
  const setVisibility = useSetVisibility();
  // Show the requested state while the request is in flight, then whatever the API says.
  const visibility = setVisibility.isPending
    ? setVisibility.variables.visibility
    : interview.visibility;
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
              setVisibility.mutate({
                id: interview.id,
                visibility: checked ? "public" : "private",
              });
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
    </>
  );
}

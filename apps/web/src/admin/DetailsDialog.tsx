import Alert from "@mui/material/Alert";
import Autocomplete from "@mui/material/Autocomplete";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import { useForm } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import type { SubmitEvent } from "react";

import { searchQueries } from "../api/client";
import type { InterviewDetail } from "../api/schemas";
import { useAuth } from "../auth/useAuth";
import { useUpdateInterview } from "./api";
import { changedFields, detectedLabel, recordedOnText, type DetailsValues } from "./details";
import { UPLOAD_LANGUAGES } from "./status";
import { datePartsError, partsFromText } from "./recordedOn";
import { RecordedOnField } from "./RecordedOnField";

function shownError(meta: { isTouched: boolean; errors: (string | undefined)[] }) {
  return meta.isTouched ? meta.errors[0] : undefined;
}

export function DetailsDialog({
  interview,
  open,
  onClose,
}: {
  interview: InterviewDetail;
  open: boolean;
  onClose: () => void;
}) {
  const { viewer } = useAuth();
  const update = useUpdateInterview(interview.id);
  const { data: filters } = useQuery({ ...searchQueries.filters(viewer), enabled: viewer.ready });

  const form = useForm({
    defaultValues: {
      title: interview.title,
      interviewee: { id: interview.interviewee_id, name: interview.interviewee ?? "" },
      recordedOn: partsFromText(recordedOnText(interview)),
      language: interview.language_confirmed ?? "",
    } satisfies DetailsValues,
    onSubmit: async ({ value }) => {
      const changes = changedFields(interview, value);
      if (Object.keys(changes).length > 0) await update.mutateAsync(changes);
      onClose();
    },
  });

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    void form.handleSubmit().catch(() => {
      // Shown from update.isError below.
    });
  };

  const close = () => {
    form.reset();
    update.reset();
    onClose();
  };

  return (
    <Dialog open={open} onClose={close} fullWidth maxWidth="sm" aria-labelledby="details-title">
      <form noValidate onSubmit={submit}>
        <DialogTitle id="details-title">Edit details</DialogTitle>
        <DialogContent>
          <Stack spacing={2.5} sx={{ pt: 1 }}>
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
                  onChange={(e) => {
                    field.handleChange(e.target.value);
                  }}
                  onBlur={field.handleBlur}
                  error={shownError(field.state.meta) !== undefined}
                  helperText={shownError(field.state.meta)}
                />
              )}
            </form.Field>

            <form.Field name="interviewee">
              {(field) => (
                <Autocomplete
                  freeSolo
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
                            : "Leave empty if unknown."
                      }
                    />
                  )}
                />
              )}
            </form.Field>

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
                />
              )}
            </form.Field>

            <form.Field name="language">
              {(field) => (
                <TextField
                  select
                  label="Original language"
                  name={field.name}
                  value={field.state.value}
                  onChange={(e) => {
                    field.handleChange(e.target.value);
                  }}
                  helperText="Nepal Bhasa is often detected as Nepali. Changing it updates the language filter now; the transcript and English stay as they are."
                >
                  <MenuItem value="">{detectedLabel(interview)}</MenuItem>
                  {UPLOAD_LANGUAGES.map((l) => (
                    <MenuItem key={l.code} value={l.code}>
                      {l.name}
                    </MenuItem>
                  ))}
                </TextField>
              )}
            </form.Field>

            {update.isError ? (
              <Alert severity="error">The details couldn&apos;t be saved. Try again.</Alert>
            ) : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={close}>Cancel</Button>
          <form.Subscribe selector={(s) => s.isSubmitting}>
            {(isSubmitting) => (
              <Button type="submit" variant="contained" disabled={isSubmitting}>
                Save
              </Button>
            )}
          </form.Subscribe>
        </DialogActions>
      </form>
    </Dialog>
  );
}

import Autocomplete from "@mui/material/Autocomplete";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";

import { UPLOAD_LANGUAGES } from "./status";
import type { Interviewee } from "./uploadQueue";

type Option = { id: number; name: string };

/** An existing interviewee, picked by id because names aren't unique, or a new name. */
export function IntervieweeField({
  value,
  options,
  onChange,
  disabled = false,
}: {
  value: Interviewee;
  options: readonly Option[];
  onChange: (next: Interviewee) => void;
  disabled?: boolean;
}) {
  return (
    <Autocomplete
      freeSolo
      fullWidth
      disabled={disabled}
      options={options}
      getOptionLabel={(o) => (typeof o === "string" ? o : o.name)}
      getOptionKey={(o) => (typeof o === "string" ? o : o.id)}
      value={options.find((o) => o.id === value.id) ?? null}
      inputValue={value.name}
      onChange={(_e, option) => {
        onChange(
          typeof option === "object" && option
            ? { id: option.id, name: option.name }
            : { id: null, name: option ?? "" },
        );
      }}
      onInputChange={(_e, text, reason) => {
        // "reset" follows picking an option, which onChange already handled.
        if (reason !== "reset") onChange({ id: null, name: text });
      }}
      renderInput={(params) => (
        <TextField
          {...params}
          label="Interviewee"
          helperText={
            value.id !== null
              ? "An existing interviewee"
              : value.name.trim()
                ? "A new interviewee will be added"
                : "Optional. Leave empty if unknown."
          }
        />
      )}
    />
  );
}

export function LanguageField({
  value,
  onChange,
  disabled = false,
  emptyLabel = "Detect from the audio",
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  emptyLabel?: string;
}) {
  return (
    <TextField
      select
      fullWidth
      label="Original language"
      value={value}
      disabled={disabled}
      onChange={(e) => {
        onChange(e.target.value);
      }}
      helperText="Leave on detect unless you know it. Nepal Bhasa is often detected as Nepali."
    >
      <MenuItem value="">{emptyLabel}</MenuItem>
      {UPLOAD_LANGUAGES.map((l) => (
        <MenuItem key={l.code} value={l.code}>
          {l.name}
        </MenuItem>
      ))}
    </TextField>
  );
}

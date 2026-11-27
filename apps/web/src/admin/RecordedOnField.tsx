import Box from "@mui/material/Box";
import FormHelperText from "@mui/material/FormHelperText";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useId } from "react";

import { daysIn, MONTHS, type DateParts } from "./recordedOn";

export function RecordedOnField({
  value,
  onChange,
  onBlur,
  error,
  disabled = false,
}: {
  value: DateParts;
  onChange: (next: DateParts) => void;
  onBlur?: () => void;
  error?: string;
  disabled?: boolean;
}) {
  const id = useId();
  // Use a leap year for day options. Validate the actual year on save.
  const days = value.month ? daysIn(2000, Number(value.month)) : 31;
  return (
    <Box role="group" aria-labelledby={`${id}-label`} aria-describedby={`${id}-help`}>
      <Typography id={`${id}-label`} variant="body2" sx={{ fontWeight: 600, mb: 1.25 }}>
        Recording date
      </Typography>
      <Stack direction="row" spacing={1.5}>
        <TextField
          label="Year"
          value={value.year}
          disabled={disabled}
          error={error !== undefined}
          onChange={(e) => {
            onChange({ ...value, year: e.target.value.replace(/\D/g, "").slice(0, 4) });
          }}
          onBlur={onBlur}
          slotProps={{ htmlInput: { inputMode: "numeric", maxLength: 4 } }}
          sx={{ width: { xs: 92, sm: 110 }, flexShrink: 0 }}
        />
        <TextField
          select
          label="Month"
          value={value.month}
          disabled={disabled}
          onChange={(e) => {
            const month = e.target.value;
            const fits = month && Number(value.day) <= daysIn(2000, Number(month));
            onChange({ ...value, month, day: fits ? value.day : "" });
          }}
          onBlur={onBlur}
          sx={{ flex: 1, minWidth: 0 }}
        >
          <MenuItem value="">Not known</MenuItem>
          {MONTHS.map((name, i) => (
            <MenuItem key={name} value={String(i + 1)}>
              {name}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          select
          label="Day"
          value={value.day}
          disabled={disabled || !value.month}
          onChange={(e) => {
            onChange({ ...value, day: e.target.value });
          }}
          onBlur={onBlur}
          sx={{ width: { xs: 84, sm: 100 }, flexShrink: 0 }}
        >
          <MenuItem value="">Not known</MenuItem>
          {Array.from({ length: days }, (_, i) => (
            <MenuItem key={i} value={String(i + 1)}>
              {i + 1}
            </MenuItem>
          ))}
        </TextField>
      </Stack>
      <FormHelperText id={`${id}-help`} error={error !== undefined} sx={{ mx: 1.75 }}>
        {error ?? "Optional. Fill in as much as you know."}
      </FormHelperText>
    </Box>
  );
}

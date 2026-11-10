import SvgIcon, { type SvgIconProps } from "@mui/material/SvgIcon";

// The icons the archive uses, inlined so the bundle doesn't need @mui/icons-material.
// Search, arrow and play paths are Material Symbols (Apache 2.0).

export function SearchIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props}>
      <path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14" />
    </SvgIcon>
  );
}

export function ArrowForwardIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props}>
      <path d="m12 4-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z" />
    </SvgIcon>
  );
}

/** A sound wave: the archive is recordings first. */
export function WaveformIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props}>
      <path d="M11 3h2v18h-2zM7 7h2v10H7zm8 0h2v10h-2zM3 10h2v4H3zm16 0h2v4h-2z" />
    </SvgIcon>
  );
}

export function PlayIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props}>
      <path d="M8 5v14l11-7z" />
    </SvgIcon>
  );
}

export function StopIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props}>
      <path d="M6 6h12v12H6z" />
    </SvgIcon>
  );
}

export function ChevronIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props}>
      <path d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z" />
    </SvgIcon>
  );
}

export function CheckIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props}>
      <path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
    </SvgIcon>
  );
}

/** An exclamation mark, for a step that didn't work. */
export function AlertIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props}>
      <path d="M11 4h2v11h-2zm0 13h2v2h-2z" />
    </SvgIcon>
  );
}

export function ArrowBackIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props}>
      <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z" />
    </SvgIcon>
  );
}

export function UploadIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props}>
      <path d="M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96M19 18H6c-2.21 0-4-1.79-4-4 0-2.05 1.53-3.76 3.56-3.97l1.07-.11.5-.95A5.47 5.47 0 0 1 12 6c2.62 0 4.88 1.86 5.39 4.43l.3 1.5 1.53.11A2.98 2.98 0 0 1 22 15c0 1.65-1.35 3-3 3M8 13h2.55v3h2.9v-3H16l-4-4z" />
    </SvgIcon>
  );
}

export function EditIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props}>
      <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75z" />
    </SvgIcon>
  );
}

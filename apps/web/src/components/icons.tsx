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

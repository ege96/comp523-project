import { useState } from "react";

import type { InterviewDetail } from "./api/schemas";

type Media = InterviewDetail["media"];

/** The file a signed media link points at, without its expiry and signature. */
function fileOf(url: string): string {
  return url.split("?", 1)[0] ?? url;
}

/**
 * The media link to give a player. Each fetch of an interview can come with a newly signed
 * link to the same file, and changing a player's `src` makes it load the file again from the
 * start and lose its place. So the first link for a file is kept until `renew()` is called
 * (after playback failed, say because the link expired), and then the next new link is used.
 */
export function usePinnedMediaUrl(media: Media | undefined): {
  src: string | undefined;
  renew: () => void;
} {
  const latest = media?.url;
  const [pinned, setPinned] = useState(latest);
  const [renewing, setRenewing] = useState(false);
  // Adjusting state while rendering, React's pattern for state derived from changing props.
  if (latest !== undefined && latest !== pinned) {
    const otherFile = pinned === undefined || fileOf(pinned) !== fileOf(latest);
    if (otherFile || renewing) {
      setPinned(latest);
      setRenewing(false);
    }
  }
  return {
    src: latest === undefined ? undefined : pinned,
    renew: () => {
      setRenewing(true);
    },
  };
}

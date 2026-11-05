import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { interviewQueries } from "../api/client";
import type { AdminSegment } from "../api/schemas";
import { useAuth } from "../auth/useAuth";

/**
 * Plays one transcript line at a time from the interview's recording, stopping at the line's
 * end. Spread `audioProps` onto a single <audio> element.
 */
export function useSegmentPlayer(interviewId: string) {
  const { viewer } = useAuth();
  const queryClient = useQueryClient();
  const ref = useRef<HTMLAudioElement>(null);
  const endMs = useRef(0);
  const [playing, setPlaying] = useState<number | null>(null);

  const stop = () => {
    ref.current?.pause();
    setPlaying(null);
  };

  const toggle = (line: Pick<AdminSegment, "seq" | "start_ms" | "end_ms">) => {
    const el = ref.current;
    if (!el) return;
    if (playing === line.seq) {
      stop();
      return;
    }
    endMs.current = line.end_ms;
    el.currentTime = line.start_ms / 1000;
    setPlaying(line.seq);
    void el.play().catch(() => {
      setPlaying(null);
    });
  };

  const audioProps = {
    ref,
    preload: "none",
    // timeupdate fires a few times a second, so playback can run a moment past the line's end.
    onTimeUpdate: () => {
      const el = ref.current;
      if (el && playing !== null && el.currentTime * 1000 >= endMs.current) stop();
    },
    onEnded: () => {
      setPlaying(null);
    },
    // Media links are signed and expire (P-024): fetch the interview again for a fresh one.
    onError: () => {
      setPlaying(null);
      void queryClient.invalidateQueries({
        queryKey: interviewQueries.detail(viewer, interviewId).queryKey,
        exact: true,
      });
    },
  } as const;

  return { playing, toggle, stop, audioProps };
}

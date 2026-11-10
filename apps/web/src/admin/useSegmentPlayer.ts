import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { interviewQueries } from "../api/client";
import type { AdminSegment } from "../api/schemas";
import { useAuth } from "../auth/useAuth";

/**
 * The transcript editor's one player. It plays the recording straight through (the editor
 * follows along), or just one line, stopping at the line's end. Spread `audioProps` onto a
 * single <audio> element.
 */
export function useSegmentPlayer(interviewId: string) {
  const { viewer } = useAuth();
  const queryClient = useQueryClient();
  const ref = useRef<HTMLAudioElement>(null);
  const endMs = useRef(0);
  // The line playing on its own, if any; null while playing straight through.
  const [playing, setPlaying] = useState<number | null>(null);
  const [currentMs, setCurrentMs] = useState<number | null>(null);
  const [paused, setPaused] = useState(true);

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

  /** Move to a time; keeps playing (straight through) if it was playing. */
  const seek = (ms: number, play = false) => {
    const el = ref.current;
    if (!el) return;
    endMs.current = Infinity;
    setPlaying(null);
    el.currentTime = ms / 1000;
    setCurrentMs(ms);
    if (play) void el.play().catch(() => undefined);
  };

  const audioProps = {
    ref,
    preload: "metadata",
    // timeupdate fires a few times a second, so playback can run a moment past the line's end.
    onTimeUpdate: () => {
      const el = ref.current;
      if (!el) return;
      setCurrentMs(Math.round(el.currentTime * 1000));
      if (playing !== null && el.currentTime * 1000 >= endMs.current) stop();
    },
    onPlay: () => {
      setPaused(false);
    },
    onPause: () => {
      setPaused(true);
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

  return { playing, currentMs, paused, toggle, seek, stop, audioProps };
}

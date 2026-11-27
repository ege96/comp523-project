import { renderHook } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { usePinnedMediaUrl } from "./mediaUrl";

type Pinned = ReturnType<typeof usePinnedMediaUrl>;
type Media = { url: string; content_type: string; expires_at: string };

const media = (url: string): Media => ({
  url,
  content_type: "video/mp4",
  expires_at: "2026-11-23T06:00:00Z",
});

describe("usePinnedMediaUrl", () => {
  it("keeps the first link to a file while refetches bring newly signed ones", () => {
    const { result, rerender } = renderHook<Pinned, { m: Media | undefined }>(
      ({ m }) => usePinnedMediaUrl(m),
      { initialProps: { m: media("/api/media/6?expires=1&sig=a") } },
    );
    rerender({ m: media("/api/media/6?expires=2&sig=b") });
    expect(result.current.src).toBe("/api/media/6?expires=1&sig=a");
  });

  it("switches to the next new link after renew, and at once for another file", () => {
    const { result, rerender } = renderHook<Pinned, { m: Media | undefined }>(
      ({ m }) => usePinnedMediaUrl(m),
      { initialProps: { m: media("/api/media/6?expires=1&sig=a") } },
    );
    act(() => {
      result.current.renew();
    });
    // Same link again (the refetch hasn't come back yet): nothing to switch to.
    rerender({ m: media("/api/media/6?expires=1&sig=a") });
    expect(result.current.src).toBe("/api/media/6?expires=1&sig=a");
    rerender({ m: media("/api/media/6?expires=2&sig=b") });
    expect(result.current.src).toBe("/api/media/6?expires=2&sig=b");
    rerender({ m: media("/api/media/6?expires=3&sig=c") });
    expect(result.current.src).toBe("/api/media/6?expires=2&sig=b");
    rerender({ m: media("/api/media/7?expires=3&sig=d") });
    expect(result.current.src).toBe("/api/media/7?expires=3&sig=d");
    rerender({ m: undefined });
    expect(result.current.src).toBeUndefined();
  });
});

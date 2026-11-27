import { describe, expect, it } from "vitest";

import { finder, hasMatch, splitMatches } from "./transcriptFind";

describe("find in transcript", () => {
  it("matches plain text, ignoring case and pattern characters", () => {
    expect(finder("  ")).toBeNull();
    const re = finder("stupa (");
    expect(hasMatch("The Stupa (old)", re)).toBe(true);
    expect(hasMatch("the stupa", re)).toBe(false);
    // Repeated tests give the same answer even though the RegExp is global.
    expect(hasMatch("The Stupa (old)", re)).toBe(true);
  });

  it("splits every match out for highlighting", () => {
    expect(splitMatches("Dawn and dawn again", finder("dawn"))).toEqual([
      { text: "Dawn", match: true },
      { text: " and ", match: false },
      { text: "dawn", match: true },
      { text: " again", match: false },
    ]);
    expect(splitMatches("no find", null)).toEqual([{ text: "no find", match: false }]);
  });

  it("matches Devanagari whichever way it was composed", () => {
    // क़ as one code point versus क + nukta.
    expect(hasMatch("क़", finder("क़"))).toBe(true);
  });
});

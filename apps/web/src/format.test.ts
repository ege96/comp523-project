import { expect, it } from "vitest";

import { formatClock, formatRecordedOn, transcriptLabel } from "./format";

it("formats clock times and dates only as precisely as they are known", () => {
  expect([formatClock(5_000), formatClock(754_000), formatClock(3_723_000)]).toEqual([
    "0:05",
    "12:34",
    "1:02:03",
  ]);
  expect(formatRecordedOn({ recorded_on: "2001-01-01", recorded_on_precision: "year" })).toBe(
    "2001",
  );
  expect(formatRecordedOn({ recorded_on: "2001-05-09", recorded_on_precision: null })).toBe(
    "9 May 2001",
  );
  expect(formatRecordedOn({ recorded_on: null, recorded_on_precision: null })).toBeNull();
});

it("labels every transcript that isn't reviewed yet (D-008)", () => {
  expect(
    (["processing", "needs_review", "failed", "reviewed"] as const).map(transcriptLabel),
  ).toEqual([
    "Transcript in progress",
    "Machine-generated transcript",
    "Transcript unavailable",
    null,
  ]);
});

import { expect, it } from "vitest";

import { formatBytes, formatClock, formatRecordedOn, transcriptLabel } from "./format";

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

it("labels cards only while the transcript isn't there yet", () => {
  expect((["processing", "failed", "done"] as const).map(transcriptLabel)).toEqual([
    "Transcript in progress",
    "Transcript unavailable",
    null,
  ]);
});

it("formats file sizes in binary units", () => {
  expect([512, 1536, 310 * 1024 ** 2, 3 * 1024 ** 3].map(formatBytes)).toEqual([
    "512 bytes",
    "1.5 KB",
    "310 MB",
    "3 GB",
  ]);
});

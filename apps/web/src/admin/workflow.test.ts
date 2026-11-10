import { describe, expect, it } from "vitest";

import type { Job } from "../api/schemas";
import { datePartsError, partsFromText, partsToText } from "./recordedOn";
import { formatAdded, nextStep, processingSteps, queueOf } from "./workflow";

function job(kind: string, state: Job["state"]): Job {
  return {
    kind,
    state,
    attempts: 1,
    max_attempts: 3,
    last_error: null,
    created_at: "2026-10-14T00:00:00Z",
    finished_at: null,
  };
}

describe("admin workflow", () => {
  it("sorts recordings by what to do next, a problem first", () => {
    expect(queueOf({ status: "failed", visibility: "public" })).toBe("attention");
    expect(queueOf({ status: "processing", visibility: "private" })).toBe("processing");
    expect(queueOf({ status: "done", visibility: "private" })).toBe("ready");
    expect(queueOf({ status: "done", visibility: "public" })).toBe("published");
    expect(nextStep({ status: "processing", visibility: "public" }).text).toMatch(/^Published/);
    expect(nextStep({ status: "done", visibility: "private" }).action).toBe("Review & publish");
  });

  it("lists each step once, from its latest job, in the order they run", () => {
    const steps = processingSteps([
      job("index", "done"),
      job("transcribe", "failed"),
      job("retranscribe", "running"),
      job("playback", "done"),
      job("something-new", "queued"),
    ]);
    expect(steps.map((s) => [s.label, s.job.state])).toEqual([
      ["Getting the audio ready to play", "done"],
      ["Writing the transcript", "running"],
      ["Making it searchable", "done"],
      ["something-new", "queued"],
    ]);
  });

  it("writes the added date without the time", () => {
    expect(formatAdded("2026-10-14T00:00:00Z")).toBe("14 October 2026");
  });
});

describe("recording date parts", () => {
  it("turns the API's text into parts and back", () => {
    expect(partsFromText("2019-05")).toEqual({ year: "2019", month: "5", day: "" });
    expect(partsFromText("")).toEqual({ year: "", month: "", day: "" });
    expect(partsToText({ year: "2019", month: "5", day: "8" })).toBe("2019-05-08");
    expect(partsToText({ year: "2019", month: "", day: "" })).toBe("2019");
    expect(partsToText({ year: "", month: "5", day: "" })).toBe("");
  });

  it("explains a date that can't be right", () => {
    expect(datePartsError({ year: "", month: "", day: "" })).toBeUndefined();
    expect(datePartsError({ year: "", month: "3", day: "" })).toMatch(/Add the year/);
    expect(datePartsError({ year: "98", month: "", day: "" })).toMatch(/four digits/);
    expect(datePartsError({ year: "3000", month: "", day: "" })).toMatch(/hasn't happened/);
    expect(datePartsError({ year: "2024", month: "2", day: "29" })).toBeUndefined();
    expect(datePartsError({ year: "2023", month: "2", day: "29" })).toBe(
      "February 2023 has no day 29",
    );
  });
});

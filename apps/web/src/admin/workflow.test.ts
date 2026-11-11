import { describe, expect, it } from "vitest";

import type { Job } from "../api/schemas";
import { datePartsError, partsFromText, partsToText } from "./recordedOn";
import {
  formatAdded,
  nextStep,
  processingSteps,
  QUEUE_FILTERS,
  queueOf,
  visitorGets,
} from "./workflow";

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
    expect(nextStep({ status: "done", visibility: "private" }).text).toMatch(
      /until it's published/,
    );
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

  it("writes the added date without the time, as the same day wherever the admin is", () => {
    expect(formatAdded("2026-10-14T00:00:00Z")).toBe("14 October 2026");
    expect(formatAdded("2026-10-14T23:59:00Z")).toBe("14 October 2026");
  });

  it("keeps the views apart: Published is only finished, public interviews", () => {
    expect(QUEUE_FILTERS.published).toEqual({ status: "done", visibility: "public" });
    expect(QUEUE_FILTERS.processing).toEqual({ status: "processing" });
  });

  it("says what visitors get from publishing now, without promising what isn't there", () => {
    const media = { url: "/m", content_type: "audio/mp4", expires_at: "2026-10-14T06:00:00Z" };
    const texts = (...args: Parameters<typeof visitorGets>) =>
      visitorGets(...args).map((i) => (i.available ? "+ " : "- ") + i.text);
    expect(texts({ status: "done", translation_status: "done", media })).toEqual([
      "+ Play the recording",
      "+ Read the transcript, marked as made by machine",
      "+ Read the English translation",
      "+ Find it in search by its title and details",
      "+ Find moments in search by the words said",
      "+ Find moments in search by meaning",
    ]);
    expect(texts({ status: "processing", translation_status: "pending", media: null })).toEqual([
      "- The recording isn't ready to play yet",
      "- Transcript still being made, marked “Transcript in progress”",
      "- The English translation is still being made",
      "+ Find it in search by its title and details",
      "- Search finds what is said once the transcript is made",
    ]);
    // English recordings need no translation line.
    expect(
      texts({ status: "failed", translation_status: "not_needed", media: null }, [
        job("index", "done"),
      ]),
    ).toEqual([
      "- No recording to play: it couldn't be prepared",
      "- No transcript (marked “Transcript unavailable”)",
      "+ Find it in search by its title and details",
      "- Search can't find what is said without a transcript",
    ]);
    expect(texts({ status: "done", translation_status: "failed", media })[2]).toBe(
      "- Original words only; the English didn't work",
    );
  });

  it("tells a transcript found by its words apart from search indexing that failed", () => {
    const media = { url: "/m", content_type: "audio/mp4", expires_at: "2026-10-14T06:00:00Z" };
    const failedIndex = [job("transcribe", "done"), job("index", "failed")];
    const items = visitorGets(
      { status: "failed", translation_status: "not_needed", media },
      failedIndex,
      12,
    ).map((i) => (i.available ? "+ " : "- ") + i.text);
    expect(items).toEqual([
      "+ Play the recording",
      "+ Read the transcript, marked as made by machine",
      "+ Find it in search by its title and details",
      "+ Find moments in search by the words said",
      "- Search by meaning works once search indexing does",
    ]);
    // Without the line count, a finished transcription stands for the lines.
    expect(
      visitorGets({ status: "failed", translation_status: "not_needed", media }, failedIndex)[1],
    ).toEqual({ text: "Read the transcript, marked as made by machine", available: true });
    // No lines at all: nothing to find by its words.
    expect(
      visitorGets({ status: "done", translation_status: "not_needed", media }, [], 0)[1]?.available,
    ).toBe(false);
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
    // As much of the date as is known: a year, or a year and month.
    expect(datePartsError(partsFromText("2019"))).toBeUndefined();
    expect(datePartsError(partsFromText("2019-05"))).toBeUndefined();
    expect(datePartsError({ year: "19", month: "", day: "" })).toMatch(/four digits/);
    expect(datePartsError({ year: "", month: "3", day: "" })).toMatch(/Add the year/);
    expect(datePartsError({ year: "98", month: "", day: "" })).toMatch(/four digits/);
    expect(datePartsError({ year: "3000", month: "", day: "" })).toMatch(/hasn't happened/);
    expect(datePartsError({ year: "2024", month: "2", day: "29" })).toBeUndefined();
    expect(datePartsError({ year: "2023", month: "2", day: "29" })).toBe(
      "February 2023 has no day 29",
    );
  });
});

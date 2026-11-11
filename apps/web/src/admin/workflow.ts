import type { InterviewDetail, InterviewSummary, Job } from "../api/schemas";
import { retryStepFor } from "./rerun";

// Queue filters must partition interviews the same way as queueOf.
export const QUEUES = ["attention", "processing", "ready", "published"] as const;
export type Queue = (typeof QUEUES)[number];

export const QUEUE_LABELS = {
  attention: "Needs attention",
  processing: "Processing",
  ready: "Not published",
  published: "Published",
} as const satisfies Record<Queue, string>;

export const QUEUE_FILTERS = {
  attention: { status: "failed" },
  processing: { status: "processing" },
  ready: { status: "done", visibility: "private" },
  published: { status: "done", visibility: "public" },
} as const satisfies Record<
  Queue,
  { status?: InterviewSummary["status"]; visibility?: InterviewSummary["visibility"] }
>;

/** What an empty view says. */
export const QUEUE_EMPTY = {
  attention: "Nothing needs your attention.",
  processing: "Nothing is being processed right now.",
  ready: "Every finished interview is published.",
  published: "Nothing has been published yet.",
} as const satisfies Record<Queue, string>;

type Stage = Pick<InterviewSummary, "status" | "visibility">;

/** Where a recording is in the admin's work. A problem comes first, even when Public. */
export function queueOf({ status, visibility }: Stage): Queue {
  if (status === "failed") return "attention";
  if (status === "processing") return "processing";
  return visibility === "public" ? "published" : "ready";
}

/** The next step for one recording, as a sentence and the button that leads to it. */
export function nextStep(interview: Stage): { text: string; action: string } {
  switch (queueOf(interview)) {
    case "attention":
      return {
        text: "Processing stopped. It needs you to look at it.",
        action: "See what went wrong",
      };
    case "processing":
      return interview.visibility === "public"
        ? { text: "Published. The transcript is still being made.", action: "Check progress" }
        : { text: "The transcript is being made. Nothing to do yet.", action: "Check progress" };
    case "ready":
      return {
        text: "Finished. Only admins can see it until it's published.",
        action: "Open",
      };
    case "published":
      return { text: "Visitors can find and play it.", action: "Open" };
  }
}

/** The processing steps in the order the worker runs them, in plain words. */
const STEPS = [
  { kind: "playback", label: "Getting the audio ready to play" },
  { kind: "transcribe", label: "Writing the transcript" },
  { kind: "translate", label: "Translating it into English" },
  { kind: "index", label: "Making it searchable" },
  { kind: "retranslate", label: "Updating the English after your corrections" },
] as const;

export type Step = { key: string; label: string; job: Job };

/**
 * One line per step, taking the last job in ascending job-ID order.
 * Steps that were never queued are left out, so an English recording has no translation step.
 */
export function processingSteps(jobs: readonly Job[]): Step[] {
  const latest = new Map<string, Job>();
  for (const job of jobs) latest.set(retryStepFor(job.kind) ?? job.kind, job);
  const known: Step[] = STEPS.flatMap(({ kind, label }) => {
    const job = latest.get(kind);
    return job ? [{ key: kind, label, job }] : [];
  });
  const other: Step[] = [...latest.entries()]
    .filter(([key]) => !STEPS.some((s) => s.kind === key))
    .map(([key, job]) => ({ key, label: key, job }));
  return [...known, ...other];
}

// Use the UTC calendar date consistently across admin time zones.
export function formatAdded(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** One thing visitors get once it's published: there now, or not yet. */
export type VisitorItem = { text: string; available: boolean };

/**
 * What visitors get if it is published now. The recording, the transcript and finding it by
 * its words are told apart from search by meaning, which needs the indexing step: lines that
 * exist are public and found by their words even when indexing failed. `lines` is how many
 * transcript lines there are, when known; otherwise a finished transcription stands for them.
 */
export function visitorGets(
  interview: Pick<InterviewDetail, "status" | "translation_status" | "media">,
  jobs?: readonly Job[],
  lines?: number,
): VisitorItem[] {
  const { status, translation_status: english } = interview;
  const steps = processingSteps(jobs ?? []);
  const stateOf = (key: string) => steps.find((s) => s.key === key)?.job.state;
  const hasLines =
    lines === undefined ? stateOf("transcribe") === "done" || status === "done" : lines > 0;
  const items: VisitorItem[] = [
    interview.media
      ? { text: "Play the recording", available: true }
      : status === "processing"
        ? { text: "The recording isn't ready to play yet", available: false }
        : { text: "No recording to play: it couldn't be prepared", available: false },
    hasLines
      ? { text: "Read the transcript, marked as made by machine", available: true }
      : status === "processing"
        ? { text: "Transcript still being made, marked “Transcript in progress”", available: false }
        : status === "failed"
          ? { text: "No transcript (marked “Transcript unavailable”)", available: false }
          : { text: "No transcript: no speech was found in the recording", available: false },
  ];
  if (english === "done") items.push({ text: "Read the English translation", available: true });
  else if (english === "failed")
    items.push({ text: "Original words only; the English didn't work", available: false });
  else if (english === "pending")
    items.push({
      text:
        status === "processing"
          ? "The English translation is still being made"
          : "No English translation yet",
      available: false,
    });
  items.push({ text: "Find it in search by its title and details", available: true });
  if (!hasLines) {
    items.push(
      status === "processing"
        ? { text: "Search finds what is said once the transcript is made", available: false }
        : { text: "Search can't find what is said without a transcript", available: false },
    );
    return items;
  }
  items.push({ text: "Find moments in search by the words said", available: true });
  const index = stateOf("index");
  const byMeaning = status === "done" ? index !== "failed" : index === "done";
  items.push(
    byMeaning
      ? { text: "Find moments in search by meaning", available: true }
      : status === "processing"
        ? { text: "Search by meaning works once processing finishes", available: false }
        : { text: "Search by meaning works once search indexing does", available: false },
  );
  return items;
}

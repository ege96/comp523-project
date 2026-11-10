import type { InterviewSummary, Job } from "../api/schemas";
import { retryStepFor } from "./rerun";

/**
 * Proposal: the admin home sorts recordings into what an admin does next, in plain words, not
 * processing states. Each view is one API filter (status and/or visibility).
 */
export const QUEUES = ["attention", "processing", "ready", "published"] as const;
export type Queue = (typeof QUEUES)[number];

export const QUEUE_LABELS = {
  attention: "Needs attention",
  processing: "Processing",
  ready: "Ready to publish",
  published: "Published",
} as const satisfies Record<Queue, string>;

export const QUEUE_FILTERS = {
  attention: { status: "failed" },
  processing: { status: "processing" },
  ready: { status: "done", visibility: "private" },
  published: { visibility: "public" },
} as const satisfies Record<
  Queue,
  { status?: InterviewSummary["status"]; visibility?: InterviewSummary["visibility"] }
>;

/** What an empty view says. */
export const QUEUE_EMPTY = {
  attention: "Nothing needs your attention.",
  processing: "Nothing is being processed right now.",
  ready: "Nothing is waiting to be published.",
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
        text: "Transcript finished. Check it, then publish it.",
        action: "Review & publish",
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
 * One line per step, from its latest job (jobs come oldest first), in the worker's order.
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

/** "20 October 2026": a plain date, without the time of day nobody needs here. */
export function formatAdded(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

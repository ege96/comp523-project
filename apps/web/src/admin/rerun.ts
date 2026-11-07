import type { InterviewDetail, Job, RerunStep } from "../api/schemas";
import { languageName } from "./status";

/** The rerun step that redoes a job's work, or "retranslate" for the edit batch. */
export function retryStepFor(kind: string): RerunStep | "retranslate" | null {
  switch (kind) {
    case "transcribe":
    case "retranscribe":
      return "transcribe";
    case "translate":
    case "index":
    case "playback":
    case "retranslate":
      return kind;
    default:
      return null;
  }
}

/**
 * Which jobs get a Retry button: a failed job whose step hasn't been run again since. Jobs come
 * oldest first, so the last of each step is its current state.
 */
export function retryableJobs(jobs: readonly Job[]): Set<Job> {
  const latest = new Map<string, Job>();
  for (const job of jobs) {
    const step = retryStepFor(job.kind);
    if (step) latest.set(step, job);
  }
  return new Set([...latest.values()].filter((job) => job.state === "failed"));
}

/**
 * The corrected language, when lines were transcribed or translated as another one (say,
 * Nepal Bhasa that was detected as Nepali), so the admin knows to redo them. Otherwise null.
 */
export function languageMismatch(
  interview: Pick<InterviewDetail, "language_confirmed" | "languages">,
): string | null {
  const confirmed = interview.language_confirmed;
  if (!confirmed || confirmed === "en") return null;
  const other = interview.languages.some((l) => l.code !== confirmed && l.code !== "en");
  return other ? languageName(confirmed) : null;
}

import type { InterviewDetail, InterviewUpdate } from "../api/schemas";
import { partsToText, type DateParts } from "./recordedOn";
import { languageName } from "./status";

type Interviewee = { id: number | null; name: string };

/** "2019-05-01" with month precision -> "2019-05": the form's way of writing it. */
export function recordedOnText(
  interview: Pick<InterviewDetail, "recorded_on" | "recorded_on_precision">,
): string {
  if (!interview.recorded_on) return "";
  const length = { year: 4, month: 7, day: 10 }[interview.recorded_on_precision ?? "day"];
  return interview.recorded_on.slice(0, length);
}

/** What the "use detected" choice says, so the admin knows what they'd go back to. */
export function detectedLabel(
  interview: Pick<InterviewDetail, "language_detected" | "language_detected_confidence">,
): string {
  if (!interview.language_detected) return "Detect from the audio (not detected yet)";
  const name = languageName(interview.language_detected);
  const share = interview.language_detected_confidence;
  return share === null
    ? `Use the detected language (${name})`
    : `Use the detected language (${name}, ${String(Math.round(share * 100))}% of the speech)`;
}

export type DetailsValues = {
  title: string;
  interviewee: Interviewee;
  recordedOn: DateParts;
  language: string;
};

/** Only what the admin changed, so a save never overwrites another admin's change. */
export function changedFields(interview: InterviewDetail, value: DetailsValues): InterviewUpdate {
  const update: InterviewUpdate = {};
  const title = value.title.trim();
  if (title !== interview.title) update.title = title;
  const name = value.interviewee.name.trim();
  if (value.interviewee.id !== null) {
    if (value.interviewee.id !== interview.interviewee_id)
      update.interviewee_id = value.interviewee.id;
  } else if (name) {
    if (name !== interview.interviewee || interview.interviewee_id === null)
      update.interviewee_name = name;
  } else if (interview.interviewee_id !== null) {
    update.interviewee_id = null;
  }
  const recordedOn = partsToText(value.recordedOn);
  if (recordedOn !== recordedOnText(interview)) update.recorded_on = recordedOn || null;
  const language = value.language || null;
  if (language !== interview.language_confirmed) update.language = language;
  return update;
}

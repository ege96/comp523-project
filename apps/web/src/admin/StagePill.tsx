import { Pill, type PillTone } from "../components/Pill";
import { QUEUE_LABELS, type Queue } from "./workflow";

const TONES = {
  attention: "amber",
  processing: "neutral",
  ready: "terracotta",
  published: "green",
} as const satisfies Record<Queue, PillTone>;

/** Where an interview is in the admin's work, in the same words as the home page's tabs. */
export function StagePill({ queue }: { queue: Queue }) {
  return <Pill tone={TONES[queue]}>{QUEUE_LABELS[queue]}</Pill>;
}

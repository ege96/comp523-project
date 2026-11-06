// Obviously made-up records: never mockup names, quotes or IDs (project rule).
export const interviewSummary = {
  id: "00000000-0000-4000-8000-000000000001",
  title: "Test interview A",
  interviewee: null,
  interviewee_id: null,
  primary_language: { code: "ne", name: "Nepali" },
  duration_ms: 3_723_000,
  recorded_on: "2001-05-01",
  recorded_on_precision: "month",
  visibility: "public",
  status: "done",
  translation_status: "pending",
  created_at: "2026-10-14T00:00:00Z",
} as const;

export const interviewDetail = {
  ...interviewSummary,
  interviewee: "Interviewee B",
  interviewee_id: 7,
  interviewer: "Interviewer C",
  location: null,
  description: "Description D",
  consent_note: "Consent note E",
  languages: [{ code: "ne", name: "Nepali" }],
  media: {
    url: "/api/media/m1?sig=x",
    content_type: "audio/mp4",
    expires_at: "2026-10-14T06:00:00Z",
  },
  status_detail: null,
  language_detected: null,
  language_detected_confidence: null,
  language_confirmed: null,
};

export const segments = {
  items: [
    {
      seq: 0,
      start_ms: 754_000,
      end_ms: 760_000,
      language: "ne",
      original_text: "Original text A",
      english_text: null,
      original_edited: false,
      english_edited: false,
    },
  ],
};

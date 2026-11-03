import { DetailedError, Upload } from "tus-js-client";

import { API_BASE_URL } from "../config";

/**
 * What the upload API accepts as tus `Upload-Metadata` besides the file's name and type
 * (D-004: only the title is required). Undefined fields are left out.
 */
export type RecordingMetadata = {
  title: string;
  /** en, ne or new. Left out, the worker detects the language and an admin confirms it. */
  language?: string;
  intervieweeId?: number;
  intervieweeName?: string;
  /** YYYY, YYYY-MM or YYYY-MM-DD. */
  recordedOn?: string;
};

export type UploadHandle = {
  /** Resolves with the new interview's id once the last byte is in. */
  done: Promise<string>;
  /** Stops sending. The partial upload stays on the server until the worker sweeps it. */
  abort: () => void;
};

// The API holds one PATCH body in memory and refuses chunks over 64 MiB. Smaller chunks
// also lose less on a dropped connection, which matters for slow links (NF3).
const CHUNK_BYTES = 16 * 1024 * 1024;
// A flaky link gets about a minute and a half of retries before the upload reports an error.
const RETRY_DELAYS_MS = [0, 1_000, 3_000, 5_000, 10_000, 20_000, 30_000];
const INTERVIEW_ID_HEADER = "Upload-Interview-Id";

export function toTusMetadata(file: File, m: RecordingMetadata): Record<string, string> {
  const fields: Record<string, string | number | undefined> = {
    filename: file.name,
    filetype: file.type,
    title: m.title,
    language: m.language,
    interviewee_id: m.intervieweeId,
    interviewee_name: m.intervieweeName,
    recorded_on: m.recordedOn,
  };
  return Object.fromEntries(
    Object.entries(fields).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]])),
  );
}

/** The API's reason for refusing an upload, in words an admin can act on. */
export function uploadErrorMessage(error: unknown): string {
  const res = error instanceof DetailedError ? error.originalResponse : null;
  if (!res) return "The upload stopped: the connection to the archive was lost.";
  let detail: unknown;
  try {
    detail = (JSON.parse(res.getBody()) as { detail?: unknown }).detail;
  } catch {
    detail = undefined;
  }
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    // Pydantic errors: [{loc: ["title"], msg: "..."}]
    return detail
      .map(
        (e: { loc?: (string | number)[]; msg?: string }) =>
          `${String(e.loc?.at(-1) ?? "")}: ${e.msg ?? ""}`,
      )
      .join("; ");
  }
  if (res.getStatus() === 401 || res.getStatus() === 403)
    return "Your sign-in has expired or isn't an admin account. Sign in again and retry.";
  return `The archive refused the upload (HTTP ${String(res.getStatus())}).`;
}

/**
 * Sends a recording with tus, resuming an earlier attempt at the same file with the same
 * metadata (tus-js-client remembers it in localStorage). The token is fetched before every
 * request, because a multi-GB upload can outlast a Firebase ID token.
 */
export function startUpload(
  file: File,
  metadata: RecordingMetadata,
  {
    getToken,
    onProgress,
  }: {
    getToken: () => Promise<string | null>;
    onProgress: (sent: number, total: number) => void;
  },
): UploadHandle {
  const tusMetadata = toTusMetadata(file, metadata);
  let interviewId: string | undefined;
  let upload: Upload | undefined;
  let aborted = false;
  const done = new Promise<string>((resolve, reject) => {
    upload = new Upload(file, {
      endpoint: `${API_BASE_URL}/api/uploads`,
      metadata: tusMetadata,
      chunkSize: CHUNK_BYTES,
      retryDelays: RETRY_DELAYS_MS,
      removeFingerprintOnSuccess: true,
      onBeforeRequest: async (req) => {
        const token = await getToken();
        if (token) req.setHeader("Authorization", `Bearer ${token}`);
      },
      onAfterResponse: (_req, res) => {
        interviewId = res.getHeader(INTERVIEW_ID_HEADER) ?? interviewId;
      },
      onProgress,
      onSuccess: () => {
        if (interviewId) resolve(interviewId);
        else reject(new Error("The archive didn't say which interview it created."));
      },
      onError: reject,
    });
    const current = upload;
    void current
      .findPreviousUploads()
      .then((previous) => {
        const same = previous.find(
          (p) => JSON.stringify(p.metadata) === JSON.stringify(tusMetadata),
        );
        if (same) current.resumeFromPreviousUpload(same);
      })
      .catch(() => undefined) // no localStorage: start from the beginning
      .finally(() => {
        if (!aborted) current.start();
      });
  });
  return {
    done,
    abort: () => {
      aborted = true;
      void upload?.abort();
    },
  };
}

const DATE_PATTERN = /^\d{4}(-\d{2}(-\d{2})?)?$/;

/** YYYY, YYYY-MM or YYYY-MM-DD, and a date that exists (no 2024-02-30). */
export function recordedOnError(value: string): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  const message = "Use YYYY, YYYY-MM or YYYY-MM-DD, with as much of the date as is known";
  if (!DATE_PATTERN.test(text)) return message;
  const [y = 0, m = 1, d = 1] = text.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
    ? undefined
    : message;
}

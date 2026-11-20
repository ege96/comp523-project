import { datePartsError, NO_DATE, type DateParts } from "./recordedOn";

export type Interviewee = { id: number | null; name: string };

export const NO_INTERVIEWEE: Interviewee = { id: null, name: "" };

/** One recording in the upload list, with the details sent along with it. */
export type QueueRow = {
  key: string;
  file: File;
  title: string;
  interviewee: Interviewee;
  language: string;
  recordedOn: DateParts;
};

/** Where a row's upload is. Rows start "ready"; Upload makes every ready or failed row wait. */
export type RowStatus =
  | { phase: "ready" }
  | { phase: "waiting" }
  | { phase: "uploading"; sent: number }
  | { phase: "done"; interviewId: string }
  | { phase: "failed"; message: string };

/** Details applied to every row that doesn't have its own. */
export type SharedDetails = Pick<QueueRow, "interviewee" | "language" | "recordedOn">;

export const NO_SHARED_DETAILS: SharedDetails = {
  interviewee: NO_INTERVIEWEE,
  language: "",
  recordedOn: NO_DATE,
};

export function isMedia(file: File): boolean {
  return /^(audio|video)\//.test(file.type);
}

/** "village-talk.mp3" -> "village-talk". */
export function titleFromFile(file: File): string {
  return file.name.replace(/\.[^.]+$/, "");
}

function fileKey(file: File): string {
  return `${file.name}:${String(file.size)}:${String(file.lastModified)}`;
}

/**
 * Rows for newly chosen files. Files that aren't audio or video, and files already in the
 * list, are left out and reported by name.
 */
export function rowsForFiles(
  existing: readonly QueueRow[],
  files: readonly File[],
): { rows: QueueRow[]; notMedia: string[]; duplicates: string[] } {
  const seen = new Set(existing.map((r) => r.key));
  const rows: QueueRow[] = [];
  const notMedia: string[] = [];
  const duplicates: string[] = [];
  for (const file of files) {
    const key = fileKey(file);
    if (!isMedia(file)) notMedia.push(file.name);
    else if (seen.has(key)) duplicates.push(file.name);
    else {
      seen.add(key);
      rows.push({ key, file, title: titleFromFile(file), ...NO_SHARED_DETAILS });
    }
  }
  return { rows, notMedia, duplicates };
}

function hasInterviewee(i: Interviewee): boolean {
  return i.id !== null || i.name.trim() !== "";
}

function hasDate(d: DateParts): boolean {
  return d.year.trim() !== "" || d.month !== "" || d.day !== "";
}

/** Fills each detail a row leaves empty from `shared`; what a row already has stays. */
export function withSharedDetails(row: QueueRow, shared: SharedDetails): QueueRow {
  return {
    ...row,
    interviewee: hasInterviewee(row.interviewee) ? row.interviewee : shared.interviewee,
    language: row.language || shared.language,
    recordedOn: hasDate(row.recordedOn) ? row.recordedOn : shared.recordedOn,
  };
}

export function titleError(title: string): string | undefined {
  const t = title.trim();
  if (!t) return "Enter a title";
  if (t.length > 500) return "Keep the title under 500 characters";
  return undefined;
}

/** What stops a row from uploading, or undefined. */
export function rowError(row: QueueRow, maxUploadBytes: number | undefined): string | undefined {
  if (maxUploadBytes !== undefined && row.file.size > maxUploadBytes)
    return "This file is larger than the archive accepts";
  return titleError(row.title) ?? datePartsError(row.recordedOn);
}

/** Rows still to send: not uploaded yet, or failed. */
export function isPending(status: RowStatus | undefined): boolean {
  return !status || status.phase === "ready" || status.phase === "failed";
}

/** A row that can't be changed or removed: it is queued, sending, or sent. */
export function isLocked(status: RowStatus | undefined): boolean {
  return status?.phase === "waiting" || status?.phase === "uploading" || status?.phase === "done";
}

/** Bytes still to send, for comparing a batch with the space left. */
export function bytesToSend(rows: readonly QueueRow[], status: Record<string, RowStatus>): number {
  return rows.reduce((sum, row) => {
    const s = status[row.key];
    if (s?.phase === "done") return sum;
    return sum + row.file.size - (s?.phase === "uploading" ? s.sent : 0);
  }, 0);
}

/** "a.txt", "a.txt and b.pdf", "a.txt, b.pdf and 3 more". */
export function listNames(names: readonly string[], shown = 2): string {
  if (names.length <= shown + 1) {
    return names.length > 1
      ? `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`
      : names.join("");
  }
  return `${names.slice(0, shown).join(", ")} and ${String(names.length - shown)} more`;
}

// The parts of the File and Directory Entries API a dropped folder is read with.
type Entry = {
  isFile: boolean;
  isDirectory: boolean;
  file?: (ok: (file: File) => void, fail: (error: unknown) => void) => void;
  createReader?: () => {
    readEntries: (ok: (entries: Entry[]) => void, fail: (error: unknown) => void) => void;
  };
};

async function filesIn(entry: Entry): Promise<File[]> {
  if (entry.isFile && entry.file) {
    const read = entry.file.bind(entry);
    return [
      await new Promise<File>((ok, fail) => {
        read(ok, fail);
      }),
    ];
  }
  if (!entry.isDirectory || !entry.createReader) return [];
  const reader = entry.createReader();
  const files: File[] = [];
  // readEntries returns a directory in batches; an empty batch means it's all been read.
  for (;;) {
    const batch = await new Promise<Entry[]>((ok, fail) => {
      reader.readEntries(ok, fail);
    });
    if (batch.length === 0) return files;
    for (const child of batch) files.push(...(await filesIn(child)));
  }
}

/** Every file dropped, including those inside dropped folders and their subfolders. */
export async function droppedFiles(data: DataTransfer): Promise<File[]> {
  const entries = Array.from((data.items as DataTransferItemList | undefined) ?? [])
    .map((item) => item.webkitGetAsEntry() as Entry | null)
    .filter((e): e is Entry => e !== null);
  if (entries.length === 0) return Array.from(data.files);
  const nested = await Promise.all(entries.map(filesIn));
  return nested.flat();
}

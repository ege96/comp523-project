import { expect, it } from "vitest";

import {
  droppedFiles,
  listNames,
  NO_SHARED_DETAILS,
  rowsForFiles,
  withSharedDetails,
} from "./uploadQueue";

const audio = (name: string) => new File(["x"], name, { type: "audio/mpeg" });

// A dropped entry as the File and Directory Entries API gives it; folders answer in batches.
function fileEntry(file: File) {
  return {
    isFile: true,
    isDirectory: false,
    file: (ok: (f: File) => void) => {
      ok(file);
    },
  };
}
function folderEntry(...batches: unknown[][]) {
  return {
    isFile: false,
    isDirectory: true,
    createReader: () => {
      const left = [...batches, []];
      return {
        readEntries: (ok: (e: unknown[]) => void) => {
          ok(left.shift() ?? []);
        },
      };
    },
  };
}

it("reads dropped folders and their subfolders, and plain files without entries", async () => {
  const [a, b, c] = [audio("a.mp3"), audio("b.mp3"), audio("c.mp3")];
  const tree = folderEntry([fileEntry(a)], [folderEntry([fileEntry(b)])]);
  const items = [tree, fileEntry(c)].map((entry) => ({ webkitGetAsEntry: () => entry }));
  const data = { items, files: [] } as unknown as DataTransfer;
  expect(await droppedFiles(data)).toEqual([a, b, c]);
  expect(await droppedFiles({ files: [a] } as unknown as DataTransfer)).toEqual([a]);
});

it("fills only the details a row leaves empty, and names skipped files briefly", () => {
  const [row] = rowsForFiles([], [audio("talk.mp3")]).rows;
  if (!row) throw new Error("no row");
  const own = { ...row, language: "en", recordedOn: { year: "2019", month: "", day: "" } };
  const shared = { ...NO_SHARED_DETAILS, language: "ne", interviewee: { id: 7, name: "F" } };
  expect(withSharedDetails(own, shared)).toMatchObject({
    language: "en",
    recordedOn: { year: "2019" },
    interviewee: { id: 7 },
  });
  expect(listNames(["a"])).toBe("a");
  expect(listNames(["a", "b", "c"])).toBe("a, b and c");
  expect(listNames(["a", "b", "c", "d"])).toBe("a, b and 2 more");
});

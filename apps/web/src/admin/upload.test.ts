import { DetailedError, type HttpResponse, type UploadOptions } from "tus-js-client";
import { afterEach, expect, it, vi } from "vitest";

// A stand-in for tus-js-client's Upload: records its options and plays back one upload.
type Fake = {
  options?: UploadOptions;
  previous: { metadata: Record<string, string> }[];
  resumed: unknown;
};
const fake = vi.hoisted((): Fake => ({ previous: [], resumed: null }));

vi.mock("tus-js-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("tus-js-client")>();
  class Upload {
    constructor(_file: File, options: UploadOptions) {
      fake.options = options;
    }
    findPreviousUploads() {
      return Promise.resolve(fake.previous);
    }
    resumeFromPreviousUpload(p: unknown) {
      fake.resumed = p;
    }
    start() {}
    abort() {
      return Promise.resolve();
    }
  }
  return { ...actual, Upload };
});

const { startUpload, toTusMetadata, uploadErrorMessage } = await import("./upload");

afterEach(() => {
  fake.options = undefined;
  fake.previous = [];
  fake.resumed = null;
});

const file = new File(["x"], "talk.mp3", { type: "audio/mpeg" });

function response(status: number, body: string, headers: Record<string, string> = {}) {
  return {
    getStatus: () => status,
    getBody: () => body,
    getHeader: (h: string) => headers[h],
    getUnderlyingObject: () => null,
  } satisfies HttpResponse;
}

it("sends only the metadata it has, resumes the same upload, and resolves with the interview", async () => {
  const metadata = { title: "T", intervieweeId: 7, recordedOn: "2019-05" };
  expect(toTusMetadata(file, metadata)).toEqual({
    filename: "talk.mp3",
    filetype: "audio/mpeg",
    title: "T",
    interviewee_id: "7",
    recorded_on: "2019-05",
  });

  // An earlier attempt with other details isn't resumed; one with the same details is.
  fake.previous = [
    { metadata: { ...toTusMetadata(file, metadata), title: "Other" } },
    { metadata: toTusMetadata(file, metadata) },
  ];
  const handle = startUpload(file, metadata, {
    getToken: () => Promise.resolve("tok"),
    onProgress: vi.fn(),
  });
  await vi.waitFor(() => {
    expect(fake.resumed).toBe(fake.previous[1]);
  });

  const options = fake.options;
  if (!options) throw new Error("no upload created");
  expect(options.chunkSize).toBeLessThanOrEqual(64 * 1024 * 1024);
  const headers: Record<string, string> = {};
  await options.onBeforeRequest?.({
    setHeader: (k: string, v: string) => (headers[k] = v),
  } as never);
  expect(headers).toEqual({ Authorization: "Bearer tok" });

  await options.onAfterResponse?.(
    null as never,
    response(204, "", { "Upload-Interview-Id": "abc" }),
  );
  options.onSuccess?.({ lastResponse: response(204, "") });
  await expect(handle.done).resolves.toBe("abc");
});

it("explains refusals", () => {
  const refused = (status: number, body: string) =>
    uploadErrorMessage(
      Object.assign(new DetailedError("x"), { originalResponse: response(status, body) }),
    );
  expect(refused(413, '{"detail": "Recordings can be at most 10 bytes"}')).toBe(
    "Recordings can be at most 10 bytes",
  );
  expect(refused(422, '{"detail": [{"loc": ["title"], "msg": "too short"}]}')).toBe(
    "title: too short",
  );
  expect(refused(401, "")).toMatch(/sign-in has expired/);
  expect(uploadErrorMessage(new Error("offline"))).toMatch(/connection/);
});

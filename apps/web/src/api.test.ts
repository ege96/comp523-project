import { describe, expect, it, vi } from "vitest";

import { fetchReadiness, UnexpectedResponseError } from "./api";

function respond(body: string, status = 200) {
  return vi.fn(() => Promise.resolve(new Response(body, { status })));
}

describe("fetchReadiness", () => {
  it("returns the readiness body even on a 503", async () => {
    const body = { status: "unavailable", database: true, pgvector: false };
    const fakeFetch = respond(JSON.stringify(body), 503);

    await expect(fetchReadiness(fakeFetch)).resolves.toEqual(body);
    expect(fakeFetch).toHaveBeenCalledWith("/api/health/ready");
  });

  it("rejects a non-JSON reply such as a proxy error page", async () => {
    await expect(fetchReadiness(respond("<html>Bad gateway</html>", 502))).rejects.toThrow(
      UnexpectedResponseError,
    );
  });

  it.each([
    ["not an object", "null"],
    ["unknown status", JSON.stringify({ status: "maybe", database: true, pgvector: true })],
    ["missing field", JSON.stringify({ status: "ok", database: true })],
    ["wrong type", JSON.stringify({ status: "ok", database: "yes", pgvector: true })],
  ])("rejects a body with the wrong shape (%s)", async (_, body) => {
    await expect(fetchReadiness(respond(body))).rejects.toThrow(/HTTP 200/);
  });
});

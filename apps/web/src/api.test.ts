import { describe, expect, it, vi } from "vitest";

import { fetchReadiness } from "./api";

describe("fetchReadiness", () => {
  it("returns the readiness body even on a 503", async () => {
    const body = { status: "unavailable", database: true, pgvector: false };
    const fakeFetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(body), { status: 503 })),
    );

    await expect(fetchReadiness(fakeFetch)).resolves.toEqual(body);
    expect(fakeFetch).toHaveBeenCalledWith("/api/health/ready");
  });
});

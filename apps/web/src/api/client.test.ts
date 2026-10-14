import { afterEach, expect, it, vi } from "vitest";

import { stubApi } from "../test/renderApp";
import { ApiError, createQueryClient, getJson } from "./client";
import { AdminSchema } from "./schemas";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("rejects a response that doesn't match the schema instead of passing it on", async () => {
  stubApi({ "/api/auth/me": { body: { id: "1" } } });
  await expect(getJson("/api/auth/me", AdminSchema)).rejects.toBeInstanceOf(ApiError);
});

it("retries server errors twice but never a 4xx", () => {
  const retry = createQueryClient().getDefaultOptions().queries?.retry;
  if (typeof retry !== "function") throw new Error("expected a retry function");
  expect(retry(0, new ApiError(404, "/x"))).toBe(false);
  expect([retry(1, new ApiError(503, "/x")), retry(2, new ApiError(503, "/x"))]).toEqual([
    true,
    false,
  ]);
});

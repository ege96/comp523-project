import { describe, expect, it, vi } from "vitest";

import { singleFlight } from "./singleFlight";

describe("singleFlight", () => {
  it("shares one run between calls made while it is running", async () => {
    let resolve: (token: string) => void = () => undefined;
    const run = vi.fn(
      () =>
        new Promise<string>((r) => {
          resolve = r;
        }),
    );
    const getToken = singleFlight(run);
    const calls = [getToken(), getToken(), getToken()];
    resolve("t1");
    expect(await Promise.all(calls)).toEqual(["t1", "t1", "t1"]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs again once the last run has settled, even if it failed", async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue("t2");
    const getToken = singleFlight(run);
    await expect(getToken()).rejects.toThrow("offline");
    expect(await getToken()).toBe("t2");
    expect(run).toHaveBeenCalledTimes(2);
  });
});

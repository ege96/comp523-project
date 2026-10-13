import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "./App";

afterEach(cleanup);

describe("App readiness banner", () => {
  it("reports ready when API, database and pgvector are up", async () => {
    render(
      <App
        loadReadiness={() => Promise.resolve({ status: "ok", database: true, pgvector: true })}
      />,
    );
    expect(await screen.findByText(/pgvector are ready/)).toBeTruthy();
  });

  it("says pgvector is missing when the database is up without it", async () => {
    render(
      <App
        loadReadiness={() =>
          Promise.resolve({ status: "unavailable", database: true, pgvector: false })
        }
      />,
    );
    expect(await screen.findByText(/pgvector is missing/)).toBeTruthy();
  });

  it("shows an error when the API cannot be reached", async () => {
    render(<App loadReadiness={() => Promise.reject(new Error("network"))} />);
    expect(await screen.findByText(/could not be reached/)).toBeTruthy();
  });
});

// Load test for search (see the README's Performance section). Run against the API limited
// to the CloudApps pod size (perf/compose.perf.yaml), never hard against the live cluster:
//
//   k6 run -e API_URL=http://localhost:8000 perf/search_load.js
//   k6 run -e API_URL=http://localhost:8000 -e PROFILE=smoke perf/search_load.js   # CI
//
// Each virtual user searches with a query from perf/queries.txt, waits 1-3 s, and 1 in 10
// times also opens an interview from the results, like a visitor reading a moment.
import http from "k6/http";
import { check, sleep } from "k6";

const API = (__ENV.API_URL || "http://localhost:8000").replace(/\/$/, "");

const queries = open("./queries.txt")
  .split("\n")
  .filter((line) => line.trim() && !line.startsWith("#"))
  .map((line) => {
    const [kind, q, extra] = line.split("\t");
    return { kind, q, extra: extra || "" };
  });

const profiles = {
  // The plan's full run: ramp to 50 users over 5 min, hold 5 min, ramp down.
  full: [
    { duration: "5m", target: 50 },
    { duration: "5m", target: 50 },
    { duration: "1m", target: 0 },
  ],
  // The plan's pass mark, held briefly: 10 users.
  smoke: [
    { duration: "15s", target: 10 },
    { duration: "45s", target: 10 },
    { duration: "5s", target: 0 },
  ],
};

export const options = {
  stages: profiles[__ENV.PROFILE || "full"],
  thresholds: {
    // Plan targets: 95% of searches within 5 s, under 1% errors.
    "http_req_duration{name:search}": ["p(95)<5000"],
    http_req_failed: ["rate<0.01"],
  },
};

export default function () {
  const query = queries[Math.floor(Math.random() * queries.length)];
  const qs = `q=${encodeURIComponent(query.q)}${query.extra ? `&${query.extra}` : ""}`;
  const res = http.get(`${API}/api/search?${qs}`, {
    tags: { name: "search", kind: query.kind },
  });
  check(res, { "search ok": (r) => r.status === 200 });

  const items = res.status === 200 ? res.json("items") : [];
  if (items.length && Math.random() < 0.1) {
    const id = items[0].interview.id;
    const page = http.get(`${API}/api/interviews/${id}`, { tags: { name: "interview" } });
    check(page, { "interview ok": (r) => r.status === 200 });
  }
  sleep(1 + Math.random() * 2);
}

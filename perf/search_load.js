// Load test for search (see the README's Performance section). Run against the API limited
// to the CloudApps pod size (perf/compose.perf.yaml), never hard against the live cluster:
//
//   k6 run -e API_URL=http://localhost:8000 perf/search_load.js
//   k6 run -e API_URL=http://localhost:8000 -e PROFILE=smoke perf/search_load.js   # CI
//   k6 run -e API_URL=http://localhost:8000 -e PROFILE=ceiling perf/search_load.js
//
// `ceiling` drops the think time and raises the request rate step by step (1 to MAX_RPS,
// default 20, searches per second), so the point where p95 or errors climb is the most one
// API pod can serve. Read the per-step results with `--out json=...` or from the summary.
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

const PROFILE = __ENV.PROFILE || "full";
const MAX_RPS = Number(__ENV.MAX_RPS || 20);

function ceilingStages() {
  // 1 req/s, then steps up to MAX_RPS, a minute each, so each step settles.
  const steps = [];
  for (let rps = 1; rps <= MAX_RPS; rps = rps < 4 ? rps + 1 : rps + 2) {
    steps.push({ duration: "10s", target: rps }, { duration: "50s", target: rps });
  }
  return steps;
}

export const options = {
  ...(PROFILE === "ceiling"
    ? {
        scenarios: {
          ceiling: {
            executor: "ramping-arrival-rate",
            startRate: 1,
            timeUnit: "1s",
            preAllocatedVUs: 20,
            maxVUs: 200,
            stages: ceilingStages(),
          },
        },
      }
    : { stages: profiles[PROFILE] }),
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
  if (PROFILE !== "ceiling") sleep(1 + Math.random() * 2);
}

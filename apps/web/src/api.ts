export type ReadinessStatus = {
  status: "ok" | "unavailable";
  database: boolean;
  pgvector: boolean;
};

// Same-origin by default. Set VITE_API_BASE_URL only if the API is served from another host.
const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? "";

/** The API answered with something other than what this client expects. */
export class UnexpectedResponseError extends Error {
  constructor(url: string, status: number) {
    super(`Unexpected response from ${url} (HTTP ${String(status)})`);
    this.name = "UnexpectedResponseError";
  }
}

// Hand-written for now; real endpoints get zod schemas and OpenAPI-generated types (D-009).
function isReadinessStatus(value: unknown): value is ReadinessStatus {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.status === "ok" || v.status === "unavailable") &&
    typeof v.database === "boolean" &&
    typeof v.pgvector === "boolean"
  );
}

export async function fetchReadiness(fetchImpl: typeof fetch = fetch): Promise<ReadinessStatus> {
  const url = `${API_BASE_URL}/api/health/ready`;
  const res = await fetchImpl(url);
  // 503 still carries a JSON body describing what is missing, so the status alone isn't checked.
  // Anything else (an HTML error page from a proxy, a different shape) is an error.
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new UnexpectedResponseError(url, res.status);
  }
  if (!isReadinessStatus(body)) throw new UnexpectedResponseError(url, res.status);
  return body;
}

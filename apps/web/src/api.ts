export type ReadinessStatus = {
  status: "ok" | "unavailable";
  database: boolean;
  pgvector: boolean;
};

// Same-origin by default. Set VITE_API_BASE_URL only if the API is served from another host.
const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? "";

export async function fetchReadiness(
  fetchImpl: typeof fetch = fetch,
): Promise<ReadinessStatus> {
  // 503 still carries a JSON body describing what is missing.
  const res = await fetchImpl(`${API_BASE_URL}/api/health/ready`);
  return (await res.json()) as ReadinessStatus;
}

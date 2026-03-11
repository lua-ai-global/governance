/**
 * Shared configuration for all examples.
 *
 * Set these env vars before running:
 *   GOVERNANCE_API_URL — enforcement API base URL
 *   GOVERNANCE_API_KEY — org-scoped Clerk API key
 */

export const API_URL = process.env.GOVERNANCE_API_URL ?? "http://localhost:4000";
export const API_KEY = process.env.GOVERNANCE_API_KEY ?? "";

if (!API_KEY) {
  console.error("GOVERNANCE_API_KEY is required. Set it in your environment.");
  process.exit(1);
}

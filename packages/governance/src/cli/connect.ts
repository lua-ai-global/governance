/**
 * governance-sdk connect — test API connectivity and show diagnostics.
 *
 * Usage: npx governance-sdk connect
 *
 * Reads GOVERNANCE_API_URL and GOVERNANCE_API_KEY from env (or governance.config.ts).
 * Reports: connection status, plan, features, agent quota, latency.
 */

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";

function print(msg: string) {
  process.stdout.write(msg + "\n");
}

export async function runConnect(): Promise<void> {
  const serverUrl = process.env["GOVERNANCE_API_URL"] ?? process.env["GOVERNANCE_SERVER_URL"] ?? "";
  const apiKey = process.env["GOVERNANCE_API_KEY"] ?? "";

  print("");
  print(`${BOLD}governance-sdk connect${RESET}`);
  print(`${DIM}Testing connection to governance API...${RESET}`);
  print("");

  if (!serverUrl) {
    print(`${RED}Error:${RESET} GOVERNANCE_API_URL not set`);
    print(`${DIM}Set it in your environment: export GOVERNANCE_API_URL=https://api.heygovernance.ai${RESET}`);
    process.exit(1);
  }

  if (!apiKey) {
    print(`${RED}Error:${RESET} GOVERNANCE_API_KEY not set`);
    print(`${DIM}Get an API key from your governance dashboard → Settings → API Keys${RESET}`);
    process.exit(1);
  }

  print(`  Server:  ${CYAN}${serverUrl}${RESET}`);
  print(`  API Key: ${DIM}${apiKey.slice(0, 8)}...${apiKey.slice(-4)}${RESET}`);
  print("");

  try {
    const start = performance.now();
    const res = await fetch(`${serverUrl.replace(/\/$/, "")}/api/v1/connect`, {
      headers: { "Authorization": `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    });
    const latencyMs = Math.round(performance.now() - start);

    if (!res.ok) {
      if (res.status === 401) {
        print(`${RED}Authentication failed${RESET} (${res.status})`);
        print(`${DIM}Check your GOVERNANCE_API_KEY — it may be expired or revoked.${RESET}`);
      } else {
        print(`${RED}Connection failed${RESET} (${res.status} ${res.statusText})`);
      }
      process.exit(1);
    }

    const data = await res.json() as {
      ok: boolean;
      orgId: string;
      plan: string;
      features: string[];
      agentQuota: { used: number; limit: number | string };
      version: string;
    };

    print(`  ${GREEN}Connected${RESET} in ${latencyMs}ms`);
    print("");
    print(`  Org:      ${data.orgId}`);
    print(`  Plan:     ${BOLD}${data.plan}${RESET}`);
    print(`  Agents:   ${data.agentQuota.used} / ${data.agentQuota.limit}`);
    print(`  Features: ${data.features.join(", ")}`);
    print(`  API:      v${data.version}`);
    print(`  Latency:  ${latencyMs}ms`);
    print("");
    print(`${GREEN}Ready to enforce.${RESET}`);
  } catch (err) {
    print(`${RED}Connection failed${RESET}`);
    print(`${DIM}${err instanceof Error ? err.message : "Network error"}${RESET}`);
    print("");
    print(`Check that the server is running at ${serverUrl}`);
    process.exit(1);
  }
}

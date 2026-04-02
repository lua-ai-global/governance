import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Test the config generation logic directly (extracted for testing)
interface InitConfig {
  agentName: string;
  owner: string;
  framework: string;
  blockDangerous: boolean;
  requireApproval: boolean;
  tokenLimit: number;
  useProcessor: boolean;
}

function generateConfigFile(config: InitConfig): string {
  const imports: string[] = ["createGovernance", "blockTools"];
  const rules: string[] = [];

  if (config.blockDangerous) {
    rules.push(`    blockTools([\n      'shell_exec', 'rm_rf', 'database_drop',\n      'file_delete', 'process_kill',\n    ]),`);
  }
  if (config.requireApproval) {
    imports.push("requireApproval");
    rules.push(`    requireApproval(['data_export', 'email_send', 'payment_process']),`);
  }
  if (config.tokenLimit > 0) {
    imports.push("tokenBudget");
    rules.push(`    tokenBudget(${config.tokenLimit.toLocaleString().replace(/,/g, "_")}),`);
  }

  const content = `import { ${imports.join(", ")} } from 'governance-sdk';`;
  return content + "\n" + rules.join("\n");
}

describe("CLI init config generation", () => {
  it("generates blockTools rule when blockDangerous is true", () => {
    const config: InitConfig = {
      agentName: "test-agent",
      owner: "test-team",
      framework: "mastra",
      blockDangerous: true,
      requireApproval: false,
      tokenLimit: 0,
      useProcessor: false,
    };
    const result = generateConfigFile(config);
    assert.ok(result.includes("blockTools"));
    assert.ok(result.includes("shell_exec"));
    assert.ok(result.includes("database_drop"));
  });

  it("includes requireApproval when configured", () => {
    const config: InitConfig = {
      agentName: "test-agent",
      owner: "test-team",
      framework: "mastra",
      blockDangerous: false,
      requireApproval: true,
      tokenLimit: 0,
      useProcessor: false,
    };
    const result = generateConfigFile(config);
    assert.ok(result.includes("requireApproval"));
    assert.ok(result.includes("data_export"));
  });

  it("includes tokenBudget when limit > 0", () => {
    const config: InitConfig = {
      agentName: "test-agent",
      owner: "test-team",
      framework: "mastra",
      blockDangerous: false,
      requireApproval: false,
      tokenLimit: 100000,
      useProcessor: false,
    };
    const result = generateConfigFile(config);
    assert.ok(result.includes("tokenBudget"));
    assert.ok(result.includes("100_000"));
  });

  it("imports only needed functions", () => {
    const config: InitConfig = {
      agentName: "test-agent",
      owner: "test-team",
      framework: "mastra",
      blockDangerous: true,
      requireApproval: false,
      tokenLimit: 0,
      useProcessor: false,
    };
    const result = generateConfigFile(config);
    assert.ok(result.includes("createGovernance"));
    assert.ok(result.includes("blockTools"));
    assert.ok(!result.includes("requireApproval"));
    assert.ok(!result.includes("tokenBudget"));
  });
});

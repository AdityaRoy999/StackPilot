#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverPath = path.resolve(__dirname, "../src/index.js");

function readText(result) {
  return (result.content || [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

async function callTool(client, name, args = {}, timeoutMs = 60_000) {
  const result = await client.callTool(
    { name, arguments: args },
    undefined,
    { timeout: timeoutMs, maxTotalTimeout: timeoutMs }
  );
  const text = readText(result);
  if (result.isError) {
    throw new Error(`${name} failed: ${text}`);
  }
  return text;
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: {
    ...process.env,
    DOKSCP_API_URL: process.env.DOKSCP_API_URL || "http://localhost:8090/api/v1",
    DOKSCP_FRONTEND_URL: process.env.DOKSCP_FRONTEND_URL || "http://localhost:3000",
  },
});

const client = new Client({
  name: "dokscp-mcp-smoke",
  version: "1.0.0",
});

try {
  await client.connect(transport);

  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  console.log(`MCP initialized. ${names.length} tool(s) available.`);
  console.log(names.join(", "));

  const health = await callTool(client, "dokscp_health");
  console.log("\n[dokscp_health]");
  console.log(health);

  if (process.env.DOKSCP_MCP_TOKEN) {
    const auth = await callTool(client, "dokscp_verify_auth");
    console.log("\n[dokscp_verify_auth]");
    console.log(auth);
  } else {
    console.log("\n[dokscp_verify_auth] skipped because DOKSCP_MCP_TOKEN is not set.");
  }

  if (process.env.DOKSCP_MCP_SMOKE_PROJECT) {
    const deployArgs = {
      project_path: process.env.DOKSCP_MCP_SMOKE_PROJECT,
      project_name: process.env.DOKSCP_MCP_SMOKE_PROJECT_NAME || "mcp-smoke-project",
      dry_run: process.env.DOKSCP_MCP_SMOKE_DEPLOY !== "1",
      wait_for_ready: process.env.DOKSCP_MCP_SMOKE_DEPLOY === "1",
      wait_seconds: Number(process.env.DOKSCP_MCP_SMOKE_WAIT_SECONDS || 180),
    };
    const deployTimeout = deployArgs.wait_for_ready
      ? (deployArgs.wait_seconds + 90) * 1000
      : 60_000;
    const deploy = await callTool(client, "dokscp_deploy_local_project", deployArgs, deployTimeout);
    console.log("\n[dokscp_deploy_local_project]");
    console.log(deploy);
  }
} finally {
  await client.close();
}

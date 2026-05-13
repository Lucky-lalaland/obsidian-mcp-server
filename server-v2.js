const express = require("express");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const z = require("zod");
const { execSync } = require("child_process");
const fs = require("fs");
const crypto = require("crypto");

// ===== CONFIG =====
const PORT = 3100;
const SECRET = process.env.MCP_SECRET || crypto.randomUUID();
const MCP_PATH = `/mcp/${SECRET}`;
// ==================

const app = express();
app.use(express.json());

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.all(MCP_PATH, async (req, res) => {
  const server = new McpServer({
    name: "quillink-vps",
    version: "1.0.0",
  });

  server.tool(
    "vps_shell",
    "Execute a shell command on the VPS",
    {
      command: z.string().describe("The bash command to execute"),
      timeout: z.number().optional().default(30).describe("Timeout in seconds"),
    },
    async ({ command, timeout }) => {
      try {
        const result = execSync(command, {
          timeout: (timeout || 30) * 1000,
          encoding: "utf-8",
          maxBuffer: 1024 * 1024,
          shell: "/bin/bash",
        });
        return { content: [{ type: "text", text: result || "(empty output)" }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error (code ${err.status}):\n${err.stderr || err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "vps_read_file",
    "Read a file from the VPS",
    { path: z.string().describe("Absolute file path") },
    async ({ path }) => {
      try {
        const content = fs.readFileSync(path, "utf-8");
        return { content: [{ type: "text", text: content }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "vps_write_file",
    "Write content to a file on the VPS",
    {
      path: z.string().describe("Absolute file path"),
      content: z.string().describe("File content"),
    },
    async ({ path, content }) => {
      try {
        fs.writeFileSync(path, content, "utf-8");
        return { content: [{ type: "text", text: `Written to ${path}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.use((req, res) => res.status(404).json({ error: "Not found" }));

app.listen(PORT, "127.0.0.1", () => {
  console.log(`MCP Server running on port ${PORT}`);
  console.log(`Endpoint: ${MCP_PATH}`);
  console.log(`Secret: ${SECRET}`);
  console.log(`\nConnector URL: https://你的域名${MCP_PATH}`);
});

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { z } from "zod";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO; // 格式: "你的用戶名/repo名"

const app = express();
const server = new McpServer({ name: "obsidian-mcp", version: "1.0.0" });

// 工具1: 搜索筆記文件名
server.tool(
  "search_notes",
  "搜索octo的Obsidian筆記，按文件名或路徑關鍵詞查找",
  { query: z.string().describe("搜索關鍵詞") },
  async ({ query }) => {
    const res = await fetch(
      `https://api.github.com/search/code?q=${encodeURIComponent(query)}+repo:${GITHUB_REPO}`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" } }
    );
    const data = await res.json();
    const files = (data.items || []).slice(0, 10).map(i => i.path);
    return { content: [{ type: "text", text: files.length ? files.join("\n") : "沒找到相關筆記" }] };
  }
);

// 工具2: 讀取特定筆記內容
server.tool(
  "read_note",
  "讀取octo的一篇Obsidian筆記的完整內容",
  { path: z.string().describe("文件路徑，例如 日記/2026-03-07.md") },
  async ({ path }) => {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${encodeURIComponent(path)}`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" } }
    );
    const data = await res.json();
    if (data.content) {
      const text = Buffer.from(data.content, "base64").toString("utf-8");
      return { content: [{ type: "text", text }] };
    }
    return { content: [{ type: "text", text: "找不到這個文件：" + path }] };
  }
);

// 工具3: 列出某個資料夾下的所有文件
server.tool(
  "list_notes",
  "列出octo的Obsidian某個資料夾下的所有筆記",
  { folder: z.string().describe("資料夾路徑，根目錄就填空字串").default("") },
  async ({ folder }) => {
    const url = folder
      ? `https://api.github.com/repos/${GITHUB_REPO}/contents/${encodeURIComponent(folder)}`
      : `https://api.github.com/repos/${GITHUB_REPO}/contents/`;
    const res = await fetch(url, {
      headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" }
    });
    const data = await res.json();
    if (Array.isArray(data)) {
      const list = data.map(i => `${i.type === "dir" ? "📁" : "📄"} ${i.path}`);
      return { content: [{ type: "text", text: list.join("\n") }] };
    }
    return { content: [{ type: "text", text: "找不到這個資料夾" }] };
  }
);

// SSE transport
let transport;
app.get("/sse", async (req, res) => {
  transport = new SSEServerTransport("/messages", res);
  await server.connect(transport);
});
app.post("/messages", async (req, res) => {
  if (transport) await transport.handlePostMessage(req, res);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Obsidian MCP server running on port ${PORT}`));

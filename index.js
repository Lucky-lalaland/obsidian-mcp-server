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
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${path.split("/").map(p => encodeURIComponent(p)).join("/")}`,
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

// 工具4: 寫入/更新筆記
server.tool(
  "sync_note",
  "把内容同步到octo的Obsidian指定路徑，支援markdown格式",
  {
    path: z.string().describe("文件路徑，例如 for veran/小克的信.md"),
    content: z.string().describe("筆記內容，支持markdown格式"),
    message: z.string().describe("提交說明").default("veran was here")
  },
  async ({ path, content, message }) => {
    // 先檢查文件是否已存在（更新需要sha）
    let sha;
    try {
      const check = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/contents/${path.split("/").map(p => encodeURIComponent(p)).join("/")}`,
        { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" } }
      );
      if (check.ok) {
        const existing = await check.json();
        sha = existing.sha;
      }
    } catch (e) {}

    const body = {
      message: message || "veran was here",
      content: Buffer.from(content, "utf-8").toString("base64"),
    };
    if (sha) body.sha = sha;

    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${path.split("/").map(p => encodeURIComponent(p)).join("/")}`,
      {
        method: "PUT",
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      }
    );

    if (res.ok) {
      return { content: [{ type: "text", text: sha ? `已更新：${path}` : `已新建：${path}` }] };
    } else {
      const err = await res.json();
      return { content: [{ type: "text", text: `寫入失敗：${JSON.stringify(err)}` }] };
    }
  }
);

// 工具5: 列出一篇筆記裡的所有標題
server.tool(
  "list_headings",
  "列出一篇筆記裡的所有標題，用來預覽結構",
  { path: z.string().describe("文件路徑") },
  async ({ path }) => {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${path.split("/").map(p => encodeURIComponent(p)).join("/")}`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" } }
    );
    const data = await res.json();
    if (!data.content) return { content: [{ type: "text", text: "找不到文件：" + path }] };
    
    const text = Buffer.from(data.content, "base64").toString("utf-8");
    const headings = text.split("\n")
      .filter(line => /^#{1,6}\s/.test(line))
      .map(line => line.trim());
    
    return { content: [{ type: "text", text: headings.length ? headings.join("\n") : "這篇筆記沒有標題" }] };
  }
);

// 工具6: 讀取特定標題下的段落
server.tool(
  "read_section",
  "只讀取筆記裡某個標題下的內容，節省token",
  {
    path: z.string().describe("文件路徑"),
    heading: z.string().describe("要讀取的標題關鍵詞，例如 0307")
  },
  async ({ path, heading }) => {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${path.split("/").map(p => encodeURIComponent(p)).join("/")}`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" } }
    );
    const data = await res.json();
    if (!data.content) return { content: [{ type: "text", text: "找不到文件：" + path }] };
    
    const text = Buffer.from(data.content, "base64").toString("utf-8");
    const lines = text.split("\n");
    
    let capturing = false;
    let captureLevel = 0;
    let result = [];
    
    for (const line of lines) {
      const headingMatch = line.match(/^(#{1,6})\s+(.*)/);
      
      if (headingMatch) {
        if (capturing) {
          // 遇到同級或更高級標題就停
          if (headingMatch[1].length <= captureLevel) break;
        }
        if (headingMatch[2].includes(heading)) {
          capturing = true;
          captureLevel = headingMatch[1].length;
          result.push(line);
          continue;
        }
      }
      
      if (capturing) result.push(line);
    }
    
    return { content: [{ type: "text", text: result.length ? result.join("\n") : "找不到包含「" + heading + "」的段落" }] };
  }
);

// 工具: 追加內容到筆記末尾
server.tool(
  "enrich_note",
  "在一篇筆記的末尾追加內容，不需要讀取原文",
  {
    path: z.string().describe("文件路徑"),
    content: z.string().describe("要追加的內容"),
    message: z.string().optional().describe("提交說明").default("veran was here")
  },
  async ({ path, content, message }) => {
    const filePath = path.split("/").map(p => encodeURIComponent(p)).join("/");
    
    // 服務端拉現有內容（不經過Claude，不耗token）
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" } }
    );
    
    let existing = "";
    let sha;
    
    if (res.ok) {
      const data = await res.json();
      existing = Buffer.from(data.content, "base64").toString("utf-8");
      sha = data.sha;
    }
    
    const newContent = existing + "\n\n" + content;
    const body = {
      message: message || "veran was here",
      content: Buffer.from(newContent, "utf-8").toString("base64"),
    };
    if (sha) body.sha = sha;
    
    const putRes = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`,
      {
        method: "PUT",
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      }
    );
    
    if (putRes.ok) {
      return { content: [{ type: "text", text: `已追加到：${path}` }] };
    } else {
      const err = await putRes.json();
      return { content: [{ type: "text", text: `追加失敗：${JSON.stringify(err)}` }] };
    }
  }
);

// 通用 GitHub 讀取：列出 repo 裡的文件
server.tool(
  "github_list_files",
  "列出任意GitHub repo裡的文件結構",
  {
    repo: z.string().describe("倉庫全名，例如 octo/my-project"),
    path: z.string().describe("資料夾路徑，根目錄填空字串").default("")
  },
  async ({ repo, path }) => {
    const filePath = path ? path.split("/").map(p => encodeURIComponent(p)).join("/") : "";
    const res = await fetch(
      `https://api.github.com/repos/${repo}/contents/${filePath}`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" } }
    );
    if (!res.ok) return { content: [{ type: "text", text: "讀取失敗" }] };
    const data = await res.json();
    const list = Array.isArray(data) 
      ? data.map(f => `${f.type === "dir" ? "📁" : "📄"} ${f.path}`).join("\n")
      : `📄 ${data.path}`;
    return { content: [{ type: "text", text: list }] };
  }
);

// 通用 GitHub 讀取：讀一個文件的內容
server.tool(
  "github_read_file",
  "讀取任意GitHub repo裡的一個文件",
  {
    repo: z.string().describe("倉庫全名，例如 octo/my-project"),
    path: z.string().describe("文件路徑")
  },
  async ({ repo, path }) => {
    const filePath = path.split("/").map(p => encodeURIComponent(p)).join("/");
    const res = await fetch(
      `https://api.github.com/repos/${repo}/contents/${filePath}`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" } }
    );
    if (!res.ok) return { content: [{ type: "text", text: "找不到：" + path }] };
    const data = await res.json();
    const content = Buffer.from(data.content, "base64").toString("utf-8");
    return { content: [{ type: "text", text: content }] };
  }
);

// 通用 GitHub 寫入
server.tool(
  "github_write_file",
  "寫入或更新任意GitHub repo裡的文件",
  {
    repo: z.string().describe("倉庫全名，例如 octo/my-project"),
    path: z.string().describe("文件路徑"),
    content: z.string().describe("文件內容"),
    message: z.string().describe("commit message").default("veran was here")
  },
  async ({ repo, path, content, message }) => {
    const filePath = path.split("/").map(p => encodeURIComponent(p)).join("/");
    
    // 先檢查文件是否已存在（需要 sha 才能更新）
    const res = await fetch(
      `https://api.github.com/repos/${repo}/contents/${filePath}`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" } }
    );
    
    const body = {
      message: message || "veran was here",
      content: Buffer.from(content, "utf-8").toString("base64"),
    };
    
    if (res.ok) {
      const data = await res.json();
      body.sha = data.sha;
    }
    
    const putRes = await fetch(
      `https://api.github.com/repos/${repo}/contents/${filePath}`,
      {
        method: "PUT",
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      }
    );
    
    if (putRes.ok) {
      return { content: [{ type: "text", text: `已寫入：${repo}/${path}` }] };
    } else {
      const err = await putRes.json();
      return { content: [{ type: "text", text: `寫入失敗：${JSON.stringify(err)}` }] };
    }
  }
);

// 精準修改：搜索替換
server.tool(
  "github_patch_file",
  "精準修改GitHub repo裡的文件內容，用搜索替換的方式",
  {
    repo: z.string().describe("倉庫全名，例如 octo/my-project"),
    path: z.string().describe("文件路徑"),
    search: z.string().describe("要找的原始內容（精確匹配）"),
    replace: z.string().describe("替換成的新內容"),
    message: z.string().describe("commit message").default("veran patched")
  },
  async ({ repo, path, search, replace, message }) => {
    const filePath = path.split("/").map(p => encodeURIComponent(p)).join("/");
    
    const res = await fetch(
      `https://api.github.com/repos/${repo}/contents/${filePath}`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" } }
    );
    
    if (!res.ok) return { content: [{ type: "text", text: "找不到：" + path }] };
    
    const data = await res.json();
    const original = Buffer.from(data.content, "base64").toString("utf-8");
    
    if (!original.includes(search)) {
      return { content: [{ type: "text", text: "找不到要替換的內容，請確認 search 字串是否正確" }] };
    }
    
    const updated = original.replace(search, replace);
    
    const putRes = await fetch(
      `https://api.github.com/repos/${repo}/contents/${filePath}`,
      {
        method: "PUT",
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          message: message || "veran patched",
          content: Buffer.from(updated, "utf-8").toString("base64"),
          sha: data.sha
        })
      }
    );
    
    if (putRes.ok) {
      return { content: [{ type: "text", text: `已修改：${repo}/${path}` }] };
    } else {
      const err = await putRes.json();
      return { content: [{ type: "text", text: `修改失敗：${JSON.stringify(err)}` }] };
    }
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

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { z } from "zod";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;

const app = express();
const server = new McpServer({ name: "obsidian-mcp", version: "1.1.0" });

// ═══ 輔助函數 ═══
function encodePath(p) {
  return p.split("/").map(s => encodeURIComponent(s)).join("/");
}
function ghHeaders() {
  return { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" };
}
function ok(text) {
  return { content: [{ type: "text", text }] };
}

// ═══ Obsidian 筆記工具 ═══

server.tool(
  "search_notes",
  "搜索octo的Obsidian筆記，按文件名或路徑關鍵詞查找",
  { query: z.string().describe("搜索關鍵詞") },
  async ({ query }) => {
    const res = await fetch(
      `https://api.github.com/search/code?q=${encodeURIComponent(query)}+repo:${GITHUB_REPO}`,
      { headers: ghHeaders() }
    );
    const data = await res.json();
    const files = (data.items || []).slice(0, 10).map(i => i.path);
    return ok(files.length ? files.join("\n") : "沒找到相關筆記");
  }
);

server.tool(
  "read_note",
  "讀取octo的一篇Obsidian筆記的完整內容",
  { path: z.string().describe("文件路徑，例如 日記/2026-03-07.md") },
  async ({ path }) => {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${encodePath(path)}`,
      { headers: ghHeaders() }
    );
    const data = await res.json();
    if (data.content) return ok(Buffer.from(data.content, "base64").toString("utf-8"));
    return ok("找不到這個文件：" + path);
  }
);

server.tool(
  "list_notes",
  "列出octo的Obsidian某個資料夾下的所有筆記",
  { folder: z.string().describe("資料夾路徑，根目錄就填空字串").default("") },
  async ({ folder }) => {
    const url = folder
      ? `https://api.github.com/repos/${GITHUB_REPO}/contents/${encodeURIComponent(folder)}`
      : `https://api.github.com/repos/${GITHUB_REPO}/contents/`;
    const res = await fetch(url, { headers: ghHeaders() });
    const data = await res.json();
    if (Array.isArray(data)) {
      return ok(data.map(i => `${i.type === "dir" ? "📁" : "📄"} ${i.path}`).join("\n"));
    }
    return ok("找不到這個資料夾");
  }
);

server.tool(
  "sync_note",
  "把内容同步到octo的Obsidian指定路徑，支援markdown格式",
  {
    path: z.string().describe("文件路徑，例如 for veran/小克的信.md"),
    content: z.string().describe("筆記內容，支持markdown格式"),
    message: z.string().describe("提交說明").default("veran was here")
  },
  async ({ path, content, message }) => {
    let sha;
    try {
      const check = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/contents/${encodePath(path)}`,
        { headers: ghHeaders() }
      );
      if (check.ok) sha = (await check.json()).sha;
    } catch (e) {}
    const body = { message: message || "veran was here", content: Buffer.from(content, "utf-8").toString("base64") };
    if (sha) body.sha = sha;
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${encodePath(path)}`,
      { method: "PUT", headers: { ...ghHeaders(), "Content-Type": "application/json" }, body: JSON.stringify(body) }
    );
    if (res.ok) return ok(sha ? `已更新：${path}` : `已新建：${path}`);
    return ok(`寫入失敗：${JSON.stringify(await res.json())}`);
  }
);

server.tool(
  "list_headings",
  "列出一篇筆記裡的所有標題,用來預覽結構",
  { path: z.string().describe("文件路徑") },
  async ({ path }) => {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${encodePath(path)}`,
      { headers: ghHeaders() }
    );
    const data = await res.json();
    if (!data.content) return ok("找不到文件：" + path);
    const text = Buffer.from(data.content, "base64").toString("utf-8");
    const headings = text.split("\n").filter(l => /^#{1,6}\s/.test(l)).map(l => l.trim());
    return ok(headings.length ? headings.join("\n") : "這篇筆記沒有標題");
  }
);

server.tool(
  "read_section",
  "只讀取筆記裡某個標題下的內容,節省token",
  {
    path: z.string().describe("文件路徑"),
    heading: z.string().describe("要讀取的標題關鍵詞，例如 0307")
  },
  async ({ path, heading }) => {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${encodePath(path)}`,
      { headers: ghHeaders() }
    );
    const data = await res.json();
    if (!data.content) return ok("找不到文件：" + path);
    const lines = Buffer.from(data.content, "base64").toString("utf-8").split("\n");
    let capturing = false, captureLevel = 0, result = [];
    for (const line of lines) {
      const m = line.match(/^(#{1,6})\s+(.*)/);
      if (m) {
        if (capturing && m[1].length <= captureLevel) break;
        if (m[2].includes(heading)) { capturing = true; captureLevel = m[1].length; result.push(line); continue; }
      }
      if (capturing) result.push(line);
    }
    return ok(result.length ? result.join("\n") : "找不到包含「" + heading + "」的段落");
  }
);

server.tool(
  "enrich_note",
  "在一篇筆記的末尾追加內容,不需要讀取原文",
  {
    path: z.string().describe("文件路徑"),
    content: z.string().describe("要追加的內容"),
    message: z.string().optional().describe("提交說明").default("veran was here")
  },
  async ({ path, content, message }) => {
    const fp = encodePath(path);
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${fp}`, { headers: ghHeaders() });
    let existing = "", sha;
    if (res.ok) { const d = await res.json(); existing = Buffer.from(d.content, "base64").toString("utf-8"); sha = d.sha; }
    const body = { message: message || "veran was here", content: Buffer.from(existing + "\n\n" + content, "utf-8").toString("base64") };
    if (sha) body.sha = sha;
    const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${fp}`,
      { method: "PUT", headers: { ...ghHeaders(), "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return ok(r.ok ? `已追加到：${path}` : `追加失敗：${JSON.stringify(await r.json())}`);
  }
);

// ═══ 通用 GitHub 工具 ═══

server.tool(
  "github_list_files",
  "列出任意GitHub repo裡的文件結構",
  {
    repo: z.string().describe("倉庫全名,例如 octo/my-project"),
    path: z.string().describe("資料夾路徑,根目錄填空字串").default("")
  },
  async ({ repo, path }) => {
    const fp = path ? encodePath(path) : "";
    const res = await fetch(`https://api.github.com/repos/${repo}/contents/${fp}`, { headers: ghHeaders() });
    if (!res.ok) return ok("讀取失敗");
    const data = await res.json();
    return ok(Array.isArray(data) ? data.map(f => `${f.type === "dir" ? "📁" : "📄"} ${f.path}`).join("\n") : `📄 ${data.path}`);
  }
);

server.tool(
  "github_read_file",
  "讀取任意GitHub repo裡的一個文件",
  {
    repo: z.string().describe("倉庫全名,例如 octo/my-project"),
    path: z.string().describe("文件路徑")
  },
  async ({ repo, path }) => {
    const res = await fetch(`https://api.github.com/repos/${repo}/contents/${encodePath(path)}`, { headers: ghHeaders() });
    if (!res.ok) return ok("找不到：" + path);
    const data = await res.json();
    return ok(Buffer.from(data.content, "base64").toString("utf-8"));
  }
);

server.tool(
  "github_write_file",
  "寫入或更新任意GitHub repo裡的文件",
  {
    repo: z.string().describe("倉庫全名,例如 octo/my-project"),
    path: z.string().describe("文件路徑"),
    content: z.string().describe("文件內容"),
    message: z.string().describe("commit message").default("veran was here")
  },
  async ({ repo, path, content, message }) => {
    const fp = encodePath(path);
    const res = await fetch(`https://api.github.com/repos/${repo}/contents/${fp}`, { headers: ghHeaders() });
    const body = { message: message || "veran was here", content: Buffer.from(content, "utf-8").toString("base64") };
    if (res.ok) body.sha = (await res.json()).sha;
    const r = await fetch(`https://api.github.com/repos/${repo}/contents/${fp}`,
      { method: "PUT", headers: { ...ghHeaders(), "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return ok(r.ok ? `已寫入：${repo}/${path}` : `寫入失敗：${JSON.stringify(await r.json())}`);
  }
);

server.tool(
  "github_patch_file",
  "精準修改GitHub repo裡的文件內容,用搜索替換的方式",
  {
    repo: z.string().describe("倉庫全名,例如 octo/my-project"),
    path: z.string().describe("文件路徑"),
    search: z.string().describe("要找的原始內容（精確匹配）"),
    replace: z.string().describe("替換成的新內容"),
    message: z.string().describe("commit message").default("veran patched")
  },
  async ({ repo, path, search, replace, message }) => {
    const fp = encodePath(path);
    const res = await fetch(`https://api.github.com/repos/${repo}/contents/${fp}`, { headers: ghHeaders() });
    if (!res.ok) return ok("找不到：" + path);
    const data = await res.json();
    const original = Buffer.from(data.content, "base64").toString("utf-8");
    if (!original.includes(search)) return ok("找不到要替換的內容，請確認 search 字串是否正確");
    const updated = original.replace(search, replace);
    const r = await fetch(`https://api.github.com/repos/${repo}/contents/${fp}`,
      { method: "PUT", headers: { ...ghHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ message: message || "veran patched", content: Buffer.from(updated, "utf-8").toString("base64"), sha: data.sha }) });
    return ok(r.ok ? `已修改：${repo}/${path}` : `修改失敗：${JSON.stringify(await r.json())}`);
  }
);

// ═══ 新增：省 token 的精準讀取工具 ═══

server.tool(
  "github_read_lines",
  "只讀取文件的指定行範圍,或按關鍵詞搜索返回匹配行及上下文。比讀整個文件省很多token",
  {
    repo: z.string().describe("倉庫全名"),
    path: z.string().describe("文件路徑"),
    start_line: z.number().optional().describe("起始行號（從1開始）"),
    end_line: z.number().optional().describe("結束行號（包含）"),
    search: z.string().optional().describe("搜索關鍵詞，返回所有匹配行及上下文"),
    context: z.number().optional().describe("搜索時每個匹配的上下文行數,預設5").default(5)
  },
  async ({ repo, path, start_line, end_line, search, context = 5 }) => {
    const res = await fetch(`https://api.github.com/repos/${repo}/contents/${encodePath(path)}`, { headers: ghHeaders() });
    if (!res.ok) return ok("找不到：" + path);
    const data = await res.json();
    const text = Buffer.from(data.content, "base64").toString("utf-8");
    const lines = text.split("\n");

    // 模式1：行號範圍
    if (start_line != null) {
      const s = Math.max(1, start_line) - 1;
      const e = end_line != null ? Math.min(lines.length, end_line) : Math.min(s + 50, lines.length);
      const slice = lines.slice(s, e);
      const numbered = slice.map((l, i) => `${s + i + 1}\t${l}`);
      return ok(`[行 ${s+1}-${e}，共 ${lines.length} 行]\n\n${numbered.join("\n")}`);
    }

    // 模式2：關鍵詞搜索
    if (search) {
      const lower = search.toLowerCase();
      const matches = [];
      const seen = new Set();

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(lower)) {
          const from = Math.max(0, i - context);
          const to = Math.min(lines.length, i + context + 1);
          for (let j = from; j < to; j++) {
            if (!seen.has(j)) {
              seen.add(j);
              matches.push({ line: j + 1, text: lines[j], isMatch: j === i });
            }
          }
          // 加分隔線
          matches.push({ separator: true });
        }
      }

      if (!matches.length) return ok(`在 ${path} 中找不到「${search}」（共 ${lines.length} 行）`);

      const output = matches.map(m => {
        if (m.separator) return "---";
        const marker = m.isMatch ? " ◀" : "";
        return `${m.line}\t${m.text}${marker}`;
      }).join("\n");

      return ok(`[搜索「${search}」在 ${path}，共 ${lines.length} 行]\n\n${output}`);
    }

    // 既沒行號也沒搜索：返回文件概覽
    return ok(`${path}: ${lines.length} 行, ${text.length} 字元\n前10行預覽:\n${lines.slice(0, 10).map((l, i) => `${i+1}\t${l}`).join("\n")}\n...\n最後5行:\n${lines.slice(-5).map((l, i) => `${lines.length - 4 + i}\t${l}`).join("\n")}`);
  }
);

server.tool(
  "github_file_info",
  "快速查看文件的行數和大小,不返回內容,用來決定要不要讀整個文件",
  {
    repo: z.string().describe("倉庫全名"),
    path: z.string().describe("文件路徑")
  },
  async ({ repo, path }) => {
    const res = await fetch(`https://api.github.com/repos/${repo}/contents/${encodePath(path)}`, { headers: ghHeaders() });
    if (!res.ok) return ok("找不到：" + path);
    const data = await res.json();
    const text = Buffer.from(data.content, "base64").toString("utf-8");
    const lines = text.split("\n");
    // 提取函數/組件名作為結構預覽
    const structure = lines
      .map((l, i) => ({ line: i + 1, text: l }))
      .filter(({ text }) => /^(function |const |let |var |class |\/\/ ═|\/\/ 工具|server\.tool|\.tool\()/.test(text.trim()))
      .map(({ line, text }) => `${line}\t${text.trim().substring(0, 80)}`)
      .join("\n");
    return ok(`📄 ${path}\n行數: ${lines.length}\n大小: ${text.length} 字元 (≈${Math.round(text.length/3)} tokens)\n\n結構預覽:\n${structure}`);
  }
);

// ═══ 通用 HTTP 請求工具 ═══

server.tool(
  "http_request",
  "發送HTTP請求到任意URL，支持GET/POST/PUT/DELETE，可帶自定義headers和JSON body。用於調用外部API、瀏覽網頁等",
  {
    method: z.enum(["GET", "POST", "PUT", "DELETE"]).describe("HTTP方法"),
    url: z.string().describe("完整的URL"),
    headers: z.record(z.string()).optional().describe("自定義請求頭，例如 Authorization"),
    body: z.any().optional().describe("請求體，POST/PUT時使用，會自動JSON序列化")
  },
  async ({ method, url, headers = {}, body }) => {
    const options = {
      method,
      headers: { "Content-Type": "application/json", ...headers }
    };
    if (body && (method === "POST" || method === "PUT")) {
      options.body = typeof body === "string" ? body : JSON.stringify(body);
    }
    try {
      const res = await fetch(url, options);
      const ct = res.headers.get("content-type") || "";
      let data;
      if (ct.includes("application/json")) {
        data = JSON.stringify(await res.json(), null, 2);
      } else {
        data = await res.text();
        if (data.length > 10000) data = data.substring(0, 10000) + "\n\n... [已截斷]";
      }
      return ok(`HTTP ${res.status} ${res.statusText}\n\n${data}`);
    } catch (e) {
      return ok(`請求失敗: ${e.message}`);
    }
  }
);

// ═══ SSE transport ═══
let transport;
app.get("/sse", async (req, res) => {
  transport = new SSEServerTransport("/messages", res);
  await server.connect(transport);
});
app.post("/messages", async (req, res) => {
  if (transport) await transport.handlePostMessage(req, res);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Obsidian MCP server v1.1.0 running on port ${PORT}`));

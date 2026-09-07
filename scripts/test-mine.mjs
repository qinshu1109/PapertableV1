import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

const dbPath = join(homedir(), "Library", "Application Support", "memos", "memos_prod.db");
const db = new DatabaseSync(dbPath, { readOnly: true });

const rows = db.prepare(`
  SELECT id, uid, content, created_ts 
  FROM memo 
  WHERE row_status = 'NORMAL' 
  ORDER BY created_ts DESC
`).all();

console.log("Total normal memos:", rows.length);

const isSecret = (text) => {
  return /(@gmail\.com|@163\.com|2fa|秘钥|password|grok密码|反重力账号|拉黑的用户ID|oouf pnj7|sk-[a-zA-Z0-9]{20,})/i.test(text);
};

const TOPIC_RULES = [
  {
    key: "deepseek/504-timeout",
    section: "deepseek",
    keywords: ["deepseek", "504", "超时重试"],
    title: "DeepSeek-V3 API 504 超时与重试"
  },
  {
    key: "gemini/429-rate-limit",
    section: "gemini",
    keywords: ["gemini", "429", "切端点"],
    title: "Gemini 429 报错与动态切端点"
  },
  {
    key: "grok/ttl-token-renewal",
    section: "grok",
    keywords: ["grok", "破限", "ttl续传", "iqbench"],
    title: "Grok 破限、TTL 续传与降智检测"
  },
  {
    key: "feishu-cli/personal-workbench",
    section: "feishu",
    keywords: ["飞书 cli", "飞书cli", "多维表格选题", "工作台项目"],
    title: "飞书 CLI 个人选题工作台方案"
  },
  {
    key: "git/repo-hygiene",
    section: "git",
    keywords: ["项目合并", "清理历史仓库", "混淆各种版本的仓库"],
    title: "多仓库合并与 AI 上下文混淆清理"
  },
  {
    key: "codex/upstream-compatibility",
    section: "codex",
    keywords: ["codex", "linux.do", "上游的问题"],
    title: "Codex 安装排障与上游版本兼容"
  },
  {
    key: "deepseek-harness/plugin-dev",
    section: "dsh",
    keywords: ["deepseek harness", "dsh-webui", "dsh还能做个弹窗", "dsh手机端"],
    title: "DeepSeek Harness 会话增强与插件生态"
  },
  {
    key: "api-gateway/cache-multiplexing",
    section: "gateway",
    keywords: ["wawapii", "mouubox", "radeon/api", "mosshubs", "倍率", "模型中转", "sub.ai"],
    title: "AI API 网关缓存复用与倍率对账"
  },
  {
    key: "agent-skill/reverse-engineering",
    section: "skills",
    keywords: ["逆向工程skill", "逆向工程", "j-space", "焚决"],
    title: "逆向工程 Skill 与 J-Space 深度认知"
  },
  {
    key: "content-strategy/tech-media-anchor",
    section: "strategy",
    keywords: ["自媒体", "0→1", "一个锚点", "普通的东西吹的很厉害"],
    title: "自媒体 0→1 节奏与单一锚点策略"
  },
  {
    key: "knowledge-mgmt/memos-automation",
    section: "knowledge",
    keywords: ["笔记项目应该后台自动化", "热记忆", "知识管理"],
    title: "Memos 本地笔记后台自动化与热记忆降级"
  },
  {
    key: "llm-latency/first-token-dual-turn",
    section: "llm",
    keywords: ["首token", "极简模式", "双轮次方案", "提示词污染"],
    title: "首 Token 极简模式双轮次加速与提示词防污染"
  },
  {
    key: "hardware/lexar-ssd-ro-failure",
    section: "hardware",
    keywords: ["雷克沙", "nq790", "固态硬盘出现故障", "只读"],
    title: "雷克沙 NQ790 固态硬盘写保护故障复盘"
  },
  {
    key: "gpt/tool-call-plan-fallback",
    section: "gpt",
    keywords: ["调用不了工具", "切成plan模式", "plan模式"],
    title: "模型工具调用失败时 Plan 模式回退"
  },
  {
    key: "kimi/pptx-generator",
    section: "kimi",
    keywords: ["kimik3", "ppt", "cozai.net", "5.6破甲提示词"],
    title: "Kimi K3 PPT 自动化生成与提示词破甲"
  }
];

const mapped = new Map();
for (const rule of TOPIC_RULES) {
  mapped.set(rule.key, []);
}

let secretCount = 0;
let validCount = 0;
const seenSnippets = new Set();

for (const row of rows) {
  if (isSecret(row.content)) {
    secretCount++;
    continue;
  }
  const clean = row.content.trim();
  if (clean.length < 12) continue;

  const snippet = clean.slice(0, 45).replace(/\s+/g, " ");
  if (seenSnippets.has(snippet)) continue;
  seenSnippets.add(snippet);

  const lower = clean.toLowerCase();
  for (const rule of TOPIC_RULES) {
    if (rule.keywords.some((kw) => lower.includes(kw))) {
      mapped.get(rule.key).push({
        id: row.id,
        uid: row.uid,
        content: clean,
        cts: row.created_ts,
        date: new Date(row.created_ts * 1000).toISOString()
      });
      validCount++;
      break;
    }
  }
}

console.log("Filtered secrets:", secretCount);
console.log("Matched tech notes:", validCount);
for (const [key, items] of mapped.entries()) {
  console.log(`- ${key}: ${items.length} 条速记`);
}

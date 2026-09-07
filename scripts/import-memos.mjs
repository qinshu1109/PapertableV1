import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

const BASE_TOKEN = "AIyIb85mRap2FQsFLGsctofDnnb";
const TOPICS_TABLE = "tblKFBlzpJa0KOPD";
const NOTES_TABLE = "tbly1F7MfZriOiVy";

// Load Memos database
const dbPath = join(homedir(), "Library", "Application Support", "memos", "memos_prod.db");
const db = new DatabaseSync(dbPath, { readOnly: true });

const rows = db.prepare(`
  SELECT id, uid, content, created_ts 
  FROM memo 
  WHERE row_status = 'NORMAL' 
  ORDER BY created_ts DESC
`).all();

const isSecret = (text) => {
  return /(@gmail\.com|@163\.com|2fa|秘钥|password|grok密码|反重力账号|拉黑的用户ID|oouf pnj7|sk-[a-zA-Z0-9]{20,})/i.test(text);
};

const TOPIC_RULES = [
  {
    key: "deepseek/504-timeout",
    section: "deepseek",
    keywords: ["deepseek", "504", "超时重试"],
    title: "DeepSeek-V3 API 504 超时与重试",
    hook: "API 遇到 504 超时别急着重试，分级重试与退避策略实测"
  },
  {
    key: "gemini/429-rate-limit",
    section: "gemini",
    keywords: ["gemini", "429", "切端点"],
    title: "Gemini 429 报错与动态切端点",
    hook: "Gemini 3.8 Flash 频繁 429？做动态多端点软切换与负载自愈"
  },
  {
    key: "grok/ttl-token-renewal",
    section: "grok",
    keywords: ["grok", "破限", "ttl续传", "iqbench"],
    title: "Grok 破限、TTL 续传与降智检测",
    hook: "Grok 逆向与 TTL 续传实测：小服务器如何扛住流式长上下文"
  },
  {
    key: "feishu-cli/personal-workbench",
    section: "feishu",
    keywords: ["飞书 cli", "飞书cli", "多维表格选题", "工作台项目"],
    title: "飞书 CLI 个人选题工作台方案",
    hook: "为什么飞书 CLI 才是单人技术内容流水线的最优解"
  },
  {
    key: "git/repo-hygiene",
    section: "git",
    keywords: ["项目合并", "清理历史仓库", "混淆各种版本的仓库"],
    title: "多仓库合并与 AI 上下文混淆清理",
    hook: "项目合并后不清理历史仓库的惨痛教训：AI 上下文直接疯掉"
  },
  {
    key: "codex/upstream-compatibility",
    section: "codex",
    keywords: ["codex", "linux.do", "上游的问题"],
    title: "Codex 安装排障与上游版本兼容",
    hook: "Codex 上游更新频繁踩坑：从 Linux.do 方案到环境固定"
  },
  {
    key: "deepseek-harness/plugin-dev",
    section: "dsh",
    keywords: ["deepseek harness", "dsh-webui", "dsh还能做个弹窗", "dsh手机端"],
    title: "DeepSeek Harness 会话增强与插件生态",
    hook: "DeepSeek Harness 插件开发实战：打造全功能本地会话增强"
  },
  {
    key: "api-gateway/cache-multiplexing",
    section: "gateway",
    keywords: ["wawapii", "mouubox", "radeon/api", "mosshubs", "倍率", "模型中转", "sub.ai"],
    title: "AI API 网关缓存复用与倍率对账",
    hook: "多中转网关实测：Prompt 缓存与真实倍率对账防反撸指南"
  },
  {
    key: "agent-skill/reverse-engineering",
    section: "skills",
    keywords: ["逆向工程skill", "逆向工程", "j-space", "焚决"],
    title: "逆向工程 Skill 与 J-Space 深度认知",
    hook: "构建模型深度认知空间：从逆向工程到 J-Space 思维闭环"
  },
  {
    key: "content-strategy/tech-media-anchor",
    section: "strategy",
    keywords: ["自媒体", "0→1", "一个锚点", "普通的东西吹的很厉害"],
    title: "自媒体 0→1 节奏与单一锚点策略",
    hook: "单人技术自媒体 0 到 1：每天一个锚点与两个书签的工作流"
  },
  {
    key: "knowledge-mgmt/memos-automation",
    section: "knowledge",
    keywords: ["笔记项目应该后台自动化", "热记忆", "知识管理"],
    title: "Memos 本地笔记后台自动化与热记忆降级",
    hook: "从 Memos 到 MemOS：构建零手工维护的本地技术记忆网"
  },
  {
    key: "llm-latency/first-token-dual-turn",
    section: "llm",
    keywords: ["首token", "极简模式", "双轮次方案", "提示词污染"],
    title: "首 Token 极简模式双轮次加速与提示词防污染",
    hook: "首 Token 延迟腰斩技巧：极简模式双轮次与系统提示词隔离"
  },
  {
    key: "hardware/lexar-ssd-ro-failure",
    section: "hardware",
    keywords: ["雷克沙", "nq790", "固态硬盘出现故障", "只读"],
    title: "雷克沙 NQ790 固态硬盘写保护故障复盘",
    hook: "雷克沙 SSD 突发只读锁定：主控安全机制与跨系统救砖实录"
  },
  {
    key: "gpt/tool-call-plan-fallback",
    section: "gpt",
    keywords: ["调用不了工具", "切成plan模式", "plan模式"],
    title: "模型工具调用失败时 Plan 模式回退",
    hook: "大模型工具调用偶尔卡死？Plan 模式回退解决玄学失败"
  },
  {
    key: "kimi/pptx-generator",
    section: "kimi",
    keywords: ["kimik3", "ppt", "cozai.net", "5.6破甲提示词"],
    title: "Kimi K3 PPT 自动化生成与提示词破甲",
    hook: "基于 Kimi K3 快速生成工业级 PPT：提示词工程与版式渲染"
  }
];

function inferNoteType(content) {
  if (/报错|错误|504|429|502|超时|故障|崩溃|混淆|不兼容/.test(content)) return "踩坑";
  if (/规划|0→1|锚点|书签|节奏/.test(content)) return "规划";
  if (/skill|工具|插件|webui|cli|memos|gateway|sub2api/i.test(content)) return "工具";
  if (/灵感|点子|想法|设计/.test(content)) return "灵感";
  return "复盘";
}

// 1. Get existing topics
console.log("=== 1. 读取主题体现状 ===");
const listTopicsCmd = `npx @larksuite/cli base +record-list --base-token ${BASE_TOKEN} --table-id ${TOPICS_TABLE} --format json`;
const existingTopicsRaw = JSON.parse(execSync(listTopicsCmd, { encoding: "utf8" }));
const existingTopics = new Map();
if (existingTopicsRaw.ok && existingTopicsRaw.data && existingTopicsRaw.data.data) {
  const fields = existingTopicsRaw.data.fields;
  const keyIdx = fields.indexOf("主题键");
  const recIds = existingTopicsRaw.data.record_id_list;
  for (let i = 0; i < existingTopicsRaw.data.data.length; i++) {
    const row = existingTopicsRaw.data.data[i];
    const key = row[keyIdx];
    if (key) {
      existingTopics.set(key, recIds[i]);
    }
  }
}
console.log("已有主题:", Array.from(existingTopics.keys()));

// 2. Create missing topics
console.log("=== 2. 创建或补全主题 ===");
const topicsToCreate = [];
for (const rule of TOPIC_RULES) {
  if (!existingTopics.has(rule.key)) {
    topicsToCreate.push({
      "主题键": rule.key,
      "状态": ["观察"],
      "一句话钩子": rule.hook
    });
  }
}

if (topicsToCreate.length > 0) {
  console.log(`正在创建 ${topicsToCreate.length} 个新主题...`);
  const createCmd = `npx @larksuite/cli base +record-batch-create --base-token ${BASE_TOKEN} --table-id ${TOPICS_TABLE} --json '${JSON.stringify({ create_records: topicsToCreate }).replace(/'/g, "'\\''")}' --format json`;
  const res = JSON.parse(execSync(createCmd, { encoding: "utf8" }));
  if (res.ok && res.data && res.data.record_id_list) {
    for (let i = 0; i < topicsToCreate.length; i++) {
      existingTopics.set(topicsToCreate[i]["主题键"], res.data.record_id_list[i]);
      console.log(`+ 新建主题: ${topicsToCreate[i]["主题键"]} (${res.data.record_id_list[i]})`);
    }
  }
}

// 3. Collect notes to import
console.log("=== 3. 从 Memos 采掘速记并关联主题 ===");
const notesToCreate = [];
const seenSnippets = new Set();

for (const row of rows) {
  if (isSecret(row.content)) continue;
  const clean = row.content.trim();
  if (clean.length < 12) continue;

  const snippet = clean.slice(0, 45).replace(/\s+/g, " ");
  if (seenSnippets.has(snippet)) continue;
  seenSnippets.add(snippet);

  const lower = clean.toLowerCase();
  for (const rule of TOPIC_RULES) {
    if (rule.keywords.some((kw) => lower.includes(kw))) {
      const topicRecId = existingTopics.get(rule.key);
      if (!topicRecId) continue;
      
      const noteType = inferNoteType(clean);
      notesToCreate.push({
        "原文": clean,
        "主题键": rule.key,
        "主题": [{ id: topicRecId }],
        "时间": row.created_ts * 1000,
        "Memos": `memos/${row.uid}`,
        "类型": [noteType]
      });
      break;
    }
  }
}

console.log(`准备写入速记记录数: ${notesToCreate.length}`);

// 4. Batch create notes in batches of 40
for (let i = 0; i < notesToCreate.length; i += 40) {
  const batch = notesToCreate.slice(i, i + 40);
  console.log(`正在写入速记批次 ${i + 1} ~ ${i + batch.length}...`);
  const batchJson = JSON.stringify({ create_records: batch });
  const batchCmd = `npx @larksuite/cli base +record-batch-create --base-token ${BASE_TOKEN} --table-id ${NOTES_TABLE} --json '${batchJson.replace(/'/g, "'\\''")}' --format json`;
  const res = JSON.parse(execSync(batchCmd, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }));
  if (res.ok) {
    console.log(`批次 ${i + 1} ~ ${i + batch.length} 写入成功！`);
  } else {
    console.error("写入失败:", res);
  }
}

console.log("=== 全部速记与主题入库完成！===");

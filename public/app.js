const state = {
  project: null,
  card: null,
  activeRunId: null,
  eventSource: null,
  selection: null,
  rerouteEntryId: null,
  promotion: null,
};

const $ = (selector) => document.querySelector(selector);

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

async function boot() {
  bindUi();
  try {
    const status = await api("/api/status");
    $("#server-status").textContent = status.modelConfigured
      ? `已连接 · ${status.protocol}`
      : "服务已启动 · 模型环境变量未配置";
    $("#server-status").className = status.modelConfigured ? "ok" : "error";
  } catch (error) {
    showError(error);
  }
  await refreshProjects();
}

function bindUi() {
  $("#project-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const project = await api("/api/projects", { method: "POST", ...jsonOptions({ name: $("#project-name").value }) });
    $("#project-name").value = "";
    await refreshProjects();
    await openProject(project.id);
  });
  $("#library-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    await api(`/api/projects/${state.project.id}/library`, {
      method: "PUT",
      ...jsonOptions({ path: $("#library-path").value }),
    });
    await openProject(state.project.id);
  });
  $("#reindex-library").addEventListener("click", async () => {
    $("#library-status").textContent = "正在读取并重建索引…";
    try {
      const result = await api(`/api/projects/${state.project.id}/library/reindex`, { method: "POST" });
      $("#library-status").textContent = `完成：${result.documents} 份文件，${result.chunks} 个片段`;
      await openProject(state.project.id);
    } catch (error) {
      $("#library-status").textContent = error.message;
      $("#library-status").className = "error";
    }
  });
  const drop = $("#material-drop");
  drop.addEventListener("dragover", (event) => { event.preventDefault(); drop.classList.add("drag"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
  drop.addEventListener("drop", async (event) => {
    event.preventDefault();
    drop.classList.remove("drag");
    await uploadMaterials(event.dataTransfer.files);
  });
  $("#material-input").addEventListener("change", async (event) => uploadMaterials(event.target.files));
  $("#root-question-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const result = await api(`/api/projects/${state.project.id}/cards`, {
      method: "POST",
      ...jsonOptions({ question: $("#root-question").value }),
    });
    $("#root-question").value = "";
    await openProject(state.project.id);
    await openCard(result.cardId);
  });
  $("#followup-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const result = await api(`/api/cards/${state.card.id}/messages`, {
      method: "POST",
      ...jsonOptions({ question: $("#followup-question").value }),
    });
    $("#followup-question").value = "";
    watchRun(result.runId);
  });
  $("#abort-button").addEventListener("click", async () => {
    if (state.activeRunId) await api(`/api/runs/${state.activeRunId}/abort`, { method: "POST" });
  });
  $("#deep-button").addEventListener("click", deepDive);
  $("#diverge-button").addEventListener("click", diverge);
  $("#reroute-button").addEventListener("click", reroute);
  $("#promote-button").addEventListener("click", previewPromotion);
  $("#publish-button").addEventListener("click", publishPromotion);
  $("#universe-button").addEventListener("click", openUniverse);
  window.addEventListener("pagehide", () => stageCurrent("page_closed"));
}

async function refreshProjects() {
  const { projects } = await api("/api/projects");
  const list = $("#project-list");
  list.replaceChildren(...projects.map((project) => {
    const button = element("button", project.name);
    button.type = "button";
    button.title = `${project.cardCount} 张卡片 · ${project.materialCount} 份项目材料`;
    if (state.project?.id === project.id) button.classList.add("active");
    button.addEventListener("click", () => openProject(project.id));
    return button;
  }));
}

async function openProject(projectId) {
  if (state.project?.id && state.project.id !== projectId) await stageCurrent("project_switched");
  state.project = await api(`/api/projects/${projectId}`);
  state.card = null;
  state.selection = null;
  $("#empty-state").hidden = true;
  $("#workspace").hidden = false;
  $("#project-title").textContent = state.project.name;
  $("#memory-stage").textContent = state.project.pendingMemoryStages
    ? `${state.project.pendingMemoryStages} 个阶段等待 MemOS`
    : "MemOS 阶段已提交";
  renderSources();
  renderCards();
  clearConversation();
  await refreshProjects();
}

function renderSources() {
  const library = state.project.library;
  $("#library-path").value = library?.path || "";
  $("#library-status").className = "";
  $("#library-status").textContent = library
    ? library.indexedAt
      ? `已索引 ${library.documents} 份文件 / ${library.chunks} 个片段 · ${new Date(library.indexedAt).toLocaleString()}`
      : "路径已绑定，尚未索引"
    : "尚未绑定";
  const materialList = $("#material-list");
  materialList.replaceChildren(...state.project.materials.map((material) => {
    const row = element("div");
    row.className = "material-row";
    row.append(element("span", `${material.name} · ${formatBytes(material.bytes)}`));
    const remove = element("button", "删除");
    remove.type = "button";
    remove.addEventListener("click", async () => {
      if (!confirm(`从项目中删除 ${material.name}？原始笔记库不会受影响。`)) return;
      await api(`/api/projects/${state.project.id}/materials/${material.id}`, { method: "DELETE" });
      await openProject(state.project.id);
    });
    row.append(remove);
    return row;
  }));
}

async function uploadMaterials(files) {
  for (const file of files) {
    await api(`/api/projects/${state.project.id}/materials`, {
      method: "POST",
      headers: { "x-filename": encodeURIComponent(file.name), "content-type": "application/octet-stream" },
      body: file,
    });
  }
  await openProject(state.project.id);
}

function renderCards() {
  const cardsById = new Map(state.project.cards.map((card) => [card.id, card]));
  const children = new Map();
  for (const card of state.project.cards) {
    const parent = card.sourceCardId || "root";
    children.set(parent, [...(children.get(parent) || []), card]);
  }
  const nodes = [];
  function walk(parent, depth) {
    for (const card of children.get(parent) || []) {
      const button = element("button", `${relationMark(card.kind)} ${card.title}`);
      button.type = "button";
      button.className = "card-button";
      button.style.marginLeft = `${depth * 12}px`;
      if (state.card?.id === card.id) button.classList.add("active");
      button.addEventListener("click", () => openCard(card.id));
      nodes.push(button);
      walk(card.id, depth + 1);
    }
  }
  walk("root", 0);
  for (const card of state.project.cards) {
    if (!cardsById.has(card.sourceCardId) && card.sourceCardId) walk(card.sourceCardId, 0);
  }
  $("#card-tree").replaceChildren(...nodes);
}

async function openCard(cardId) {
  if (state.card?.id && state.card.id !== cardId) await stageCurrent("card_switched");
  state.card = await api(`/api/cards/${cardId}`);
  state.selection = null;
  state.rerouteEntryId = null;
  $("#card-title").textContent = state.card.title;
  $("#followup-form").hidden = false;
  $("#deep-button").disabled = !state.card.messages.some((message) => message.role === "assistant");
  $("#diverge-button").disabled = false;
  $("#reroute-button").disabled = !state.card.messages.some((message) => message.role === "user");
  $("#promote-button").disabled = true;
  $("#selection-status").textContent = "深挖：先划选一段回答文字。改道：先点击一条“你的问题”。";
  renderConversation();
  renderCards();
  const running = state.card.runs.find((run) => run.status === "running");
  if (running && state.activeRunId !== running.id) watchRun(running.id);
}

function clearConversation() {
  $("#card-title").textContent = "尚未选择";
  $("#messages").replaceChildren();
  $("#followup-form").hidden = true;
  $("#deep-button").disabled = true;
  $("#diverge-button").disabled = true;
  $("#reroute-button").disabled = true;
  $("#promote-button").disabled = true;
}

function renderConversation() {
  const completedRuns = state.card.runs.filter((run) => run.result === "completed");
  let assistantIndex = 0;
  const messageNodes = state.card.messages.map((message) => {
    const box = element("section");
    box.className = `message ${message.role}`;
    box.dataset.entryId = message.entryId;
    box.append(element("small", message.role === "user" ? "你的问题" : "Papertable"));
    const pre = element("pre", message.text);
    box.append(pre);
    if (message.role === "user") {
      box.addEventListener("click", () => {
        document.querySelectorAll(".message.user").forEach((node) => node.classList.remove("reroute-selected"));
        box.classList.add("reroute-selected");
        state.rerouteEntryId = message.entryId;
        $("#reroute-button").disabled = false;
        $("#selection-status").textContent = "已选择这个旧问题作为改道点。";
      });
    } else {
      const run = completedRuns[assistantIndex++];
      if (run) {
        pre.dataset.runId = run.id;
        pre.addEventListener("mouseup", () => captureSelection(pre, message.entryId, run.id));
        if (run.citations?.length) box.append(renderCitations(run.citations));
        const activity = renderActivityHistory(run.activity);
        if (activity) box.append(activity);
      }
    }
    return box;
  });
  const lastRun = state.card.runs.at(-1);
  if (lastRun && lastRun.status === "ended" && lastRun.result !== "completed") {
    const status = element("section");
    status.className = "message run-failure";
    status.append(
      element("small", "上一轮没有进入对话历史"),
      element(
        "pre",
        [
          `${lastRun.result} / ${lastRun.reason}`,
          lastRun.answer || "",
          lastRun.error || "",
        ].filter(Boolean).join("\n\n"),
      ),
    );
    if (["failed", "partial"].includes(lastRun.result)) {
      const retry = element("button", "重试最后问题");
      retry.type = "button";
      retry.addEventListener("click", async () => {
        retry.disabled = true;
        const result = await api(`/api/runs/${lastRun.id}/retry`, { method: "POST" });
        watchRun(result.runId);
      });
      status.append(retry);
    }
    const activity = renderActivityHistory(lastRun.activity);
    if (activity) status.append(activity);
    messageNodes.push(status);
  }
  $("#messages").replaceChildren(...messageNodes);
}

function renderCitations(citations) {
  const list = element("div");
  list.className = "citations";
  for (const citation of citations) {
    const button = element("button", `${citation.sourceKind === "library" ? "长期" : "项目"} · ${citation.path}#${citation.start}`);
    button.type = "button";
    button.addEventListener("click", () => {
      alert(`${citation.path}\n字符 ${citation.start}-${citation.end}\n\n${citation.excerpt}`);
    });
    list.append(button);
  }
  return list;
}

function captureSelection(pre, entryId, runId) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  if (!pre.contains(range.commonAncestorContainer)) return;
  const before = range.cloneRange();
  before.selectNodeContents(pre);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;
  const text = range.toString();
  state.selection = { entryId, runId, start, end: start + text.length, text };
  $("#deep-button").disabled = false;
  $("#promote-button").disabled = false;
  $("#selection-status").textContent = `已选中 ${text.length} 个字符。`;
}

async function deepDive() {
  if (!state.selection) {
    const message = "先在下方 Papertable 回答里按住鼠标划选一段文字，再点“深挖选区”。";
    $("#selection-status").textContent = message;
    alert(message);
    return;
  }
  const question = prompt("围绕这段选区，你要继续深挖什么？");
  if (!question?.trim()) return;
  const result = await api(`/api/cards/${state.card.id}/branches`, {
    method: "POST",
    ...jsonOptions({
      kind: "deep_dive",
      question,
      selection: {
        entryId: state.selection.entryId,
        text: state.selection.text,
        start: state.selection.start,
        end: state.selection.end,
      },
    }),
  });
  await openProject(state.project.id);
  await openCard(result.cardId);
}

async function diverge() {
  const topic = prompt("只继承哪个主题？", state.card.title);
  if (!topic?.trim()) return;
  const question = prompt("你想从这个主题发散问什么？", topic);
  if (!question?.trim()) return;
  const result = await api(`/api/cards/${state.card.id}/branches`, {
    method: "POST",
    ...jsonOptions({ kind: "diverge", topic, question }),
  });
  await openProject(state.project.id);
  await openCard(result.cardId);
}

async function reroute() {
  if (!state.rerouteEntryId) {
    const message = "先点击下方一条“你的问题”，再点“从旧问题改道”。";
    $("#selection-status").textContent = message;
    alert(message);
    return;
  }
  const question = prompt("把这个旧问题改成什么？");
  if (!question?.trim()) return;
  const result = await api(`/api/cards/${state.card.id}/branches`, {
    method: "POST",
    ...jsonOptions({ kind: "reroute", sourceEntryId: state.rerouteEntryId, question }),
  });
  await openProject(state.project.id);
  await openCard(result.cardId);
}

function watchRun(runId) {
  state.eventSource?.close();
  state.activeRunId = runId;
  $("#live-run").hidden = false;
  $("#live-answer").textContent = "";
  $("#activity-log").replaceChildren();
  $("#activity-log").dataset.turn = "0";
  $("#abort-button").hidden = false;
  $("#progress").textContent = "运行已创建，准备检索…";
  const source = new EventSource(`/api/runs/${runId}/events`);
  state.eventSource = source;
  source.addEventListener("run_created", (event) => {
    appendLiveActivity(JSON.parse(event.data));
  });
  source.addEventListener("turn_start", (event) => {
    appendLiveActivity(JSON.parse(event.data));
    $("#progress").textContent = "模型正在判断下一步…";
  });
  source.addEventListener("tool_start", (event) => {
    const data = JSON.parse(event.data);
    appendLiveActivity(data);
    $("#progress").textContent = data.tool === "search_notes" ? "正在搜索项目资料…" : "正在读取真实来源片段…";
  });
  source.addEventListener("tool_update", (event) => {
    appendLiveActivity(JSON.parse(event.data));
  });
  source.addEventListener("tool_end", (event) => {
    const data = JSON.parse(event.data);
    appendLiveActivity(data);
    $("#progress").textContent = data.isError
      ? `${data.tool} 被门禁拒绝，模型会收到明确错误`
      : `${data.tool} 完成`;
  });
  source.addEventListener("answer_sentence", (event) => {
    const data = JSON.parse(event.data);
    $("#live-answer").textContent = data.answer;
    $("#progress").textContent = "正文正在流式通过安全门…";
  });
  source.addEventListener("memory_stage_status", (event) => {
    const data = JSON.parse(event.data);
    $("#memory-stage").textContent = data.status === "submitted" ? "阶段已提交 MemOS" : "MemOS 暂不可用，阶段待重试";
  });
  source.addEventListener("run_end", async (event) => {
    const data = JSON.parse(event.data);
    appendLiveActivity(data);
    source.close();
    state.activeRunId = null;
    $("#abort-button").hidden = true;
    $("#progress").textContent = `${data.result} / ${data.reason}`;
    if (data.answer) $("#live-answer").textContent = data.answer;
    const projectId = state.project?.id;
    const cardId = state.card?.id;
    if (projectId) await openProject(projectId);
    if (cardId) await openCard(cardId);
    $("#live-run").hidden = true;
  });
  source.onerror = () => {
    $("#progress").textContent = "事件流断开，浏览器正在按 Last-Event-ID 重连…";
  };
}

function appendLiveActivity(event) {
  const list = $("#activity-log");
  let turn = Number(list.dataset.turn || 0);
  if (event.event === "turn_start") {
    turn += 1;
    list.dataset.turn = String(turn);
  }
  const text = activityText(event, turn);
  if (text) list.append(element("li", text));
}

function renderActivityHistory(events = []) {
  if (!events.length) return null;
  const details = element("details");
  details.className = "activity-history";
  const calls = events.filter((event) => event.event === "tool_start").length;
  details.append(element("summary", `工具记录 · ${calls} 次调用`));
  const list = element("ol");
  let turn = 0;
  for (const event of events) {
    if (event.event === "turn_start") turn += 1;
    const text = activityText(event, turn);
    if (text) list.append(element("li", text));
  }
  details.append(list);
  return details;
}

function activityText(event, turn) {
  const time = event.createdAt ? `${new Date(event.createdAt).toLocaleTimeString()} · ` : "";
  if (event.event === "run_created") {
    return `${time}冻结资料：长期 ${event.sourceCounts?.library || 0}，项目材料 ${event.sourceCounts?.projectMaterial || 0}`;
  }
  if (event.event === "turn_start") return `${time}第 ${turn} 轮开始`;
  if (event.event === "tool_start") {
    return event.tool === "search_notes"
      ? `${time}search_notes 开始 · 查询 ${event.queryLength || 0} 字`
      : `${time}${event.tool} 开始 · 请求 ${event.requestedChunks || 0} 个片段`;
  }
  if (event.event === "tool_update") {
    if (Number.isFinite(event.hitCount)) return `${time}${event.tool} 更新 · 命中 ${event.hitCount}`;
    if (Number.isFinite(event.readCount)) return `${time}${event.tool} 更新 · 已读 ${event.readCount}`;
    return null;
  }
  if (event.event === "tool_end") {
    const count = Number.isFinite(event.hitCount)
      ? ` · 命中 ${event.hitCount}`
      : Number.isFinite(event.readCount)
        ? ` · 实读 ${event.readCount}`
        : "";
    return `${time}${event.tool} ${event.isError ? "失败/被门禁拒绝" : "完成"}${count}`;
  }
  if (event.event === "run_end") return `${time}结束 · ${event.result} / ${event.reason}`;
  return null;
}

async function previewPromotion() {
  if (!state.selection) return;
  if (!confirm("确认这段选区是你自己的提炼，并要进入“保留 1%”预览流程？来源原文只会作为证据，不会冒充你的观点。")) {
    return;
  }
  const title = prompt("这 1% 内容要以什么概念标题保存？");
  if (!title?.trim()) return;
  const targetDefault = `10_活跃知识/概念/${title.replace(/[\\/:*?"<>|]/g, "-")}.md`;
  const targetPath = prompt("正式笔记目标路径", targetDefault);
  if (!targetPath?.trim()) return;
  $("#promote-button").disabled = true;
  try {
    const preview = await api("/api/promotions/preview", {
      method: "POST",
      ...jsonOptions({
        projectId: state.project.id,
        cardId: state.card.id,
        runId: state.selection.runId,
        selectedText: state.selection.text,
        start: state.selection.start,
        end: state.selection.end,
        title,
        targetPath,
        confirmedPersonalSynthesis: true,
      }),
    });
    state.promotion = preview;
    $("#promotion-meta").textContent = `${preview.targetPath} · ${preview.knowledgeId}`;
    $("#promotion-human").textContent = preview.human;
    $("#promotion-diff").textContent = preview.diff;
    $("#publish-status").textContent = "尚未发布。只有下面的按钮会执行正式写入。";
    $("#publish-button").disabled = false;
    $("#promotion-dialog").showModal();
  } finally {
    $("#promote-button").disabled = false;
  }
}

async function publishPromotion() {
  if (!state.promotion || !confirm(`确认把当前预览发布到 ${state.promotion.targetPath}？`)) return;
  $("#publish-button").disabled = true;
  $("#publish-status").textContent = "正在发布、验证并同步 curated cache…";
  try {
    const result = await api(`/api/promotions/${state.promotion.id}/publish`, { method: "POST" });
    $("#publish-status").textContent = result.state === "verified"
      ? `已发布并验证：${result.targetPath}`
      : `正式笔记已安全发布；MemOS curated cache 等待重试：${result.curatedReconcile.error || ""}`;
  } catch (error) {
    $("#publish-status").textContent = error.message;
    $("#publish-status").className = "error";
    $("#publish-button").disabled = false;
  }
}

async function openUniverse() {
  const result = await api("/api/knowledge-universe");
  const graph = result.graph || {};
  const nodes = graph.nodes || [];
  $("#universe-meta").textContent = result.available
    ? `真实 MemOS Brain 快照：${graph.generated_at || "尚未生成"}；Cube 原始记忆 ${result.memoryCount}；Brain 节点 ${nodes.length}；待提交阶段 ${result.pendingStages}；待整理候选 ${result.pendingCandidates}`
    : `MemOS 暂不可用；待提交阶段 ${result.pendingStages}。${result.error || ""}`;
  $("#universe-nodes").replaceChildren(...nodes.map((node) => {
    const button = element("button");
    button.type = "button";
    button.className = "universe-node";
    button.append(element("strong", node.label), element("span", node.summary || ""));
    button.addEventListener("click", () => {
      if (!state.project) return alert("先打开一个项目，概念才能成为该项目的新问题草稿。");
      $("#root-question").value = `${node.label}\n\n${node.summary || ""}\n\n我想围绕这个概念继续追问：`;
      $("#universe-dialog").close();
      $("#root-question").focus();
    });
    return button;
  }));
  $("#universe-dialog").showModal();
}

function stageCurrent(reason) {
  if (!state.card?.id) return Promise.resolve();
  return fetch(`/api/cards/${state.card.id}/stage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason }),
    keepalive: true,
  }).catch(() => undefined);
}

function jsonOptions(value) {
  return { headers: { "content-type": "application/json" }, body: JSON.stringify(value) };
}

function element(tag, text = "") {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  return node;
}

function relationMark(kind) {
  return ({ root: "●", deep_dive: "↳", diverge: "⤢", reroute: "↪" })[kind] || "•";
}

function formatBytes(value) {
  const bytes = Number(value);
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

function showError(error) {
  $("#server-status").textContent = error.message;
  $("#server-status").className = "error";
}

window.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  alert(event.reason?.message || String(event.reason));
});

void boot();

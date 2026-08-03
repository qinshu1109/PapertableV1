export interface ToolActivity {
  id: string;
  tool: string;
  status: 'running' | 'done' | 'error';
  queryLength?: number;
  requestedChunks?: number;
  hitCount?: number;
  readCount?: number;
}

export interface ThinkingActivity {
  id: string;
  status: 'running' | 'done';
  content: string;
}

type ToolEvent = {
  id: number;
  event: string;
  tool?: unknown;
  toolCallId?: unknown;
  isError?: unknown;
  queryLength?: unknown;
  requestedChunks?: unknown;
  hitCount?: unknown;
  readCount?: unknown;
};

export function reduceToolActivity(current: ToolActivity[], event: ToolEvent): ToolActivity[] {
  if (!['tool_start', 'tool_update', 'tool_end'].includes(event.event)) return current;
  const tool = String(event.tool || 'tool');
  const stableId = typeof event.toolCallId === 'string' && event.toolCallId
    ? event.toolCallId
    : `event-${event.id}`;
  const patch = {
    ...(numberValue(event.queryLength) !== undefined ? { queryLength: numberValue(event.queryLength) } : {}),
    ...(numberValue(event.requestedChunks) !== undefined
      ? { requestedChunks: numberValue(event.requestedChunks) }
      : {}),
    ...(numberValue(event.hitCount) !== undefined ? { hitCount: numberValue(event.hitCount) } : {}),
    ...(numberValue(event.readCount) !== undefined ? { readCount: numberValue(event.readCount) } : {}),
  };

  if (event.event === 'tool_start') {
    const existing = current.findIndex((item) => item.id === stableId);
    const started: ToolActivity = { id: stableId, tool, status: 'running', ...patch };
    return existing < 0
      ? [...current, started]
      : current.map((item, index) => (index === existing ? { ...item, ...started } : item));
  }

  const exact = typeof event.toolCallId === 'string'
    ? current.findIndex((item) => item.id === event.toolCallId)
    : -1;
  const metric = event.hitCount !== undefined ? 'hitCount' : event.readCount !== undefined ? 'readCount' : null;
  const legacy = exact >= 0
    ? exact
    : current.findIndex((item) =>
      item.tool === tool
      && item.status === 'running'
      && (event.event === 'tool_end' || !metric || item[metric] === undefined));
  if (legacy < 0) return current;
  return current.map((item, index) => index === legacy
    ? {
        ...item,
        ...patch,
        status: event.event === 'tool_end' ? (event.isError ? 'error' : 'done') : item.status,
      }
    : item);
}

export function reduceThinkingActivity(
  current: ThinkingActivity[],
  event: { id: number; event: string; content?: unknown },
): ThinkingActivity[] {
  if (event.event === 'thinking_start') {
    return [...current, { id: `thinking-${event.id}`, status: 'running', content: '' }];
  }
  if (event.event !== 'thinking_end') return current;
  const open = current.reduce((found, item, index) => item.status === 'running' ? index : found, -1);
  const completed = { status: 'done' as const, content: String(event.content || '') };
  return open < 0
    ? [...current, { id: `thinking-${event.id}`, ...completed }]
    : current.map((item, index) => index === open ? { ...item, ...completed } : item);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

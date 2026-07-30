export interface ToolActivity {
  id: string;
  tool: string;
  status: 'running' | 'done' | 'error';
  queryLength?: number;
  requestedChunks?: number;
  hitCount?: number;
  readCount?: number;
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

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

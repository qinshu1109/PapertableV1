import { contentText } from "@earendil-works/pi-ai";
import {
  NodeExecutionEnv,
  Session,
  type SessionStorage,
  type SessionTreeEntry,
} from "@earendil-works/pi-agent-core/node";
import {
  SqliteSessionRepo,
  createNodeSqliteFactory,
  type SqliteSessionMetadata,
} from "@earendil-works/pi-storage-sqlite-node";
import type { DataStore } from "./data.ts";
import type { RunContext } from "./notes.ts";
import { sanitizeAssistantMessage } from "./gate.ts";

export type SessionRepo = SqliteSessionRepo;
export type PiSession = Session<SqliteSessionMetadata>;

export function createSessionRepo(store: DataStore): SessionRepo {
  return new SqliteSessionRepo({
    env: new NodeExecutionEnv({ cwd: store.dataDir }),
    sqlite: createNodeSqliteFactory(),
    databasePath: store.databasePath,
  });
}

export async function openSessionById(
  repo: SessionRepo,
  sessionId: string,
  projectId?: string,
): Promise<PiSession> {
  const sessions = await repo.list(projectId ? { cwd: sessionCwd(projectId) } : undefined);
  const metadata = sessions.find((candidate) => candidate.id === sessionId);
  if (!metadata) throw new Error(`Pi session not found: ${sessionId}`);
  return repo.open(metadata);
}

export function withSanitizedStorage(session: PiSession, context: RunContext): PiSession {
  const storage = session.getStorage();
  const proxy = new Proxy(storage, {
    get(target, property, receiver) {
      if (property === "appendEntry") {
        return async (entry: SessionTreeEntry) => {
          let safeEntry = entry;
          if (entry.type === "message" && entry.message.role === "assistant") {
            safeEntry = {
              ...entry,
              message: sanitizeAssistantMessage(entry.message, context),
            };
          }
          await target.appendEntry(safeEntry);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as SessionStorage<SqliteSessionMetadata>;
  return new Session(proxy);
}

export async function closeSession(session: PiSession): Promise<void> {
  const storage = session.getStorage() as SessionStorage<SqliteSessionMetadata> & {
    cleanup?: () => Promise<void>;
  };
  await storage.cleanup?.();
}

export async function activeConversation(session: PiSession): Promise<Array<{
  entryId: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number | string;
  stopReason?: string;
}>> {
  const entries = await session.getBranch();
  const messages: Array<{
    entryId: string;
    role: "user" | "assistant";
    text: string;
    timestamp: number | string;
    stopReason?: string;
  }> = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    if (entry.message.role !== "user" && entry.message.role !== "assistant") continue;
    const text = contentText(entry.message.content, "").trim();
    if (!text) continue;
    messages.push({
      entryId: entry.id,
      role: entry.message.role,
      text,
      timestamp: entry.message.timestamp,
      ...("stopReason" in entry.message ? { stopReason: entry.message.stopReason } : {}),
    });
  }
  return messages;
}

export function sessionCwd(projectId: string): string {
  return `papertable-project:${projectId}`;
}

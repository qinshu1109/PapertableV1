/**
 * TASK-PW-26：语料抓取触发器（AI 自主档，模块侧）。
 *
 * 职责：仅负责以单飞方式启动 `scripts/pw-fetch-bili-corpus.js`
 * （ego-browser nodejs 运行时，即 `ego-browser nodejs < <scriptPath>`）的后台进程；
 * 不碰 db、不记账——记账由调用方（主代理集成的 fetch_corpus 工具）以 kind=ai_auto 落账。
 *
 * 降级：spawn 抛错（ego CLI 不在/未运行等）→ 捕获并返回 `{ started: false, reason: "spawn_failed: <msg>" }`，
 * 绝不向上抛——语料行仍在 pending 队列，人工可补跑脚本（后路）。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export type PwCorpusFetchTrigger = { started: boolean; reason?: string };

type PwCorpusFetchChild = {
  unref: () => void;
  on: (event: string, listener: (...args: any[]) => void) => unknown;
};

export type PwCorpusFetchSpawnFn = (
  command: string,
  args: readonly string[],
  options: { detached: boolean; stdio: "ignore" },
) => PwCorpusFetchChild;

/** 单飞标记：子进程 exit/error 时复位；测试用 _resetPwCorpusFetchRunnerForTest 复位。 */
let running = false;

export function triggerPwCorpusFetch(options: {
  spawnFn?: PwCorpusFetchSpawnFn;
  scriptPath?: string;
  /** 保留位：供测试注入时间；当前单飞语义不依赖时间。 */
  nowMs?: number;
} = {}): PwCorpusFetchTrigger {
  if (running) return { started: false, reason: "already_running" };
  const scriptPath = options.scriptPath ?? defaultCorpusScriptPath();
  const spawnFn = options.spawnFn ?? defaultSpawnFn;
  let child: PwCorpusFetchChild;
  try {
    child = spawnFn("sh", ["-c", `${egoBrowserBin()} nodejs < ${scriptPath}`], {
      detached: true,
      stdio: "ignore",
    });
  } catch (error) {
    return { started: false, reason: `spawn_failed: ${messageOf(error)}` };
  }
  running = true;
  child.unref();
  child.on("exit", () => {
    running = false;
  });
  child.on("error", () => {
    running = false;
  });
  return { started: true };
}

/** TASK-PW-26：测试复位单飞标记。 */
export function _resetPwCorpusFetchRunnerForTest(): void {
  running = false;
}

const defaultSpawnFn: PwCorpusFetchSpawnFn = (command, args, opts) =>
  spawn(command, args, opts);

function defaultCorpusScriptPath(): string {
  return fileURLToPath(new URL("../scripts/pw-fetch-bili-corpus.js", import.meta.url));
}

/**
 * ego-browser CLI 定位：launchd 后端的 PATH 没有 ~/.local/bin，裸名字会
 * 「spawn 成功、sh 内 127 退出」假启动（真实冒烟抓到的坑）。优先环境变量，
 * 其次常见安装路径，最后才回退裸名（交互 shell 场景）。
 */
function egoBrowserBin(): string {
  const fromEnv = process.env.EGO_BROWSER_BIN?.trim();
  if (fromEnv) return fromEnv;
  const local = `${homedir()}/.local/bin/ego-browser`;
  if (existsSync(local)) return local;
  return "ego-browser";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

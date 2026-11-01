import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { DEBUG_LOG_PATH } from "./config.js";

/** Past this size the log rolls to .1, .1 to .2, and .2 is dropped: at most three files. */
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_KEEP_OLD = 2;

function toLogString(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function rollIfFull(file: string): Promise<void> {
  const size = await stat(file).then((s) => s.size, () => 0);
  if (size < LOG_MAX_BYTES) return;
  await rm(`${file}.${LOG_KEEP_OLD}`, { force: true });
  for (let n = LOG_KEEP_OLD - 1; n >= 1; n--) {
    await rename(`${file}.${n}`, `${file}.${n + 1}`).catch(() => {});
  }
  await rename(file, `${file}.1`);
}

// Writes run one at a time, so two of them never roll the same file.
let queue: Promise<void> = Promise.resolve();

/**
 * The one debug-log writer for the whole project, so nobody reimplements it.
 * A failed write is swallowed and never affects the main flow.
 */
export function appendDebugLog(
  scope: string,
  message: string,
  detail?: unknown,
): Promise<void> {
  const line = [
    `[${new Date().toISOString()}]`,
    `[${scope}]`,
    message,
    detail === undefined ? "" : toLogString(detail),
  ]
    .filter(Boolean)
    .join(" ");
  queue = queue.then(async () => {
    try {
      await mkdir(dirname(DEBUG_LOG_PATH), { recursive: true });
      await rollIfFull(DEBUG_LOG_PATH);
      await appendFile(DEBUG_LOG_PATH, `${line}\n`, "utf8");
    } catch {
      // A failed log write must not affect the main flow.
    }
  });
  return queue;
}

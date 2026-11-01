// Runtime config file loader: a config file (browserdo.config.yaml/json) instead of a long list
// of environment variables, because it is easier to edit.
//
// Precedence: code defaults < config file < environment variables, for the keys in
// CONFIG_ENV_MAP. The structured sections (vllm.extraBody, vllmFallbacks, the sensitive-word
// lists) come from the file alone; no environment variable reaches them.
//
// It must run before modules that read process.env at import time (config.ts, runtime_vllm.ts
// and friends), which is why index.ts imports those dynamically and calls this first.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// js-yaml is a CJS module; createRequire is the most reliable way to load it from ESM.
const yamlModule = createRequire(import.meta.url)("js-yaml") as {
  load: (text: string) => unknown;
};

/** Dotted config key -> environment variable. A file value is used only when the env has none. */
const CONFIG_ENV_MAP: Array<[string, string]> = [
  ["vllm.endpoint", "EMBIODY_VLLM_ENDPOINT"],
  ["vllm.model", "EMBIODY_VLLM_MODEL"],
  ["vllm.apiKey", "EMBIODY_VLLM_API_KEY"],
  ["vllm.apiStyle", "EMBIODY_VLLM_API_STYLE"],
  ["vllm.timeoutMs", "EMBIODY_VLLM_TIMEOUT_MS"],
  ["vllmFallback.endpoint", "EMBIODY_VLLM_FALLBACK_ENDPOINT"],
  ["vllmFallback.model", "EMBIODY_VLLM_FALLBACK_MODEL"],
  ["vllmFallback.apiKey", "EMBIODY_VLLM_FALLBACK_API_KEY"],
  ["vllmFallback.apiStyle", "EMBIODY_VLLM_FALLBACK_API_STYLE"],
  ["retry.intervalMs", "EMBIODY_VLLM_RETRY_INTERVAL_MS"],
  ["retry.intervalMalformedMs", "EMBIODY_VLLM_RETRY_INTERVAL_MALFORMED_MS"],
  ["retry.intervalTimeoutMs", "EMBIODY_VLLM_RETRY_INTERVAL_TIMEOUT_MS"],
  ["retry.timeoutEscalation", "EMBIODY_VLLM_TIMEOUT_ESCALATION"],
  ["retry.timeoutMaxFactor", "EMBIODY_VLLM_TIMEOUT_MAX_FACTOR"],
  ["retry.maxRetries", "EMBIODY_VLLM_MAX_RETRIES"],
  ["retry.status", "EMBIODY_VLLM_RETRY_STATUS"],
  ["cdp.host", "EMBIODY_CDP_HOST"],
  ["cdp.commandTimeoutMs", "EMBIODY_CDP_COMMAND_TIMEOUT_MS"],
  ["debug.logPrompt", "EMBIODY_LOG_PROMPT"],
  ["debug.saveSnapshots", "EMBIODY_SAVE_SNAPSHOTS"],
  ["paths.snapshotDir", "EMBIODY_SNAPSHOT_DIR"],
  ["wait.postActionMs", "EMBIODY_POST_ACTION_WAIT_MS"],
  ["wait.postNavigateMs", "EMBIODY_POST_NAVIGATE_WAIT_MS"],
  ["wait.roundIntervalMs", "EMBIODY_ROUND_INTERVAL_MS"],
  ["snapshot.returnImage", "EMBIODY_SNAPSHOT_RETURN_IMAGE"],
  ["snapshot.timeoutMs", "EMBIODY_SNAPSHOT_TIMEOUT_MS"],
  ["snapshot.retryDelayMs", "EMBIODY_SNAPSHOT_RETRY_DELAY_MS"],
  ["task.totalTimeoutMs", "EMBIODY_TOTAL_TIMEOUT_MS"],
  ["guardrail.repeatThreshold", "EMBIODY_REPEAT_THRESHOLD"],
  ["guardrail.maxActionsPerRound", "EMBIODY_MAX_ACTIONS_PER_ROUND"],
  ["guardrail.maxSameTargetRounds", "EMBIODY_MAX_SAME_TARGET_ROUNDS"],
  ["browser.exePath", "EMBIODY_EXE_PATH"],
  ["browser.userDataDir", "EMBIODY_USER_DATA_DIR"],
  ["browser.extraFlags", "EMBIODY_EXTRA_FLAGS"],
  ["browser.resetProfile", "EMBIODY_RESET_PROFILE"],
  ["browser.profileBaseline", "EMBIODY_PROFILE_BASELINE"],
];

function getPath(obj: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((o, k) => {
    if (o && typeof o === "object") {
      return (o as Record<string, unknown>)[k];
    }
    return undefined;
  }, obj);
}

export interface VllmFallbackConfig {
  endpoint: string;
  model: string;
  apiKey: string;
  apiStyle?: "openai" | "simple_chat";
  /** Extra request-body fields merged in verbatim; see getVllmExtraBody. */
  extraBody?: Record<string, unknown>;
}

/**
 * The primary model's extraBody: fields **merged into the request body verbatim**.
 *
 * It exists for thinking control. Every vendor differs in parameter name, accepted values,
 * and even whether the parameter exists at all — and **getting it wrong is not ignored, it
 * fails the request** (GLM-5.3 refuses thinking:{type:"disabled"}; qwen3.8-max answers
 * BadRequest to enable_thinking:false). So nothing here is mapped or validated: we cannot
 * maintain a correct table for seven vendors, and a wrong table is worse than none. What
 * the config says is what gets sent; if it is wrong the endpoint refuses, and a refusal is
 * classed as non-retryable and fails straight over to the fallback endpoint.
 *
 * This cannot go through CONFIG_ENV_MAP: that path puts values into process.env and so can
 * only carry strings, while this is a nested object
 * (chat_template_kwargs:{enable_thinking:false}).
 */
export function getVllmExtraBody(): Record<string, unknown> | undefined {
  if (!parsedConfig || typeof parsedConfig !== "object") return undefined;
  const vllm = (parsedConfig as Record<string, unknown>).vllm;
  if (!vllm || typeof vllm !== "object") return undefined;
  const extra = (vllm as Record<string, unknown>).extraBody;
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) {
    return undefined;
  }
  return extra as Record<string, unknown>;
}

/**
 * The sensitive-word lists (`guardrail.sensitiveIntent` / `guardrail.sensitiveCredential`).
 *
 * These cannot go through CONFIG_ENV_MAP either: that path can only carry strings, and
 * these are arrays. Configuring one replaces the whole list rather than appending — to add
 * a word to the defaults, copy the default list and add to it. That way what the config
 * file shows is exactly what is in force, with no need to cross-check the code, and adding
 * a language is a config change rather than a code change.
 */
export function getSensitiveWords(): Partial<{
  intent: string[];
  credential: string[];
}> {
  if (!parsedConfig || typeof parsedConfig !== "object") return {};
  const g = (parsedConfig as Record<string, unknown>).guardrail;
  if (!g || typeof g !== "object") return {};
  const pick = (k: string): string[] | undefined => {
    const v = (g as Record<string, unknown>)[k];
    if (!Array.isArray(v)) return undefined;
    const out = v.map((x) => String(x ?? "").trim()).filter(Boolean);
    return out.length ? out : undefined;
  };
  const intent = pick("sensitiveIntent");
  const credential = pick("sensitiveCredential");
  return {
    ...(intent ? { intent } : {}),
    ...(credential ? { credential } : {}),
  };
}

/** The parsed config file (set by loadRuntimeConfigFile), for structured readers such as getVllmFallbacks. */
let parsedConfig: unknown = null;

/**
 * Read the fallback models from the config: vllmFallbacks first (an array, any length),
 * falling back to the older single vllmFallback (wrapped into an array). Only entries with
 * endpoint, model and apiKey all present are returned.
 */
export function getVllmFallbacks(): VllmFallbackConfig[] {
  if (!parsedConfig || typeof parsedConfig !== "object") {
    return [];
  }
  const cfg = parsedConfig as Record<string, unknown>;
  const arr = cfg.vllmFallbacks;
  if (Array.isArray(arr)) {
    return arr.filter(
      (f): f is VllmFallbackConfig =>
        !!f &&
        typeof f === "object" &&
        !!(f as VllmFallbackConfig).endpoint &&
        !!(f as VllmFallbackConfig).model &&
        !!(f as VllmFallbackConfig).apiKey,
    );
  }
  const single = cfg.vllmFallback as VllmFallbackConfig | undefined;
  if (single && single.endpoint && single.model && single.apiKey) {
    return [single];
  }
  return [];
}

/** Expand Windows-style %VAR% references (%APPDATA%/embiody -> <your AppData\Roaming>/embiody). */
function expandEnvVars(str: string): string {
  return str.replace(/%(\w+)%/g, (_, name) => process.env[name] ?? "");
}

/** Locate the config file: --config > EMBIODY_CONFIG > the first existing .yaml/.yml/.json. */
function findConfigFile(configPath?: string): string | null {
  const explicit = configPath ?? process.env.EMBIODY_CONFIG;
  if (explicit) {
    return existsSync(explicit) ? explicit : null;
  }
  for (const name of [
    "browserdo.config.yaml",
    "browserdo.config.yml",
    "browserdo.config.json",
  ]) {
    const full = path.join(process.cwd(), name);
    if (existsSync(full)) {
      return full;
    }
  }
  return null;
}

/**
 * Read the runtime config file and put its values into process.env (only where the env has
 * none). configPath wins; otherwise EMBIODY_CONFIG; otherwise <cwd>/browserdo.config.* if present.
 */
export function loadRuntimeConfigFile(configPath?: string): void {
  const file = findConfigFile(configPath);
  if (!file) {
    return;
  }

  let raw: unknown;
  try {
    // yaml.load parses both YAML and JSON (JSON is a subset of YAML), with comments allowed.
    raw = yamlModule.load(readFileSync(file, "utf8")) as unknown;
  } catch (e) {
    console.error(
      `[runtime_config] failed to parse the config file (${file}): ${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }

  parsedConfig = raw;

  let applied = 0;
  let skipped = 0;
  for (const [dotted, envVar] of CONFIG_ENV_MAP) {
    const value = getPath(raw, dotted);
    if (value === undefined || value === null) {
      continue;
    }
    // The environment wins: a variable that is already set is not overridden by the file.
    //
    // This is required for MCP distribution. When a client (Claude Code, Codex, ...) starts
    // us, the only things it can reliably control are the env and args of the process it
    // spawns — it cannot touch our config file. If the file overrode the env unconditionally,
    // a browserdo.config.yaml that happens to sit in the working directory with a
    // vllm.apiKey in it would silently replace the key the client passed, and nothing on the
    // client side would look wrong.
    if (process.env[envVar] !== undefined) {
      skipped += 1;
      continue;
    }
    // A YAML boolean is written the way the env switches read it ("1"/"0"), not as "true"/"false".
    // Strings get Windows-style %VAR% references expanded.
    process.env[envVar] = typeof value === "boolean" ? (value ? "1" : "0") : expandEnvVars(String(value));
    applied += 1;
  }
  const skipNote =
    skipped > 0 ? `, ${skipped} skipped because the environment already supplies them` : "";
  console.error(
    `[runtime_config] loaded runtime config from ${file} (${applied} settings applied${skipNote})`,
  );
}

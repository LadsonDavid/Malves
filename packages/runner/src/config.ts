import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { command } from "@malves/core";
import { z } from "zod";
import type { GuardConfig } from "./adapters/budget_proxy/guard.js";
import type { Secrets } from "./adapters/secrets/secrets.js";
import type { AgentSpec } from "./agents.js";

/**
 * Optional settings in <data dir>/config.json. Nothing secret lives here:
 * keys are referenced by name and read from the keychain.
 *
 * {
 *   "budget": {
 *     "free":  { "url": "http://127.0.0.1:3001/v1", "key": "FREELLMAPI_KEY" },
 *     "own":   { "url": "https://openrouter.ai/api/v1", "key": "OWN_API_KEY" },
 *     "floor": ["claude-*", "gpt-5*", "qwen3-coder*"]
 *   },
 *   "agents": [
 *     { "name": "cheap", "label": "OpenCode on free models",
 *       "program": "opencode", "args": ["acp"], "budget": "openai" }
 *   ]
 * }
 */

const Upstream = z.object({
  url: z.url({ protocol: /^https?$/ }).transform((u) => u.replace(/\/+$/, "")),
  /** Name of a keychain secret (`malves secret set NAME`). */
  key: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{1,63}$/)
    .optional(),
});

const UserAgent = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/),
  label: z.string().min(1).max(80),
  program: z.string().min(1),
  args: z.array(z.string()).default([]),
  secretEnv: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/)).optional(),
  authMethod: z.string().optional(),
  budget: z.enum(["openai", "anthropic"]).optional(),
});

export const Config = z.object({
  budget: z
    .object({
      free: Upstream.optional(),
      own: Upstream.optional(),
      anthropic: Upstream.optional(),
      floor: z.array(z.string().min(1)).default([]),
    })
    .default({ floor: [] }),
  agents: z.array(UserAgent).default([]),
});
export type Config = z.infer<typeof Config>;

export function loadConfig(dir: string): Config {
  const file = path.join(dir, "config.json");
  if (!existsSync(file)) return Config.parse({});
  const parsed = Config.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) {
    throw new Error(`${file} is not valid:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

export function guardConfig(config: Config, secrets: Secrets): GuardConfig {
  const resolve = (up: z.infer<typeof Upstream> | undefined) => {
    if (!up) return undefined;
    const key = up.key ? secrets.get(up.key) : undefined;
    return { url: up.url, ...(key ? { key } : {}) };
  };
  const free = resolve(config.budget.free);
  const own = resolve(config.budget.own);
  const anthropic = resolve(config.budget.anthropic);
  return {
    ...(free ? { free } : {}),
    ...(own ? { own } : {}),
    ...(anthropic ? { anthropic } : {}),
  };
}

export function userAgents(config: Config): AgentSpec[] {
  return config.agents.map((a) => ({
    name: a.name,
    label: a.label,
    command: command(a.program, a.args),
    requires: a.program,
    ...(a.secretEnv ? { secretEnv: a.secretEnv } : {}),
    ...(a.authMethod ? { authMethod: a.authMethod } : {}),
    ...(a.budget ? { budget: a.budget } : {}),
  }));
}

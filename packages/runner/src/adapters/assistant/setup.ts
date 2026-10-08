import path from "node:path";
import type { Core } from "@malves/core";
import type { AgentInfo, IdeInfo, Lead } from "@malves/protocol";
import type { Browser } from "../browser/bridge.js";
import type { AssistantPort, IdeControl } from "../link/server.js";
import { Assistant } from "./assistant.js";
import type { Handover } from "./handover.js";
import { openAiCompatible } from "./llm.js";
import { Memory } from "./memory.js";
import { Profile } from "./profile.js";

/**
 * Malves, the assistant, if its brain and memory are set up:
 *   MALVES_MODELS_URL / MALVES_MODELS_KEY  your freellmapi (the brain)
 *   MALVES_VAULT                           the Obsidian folder that holds its memory
 *   MALVES_ASSISTANT_MODEL, MALVES_EMBED_MODEL   optional overrides
 *   MALVES_VISION_MODEL                    optional: vision models to try, comma-separated
 */
export function assistantFromEnv(o: {
  core: Core;
  dataDir: string;
  agents: () => AgentInfo[];
  ide?: IdeControl | undefined;
  leads?: (() => Promise<Lead[]>) | undefined;
  handover?: Handover | undefined;
  browser?: Browser | undefined;
}): { port: AssistantPort; close: () => void; reviewProfile: () => Promise<number> } | undefined {
  const url = process.env.MALVES_MODELS_URL;
  const key = process.env.MALVES_MODELS_KEY;
  const vault = process.env.MALVES_VAULT;
  if (!url || !key || !vault) return undefined;
  const llm = openAiCompatible({
    url,
    key,
    ...(process.env.MALVES_ASSISTANT_MODEL ? { model: process.env.MALVES_ASSISTANT_MODEL } : {}),
    ...(process.env.MALVES_EMBED_MODEL ? { embedModel: process.env.MALVES_EMBED_MODEL } : {}),
    ...(process.env.MALVES_VISION_MODEL
      ? { visionModels: process.env.MALVES_VISION_MODEL.split(",").map((m) => m.trim()) }
      : {}),
  });
  const memory = new Memory({
    vault,
    indexFile: path.join(o.dataDir, "memory-index.db"),
    embed: (texts) => llm.embed(texts),
  });
  const profile = new Profile({ vault, dataDir: o.dataDir, llm });
  const ides: (() => IdeInfo[]) | undefined = o.ide ? () => o.ide?.list() ?? [] : undefined;
  const assistant = new Assistant({
    core: o.core,
    llm,
    memory,
    agents: o.agents,
    ...(ides ? { ides } : {}),
    ...(o.ide ? { ide: o.ide } : {}),
    ...(o.leads ? { leads: o.leads } : {}),
    userName: "Ladson",
    ...(o.handover ? { handover: o.handover } : {}),
    ...(o.browser ? { browser: o.browser } : {}),
    profile,
  });
  return {
    port: {
      say: (conversation, text, alternatives, onText) =>
        assistant.say(conversation, text, alternatives, onText),
      confirm: (conversation, pending, yes) => assistant.confirm(conversation, pending, yes),
      look: (conversation, photo, question) => assistant.look(conversation, photo, question),
      memories: async () =>
        (await memory.list()).map((m) => ({
          id: m.id,
          kind: m.kind,
          title: m.title,
          text: m.text,
          since: m.validFrom,
        })),
      forget: (id) => memory.forget(id) !== undefined,
    },
    close: () => memory.close(),
    reviewProfile: () =>
      profile.review(o.core.tasks.list().map((t) => `${t.agent}: ${t.prompt.slice(0, 160)}`)),
  };
}

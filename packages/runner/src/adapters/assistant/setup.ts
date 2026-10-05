import path from "node:path";
import type { Core } from "@malves/core";
import type { AgentInfo, IdeInfo, Lead } from "@malves/protocol";
import type { AssistantPort, IdeControl } from "../link/server.js";
import { Assistant } from "./assistant.js";
import { openAiCompatible } from "./llm.js";
import { Memory } from "./memory.js";

/**
 * Malves, the assistant, if its brain and memory are set up:
 *   MALVES_MODELS_URL / MALVES_MODELS_KEY  your freellmapi (the brain)
 *   MALVES_VAULT                           the Obsidian folder that holds its memory
 *   MALVES_ASSISTANT_MODEL, MALVES_EMBED_MODEL   optional overrides
 */
export function assistantFromEnv(o: {
  core: Core;
  dataDir: string;
  agents: () => AgentInfo[];
  ide?: IdeControl | undefined;
  leads?: (() => Promise<Lead[]>) | undefined;
}): { port: AssistantPort; close: () => void } | undefined {
  const url = process.env.MALVES_MODELS_URL;
  const key = process.env.MALVES_MODELS_KEY;
  const vault = process.env.MALVES_VAULT;
  if (!url || !key || !vault) return undefined;
  const llm = openAiCompatible({
    url,
    key,
    ...(process.env.MALVES_ASSISTANT_MODEL ? { model: process.env.MALVES_ASSISTANT_MODEL } : {}),
    ...(process.env.MALVES_EMBED_MODEL ? { embedModel: process.env.MALVES_EMBED_MODEL } : {}),
  });
  const memory = new Memory({
    vault,
    indexFile: path.join(o.dataDir, "memory-index.db"),
    embed: (texts) => llm.embed(texts),
  });
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
  });
  return {
    port: {
      say: (conversation, text, alternatives) => assistant.say(conversation, text, alternatives),
      confirm: (conversation, pending, yes) => assistant.confirm(conversation, pending, yes),
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
  };
}

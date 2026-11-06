import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Core } from "@malves/core";
import type { AgentInfo, IdeInfo, Lead } from "@malves/protocol";
import type { Browser } from "../browser/bridge.js";
import type { AssistantPort, IdeControl } from "../link/server.js";
import { Assistant, type AssistantDeps } from "./assistant.js";
import { AutoMemory } from "./automemory.js";
import { BookLibrary, tesseractOcr } from "./books.js";
import type { Caller } from "./caller.js";
import { Character, DEFAULT_CHARACTER, PERSONA_FILE } from "./character.js";
import { ChatStore } from "./chats.js";
import { Gmail, GmailAccounts } from "./gmail.js";
import type { Handover } from "./handover.js";
import { openAiCompatible } from "./llm.js";
import { Memory } from "./memory.js";
import { Profile } from "./profile.js";
import type { SemanticDesktop } from "./semantic-desktop.js";
import { SkillLibrary } from "./skills.js";

/**
 * Malves, the assistant, if its brain and memory are set up:
 *   MALVES_MODELS_URL / MALVES_MODELS_KEY  your freellmapi (the brain)
 *   MALVES_VAULT                           the Obsidian folder that holds its memory
 *   MALVES_STANDBY=1                       the always-on server copy: talk, memory, books, skills only
 *   MALVES_BOOKS                           optional: folders of PDFs/notes to search (separated like PATH)
 *   MALVES_SKILLS                          optional: skill folders (default ~/.claude, ~/.codex, ~/.agents)
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
  caller?: Caller | undefined;
  semantic?: SemanticDesktop | undefined;
  desktopChats?: AssistantDeps["desktopChats"];
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
  // Skills from every agent he uses (MALVES_SKILLS lists other folders, separated like PATH).
  const skillRoots = process.env.MALVES_SKILLS
    ? process.env.MALVES_SKILLS.split(path.delimiter).filter(Boolean)
    : [".claude", ".codex", ".agents"].map((d) => path.join(homedir(), d, "skills"));
  const library = new SkillLibrary({
    root: skillRoots,
    importRoot: path.join(o.dataDir, "imported-skills"),
    dataDir: o.dataDir,
    embed: (texts) => llm.embed(texts),
  });
  // The first indexing takes a few seconds: start it now, in the background.
  void library.fill().catch(() => {});
  // His books and notes (MALVES_BOOKS: folders, separated like PATH). Read and embedded
  // in the background in small rounds, and looked at again every ten minutes for new files.
  const bookRoots = (process.env.MALVES_BOOKS ?? "")
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter(Boolean);
  const books = bookRoots.length
    ? new BookLibrary({
        roots: bookRoots,
        indexFile: path.join(o.dataDir, "books-index.db"),
        // Scanned PDFs are read with OCR in the background when MALVES_OCR=1 (needs Tesseract).
        ...(process.env.MALVES_OCR === "1" ? { ocr: tesseractOcr } : {}),
        // Embedding sends book text to the embedding model (Cloudflare bge-m3 through
        // freellmapi); MALVES_BOOKS_EMBED=0 keeps the books on this computer (text search only).
        ...(process.env.MALVES_BOOKS_EMBED === "0" ? {} : { embed: (texts) => llm.embed(texts) }),
      })
    : undefined;
  // His chats: normal ones are Markdown in the vault, temp ones stay in memory.
  const chats = new ChatStore({ vault });
  const autoMemory = new AutoMemory({ llm, memory });
  // His Gmail accounts (read and drafts only). Needs his own Google OAuth client; not on the server copy.
  const googleId = process.env.MALVES_GOOGLE_CLIENT_ID;
  const googleSecret = process.env.MALVES_GOOGLE_CLIENT_SECRET;
  const gmail =
    googleId && googleSecret && process.env.MALVES_STANDBY !== "1"
      ? new Gmail({
          accounts: new GmailAccounts(o.dataDir),
          clientId: googleId,
          clientSecret: googleSecret,
        })
      : undefined;
  let bookTimer: NodeJS.Timeout | undefined;
  let closed = false;
  const keepBooksCurrent = async () => {
    let waiting = 0;
    try {
      await books?.sync();
      waiting = (await books?.fill()) ?? 0;
      // One scanned book per round; the loop comes back soon for the next.
      waiting += (await books?.ocrNext()) ?? 0;
    } catch {
      // A bad file or a missing pdftotext shows in the library's status; try again later.
    }
    if (closed) return;
    bookTimer = setTimeout(() => void keepBooksCurrent(), waiting > 0 ? 20_000 : 600_000);
    bookTimer.unref();
  };
  if (books) void keepBooksCurrent();
  // His character: seeded once as Persona.md so he can edit it in Obsidian; the file wins.
  const personaFile = path.join(vault, PERSONA_FILE);
  if (!existsSync(personaFile)) {
    try {
      writeFileSync(personaFile, DEFAULT_CHARACTER);
    } catch {
      // Read-only vault: Malves simply speaks without a character file.
    }
  }
  const characterEdit = new Character({
    file: personaFile,
    backup: path.join(o.dataDir, "persona-previous.md"),
  });
  const character = () => characterEdit.text();
  const ides: (() => IdeInfo[]) | undefined = o.ide ? () => o.ide?.list() ?? [] : undefined;
  const assistant = new Assistant({
    core: o.core,
    semantic: o.semantic,
    ...(o.desktopChats ? { desktopChats: o.desktopChats } : {}),
    llm,
    memory,
    agents: o.agents,
    ...(ides ? { ides } : {}),
    ...(o.ide ? { ide: o.ide } : {}),
    ...(o.leads ? { leads: o.leads } : {}),
    // The owner's name, as Malves says it; unset means "the owner".
    ...(process.env.MALVES_USER_NAME?.trim()
      ? { userName: process.env.MALVES_USER_NAME.trim() }
      : {}),
    ...(o.handover ? { handover: o.handover } : {}),
    ...(o.browser ? { browser: o.browser } : {}),
    profile,
    library,
    ...(books ? { books } : {}),
    character,
    characterEdit,
    chats,
    autoMemory,
    ...(gmail ? { gmail } : {}),
    // The server copy (MALVES_STANDBY=1) talks and recalls; the laptop does the work.
    standby: process.env.MALVES_STANDBY === "1",
    ...(o.caller ? { caller: o.caller } : {}),
  });
  return {
    port: {
      skills: {
        list: () => library.list(),
        add: (text) => library.add(text),
        remove: (name) => library.remove(name),
      },
      chats: {
        list: () => chats.list(),
        create: (temp) => chats.create(temp),
        open: (id) => chats.get(id),
        save: (id) => chats.save(id),
        remove: (id) => chats.remove(id),
      },
      cancel: (conversation) => assistant.cancel(conversation),
      say: (conversation, text, alternatives, onText, where, onProgress, focus) =>
        assistant.say(conversation, text, alternatives, onText, where, onProgress, focus),
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
    close: () => {
      closed = true;
      if (bookTimer) clearTimeout(bookTimer);
      books?.close();
      memory.close();
    },
    reviewProfile: () =>
      profile.review(o.core.tasks.list().map((t) => `${t.agent}: ${t.prompt.slice(0, 160)}`)),
  };
}

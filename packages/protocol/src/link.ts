import { z } from "zod";
import { isKey } from "./crypto.js";
import { LoggedEvent } from "./events.js";
import { Lead } from "./leads.js";

/**
 * The phone ↔ runner link (§4). Our own small protocol: ACP covers runner ↔
 * agent, but its remote transport is still work in progress, and the phone
 * needs things ACP doesn't model.
 *
 * On the wire: JSON frames over a WebSocket.
 *  1. runner → phone, in the clear: `{type: "challenge", challenge}`
 *  2. phone → runner: `{device, n, c}` — its public key, and a sealed `hello`
 *     that repeats the challenge (so an old hello can't be replayed)
 *  3. from then on, both ways: `{n, c}`, sealed messages only
 * Everything inside `c` is validated with the schemas below on arrival.
 */

export const LINK_VERSION = 1;
export const DEFAULT_PORT = 7717;

/** WebSocket close codes. The phone stops reconnecting on any of these. */
export const CLOSE = {
  NOT_PAIRED: 4001,
  BAD_CODE: 4002,
  VERSION: 4003,
  BAD_MESSAGE: 4004,
  REVOKED: 4005,
} as const;
export const FINAL_CLOSE_CODES: readonly number[] = Object.values(CLOSE);

const Key = z.string().refine(isKey, "not a 32-byte base64 key");
const Token = z.string().min(16).max(128);
const Id = z.string().min(1).max(64);

/** What the QR code on the desktop carries. */
export const PairingOffer = z.object({
  v: z.literal(LINK_VERSION),
  url: z.string().regex(/^wss?:\/\/\S+$/, "must be a ws:// or wss:// URL"),
  runner: Key,
  code: Token,
  computer: z.string().min(1).max(100),
});
export type PairingOffer = z.infer<typeof PairingOffer>;

// ── Frames, in the clear ────────────────────────────────────────────────────

export const ChallengeFrame = z.object({ type: z.literal("challenge"), challenge: Token });
export const FirstFrame = z.object({ device: Key, n: z.string(), c: z.string() });
export const SealedFrame = z.object({ n: z.string(), c: z.string() });

// ── Phone → runner, sealed ──────────────────────────────────────────────────

export const Hello = z.object({
  type: z.literal("hello"),
  v: z.number().int(),
  challenge: Token,
  /** Resume: send me every event after this one. 0 for everything. */
  since_seq: z.number().int().min(0),
  /** Wish List: only these event types. Omitted means all. */
  wish: z.array(z.string().max(40)).max(20).optional(),
  /** Only on the first connection: the code from the QR, and this phone's name. */
  pair: z.object({ code: Token, name: z.string().min(1).max(100) }).optional(),
});
export type Hello = z.infer<typeof Hello>;

export const TaskCreate = z.object({
  type: z.literal("task.create"),
  command_id: Id,
  /** A project id, or (newer) a `folder` from `sessions.all`: one of the two. */
  workspace_id: Id.optional(),
  folder: z.string().min(1).max(1000).optional(),
  agent: Id,
  prompt: z.string().min(1).max(20_000),
  /** An agent session id from `sessions.list`, to continue it. */
  resume: z.string().min(1).max(200).optional(),
});

/** Which coding tool a session belongs to. */
export const SessionTool = z.enum(["claude", "codex", "cursor", "antigravity"]);

/** Every session on the computer, across tools, newest first, and the folders they ran in. */
export const SessionsAll = z.object({
  type: z.literal("sessions.all"),
  command_id: Id,
  tool: SessionTool.optional(),
});

/** A session's conversation (answered in `ack.messages`). */
export const SessionRead = z.object({
  type: z.literal("session.read"),
  command_id: Id,
  tool: SessionTool,
  session_id: z.string().regex(/^[\w.:-]{1,128}$/),
});

/** Continue a session with a new message: resumed, sent to Cursor, or a new session told the story so far. */
export const SessionContinue = z.object({
  type: z.literal("session.continue"),
  command_id: Id,
  tool: SessionTool,
  session_id: z.string().regex(/^[\w.:-]{1,128}$/),
  text: z.string().min(1).max(20_000),
});

/** Continue a finished task's conversation with the same agent. */
export const TaskReply = z.object({
  type: z.literal("task.reply"),
  command_id: Id,
  task_id: Id,
  prompt: z.string().min(1).max(20_000),
});

/** A finished task's changes as a diff (answered in `ack.result`). */
export const ChangesDiff = z.object({
  type: z.literal("changes.diff"),
  command_id: Id,
  task_id: Id,
});

/** The agent's saved sessions in one project, newest first (answered in the ack). */
export const SessionsList = z.object({
  type: z.literal("sessions.list"),
  command_id: Id,
  workspace_id: Id,
  agent: Id,
});

export const AnswerCommand = z.object({
  type: z.literal("answer"),
  command_id: Id,
  question_id: Id,
  choice_id: z.string().min(1).max(200),
});

export const TaskStop = z.object({
  type: z.literal("task.stop"),
  command_id: Id,
  task_id: Id,
});

/**
 * Malves' natural voices. Each sentence is tried with Cartesia, then
 * ElevenLabs, then Piper on your server; the phone's own voice is the last resort.
 * Tamil script is read by the Tamil voice, English and Tanglish by the English one.
 */
export const NATURAL_VOICES = [
  {
    id: "ta-male",
    name: "Male",
    lang: "ta",
    gender: "male",
    cartesia: "19f28c21-ae34-499f-b64a-f7b09cd9b516",
    elevenlabs: "nPczCjzI2devNBz1zQrb",
    piper: "ta_IN-ValluvarNeural-medium",
  },
  {
    id: "ta-female",
    name: "Female",
    lang: "ta",
    gender: "female",
    cartesia: "fb7d8d97-9730-4165-bd79-36b5ce61b5f2",
    elevenlabs: "EXAVITQu4vr4xnSDxMaL",
    piper: "ta_IN-HemaLatha-medium",
  },
  {
    id: "en-male-1",
    name: "Male 1",
    lang: "en",
    gender: "male",
    cartesia: "39d518b7-fd0b-4676-9b8b-29d64ff31e12",
    elevenlabs: "nPczCjzI2devNBz1zQrb",
    piper: "en_US-kusal-medium",
  },
  {
    id: "en-male-2",
    name: "Male 2",
    lang: "en",
    gender: "male",
    cartesia: "c63361f8-d142-4c62-8da7-8f8149d973d6",
    elevenlabs: "onwK4e9ZLuTAKqWW03F9",
    piper: "en_US-kusal-medium",
  },
  {
    id: "en-female-1",
    name: "Female 1",
    lang: "en",
    gender: "female",
    cartesia: "7ea5e9c2-b719-4dc3-b870-5ba5f14d31d8",
    elevenlabs: "EXAVITQu4vr4xnSDxMaL",
    piper: "en_US-amy-medium",
  },
  {
    id: "en-female-2",
    name: "Female 2",
    lang: "en",
    gender: "female",
    cartesia: "f6141af3-5f94-418c-80ed-a45d450e7e2e",
    elevenlabs: "Xb7hH8MSUJpSbSDYk0k2",
    piper: "en_US-amy-medium",
  },
] as const;
export type NaturalVoice = (typeof NATURAL_VOICES)[number];

/** `true` uses the default voices; or name one natural voice per language. */
export const Speak = z.union([
  z.boolean(),
  z.object({ ta: z.string().max(40).optional(), en: z.string().max(40).optional() }),
]);
export type Speak = z.infer<typeof Speak>;

/** Something said to Malves, the assistant. Android's other guesses help it understand. */
export const AssistantSay = z.object({
  type: z.literal("assistant.say"),
  command_id: Id,
  conversation_id: Id,
  text: z.string().min(1).max(2000),
  alternatives: z.array(z.string().max(500)).max(5).optional(),
  /** What's on the phone's screen, e.g. "Task: add tests (Claude, running)": for "stop this one". */
  where: z.string().max(500).optional(),
  /** Also speak the reply in Malves' natural voice, sentence by sentence, as `assistant.audio`. */
  speak: Speak.optional(),
});

/** Yes or no to the action Malves read back (Confirm / Cancel buttons). */
export const AssistantConfirm = z.object({
  type: z.literal("assistant.confirm"),
  command_id: Id,
  conversation_id: Id,
  pending_id: Id,
  yes: z.boolean(),
  /** Also speak the reply in Malves' natural voice, sentence by sentence, as `assistant.audio`. */
  speak: Speak.optional(),
});

/** One piece of a photo for Malves (JPEG, in order, ≤ 96 KB each). */
export const ImageChunk = z.object({
  type: z.literal("image.chunk"),
  command_id: Id,
  upload_id: Id,
  index: z.number().int().min(0).max(40),
  data: z.string().max(131_072),
});

/** "Look at this": Malves looks at an uploaded photo and answers (in `ack.assistant`). */
export const AssistantLook = z.object({
  type: z.literal("assistant.look"),
  command_id: Id,
  conversation_id: Id,
  upload_id: Id,
  question: z.string().max(500).optional(),
  /** Also speak the reply in Malves' natural voice, sentence by sentence, as `assistant.audio`. */
  speak: Speak.optional(),
});

/** What Malves remembers (answered in `ack.memories`). */
export const MemoryList = z.object({ type: z.literal("memory.list"), command_id: Id });

/** Delete one memory for good. */
export const MemoryForget = z.object({
  type: z.literal("memory.forget"),
  command_id: Id,
  memory_id: Id,
});

/** Ask an open IDE's own agent to do something (VS Code starts it; Cursor pre-fills it). */
export const IdeAgent = z.object({
  type: z.literal("ide.agent"),
  command_id: Id,
  ide_id: Id,
  prompt: z.string().min(1).max(8_000),
});

/** Open a finished task's changed files, as diffs, in an open IDE. */
export const IdeOpenChanges = z.object({
  type: z.literal("ide.open_changes"),
  command_id: Id,
  ide_id: Id,
  task_id: Id,
});

/** Back at the desk: reopen an agent conversation in the IDE's terminal. */
export const IdeResume = z.object({
  type: z.literal("ide.resume"),
  command_id: Id,
  ide_id: Id,
  workspace_id: Id,
  agent: Id,
  // Only letters, digits and . _ : - — it ends up on a terminal command line.
  session_id: z.string().regex(/^[\w.:-]{1,128}$/),
});

/** One piece of a voice recording for precise mode (in order, ≤ 96 KB of audio each). */
export const VoiceChunk = z.object({
  type: z.literal("voice.chunk"),
  command_id: Id,
  upload_id: Id,
  index: z.number().int().min(0).max(100),
  data: z.string().max(131_072),
});

/** Transcribe a finished recording with Whisper (answered in `ack.result`). */
export const VoiceTranscribe = z.object({
  type: z.literal("voice.transcribe"),
  command_id: Id,
  upload_id: Id,
  /** e.g. "en", "ta". */
  language: z.string().min(2).max(8),
});

/** One picture of the computer's screen (answered in `ack.frame`); the computer says when a phone starts watching. */
export const ScreenFrame = z.object({ type: z.literal("screen.frame"), command_id: Id });

/**
 * You, controlling the computer from the phone: a click where you tapped (x and y
 * are fractions of the picture), scrolling, typing or a key combination.
 */
export const ScreenInput = z.object({
  type: z.literal("screen.input"),
  command_id: Id,
  action: z.enum(["move", "click", "double", "right", "scroll", "type", "keys"]),
  x: z.number().min(0).max(1).optional(),
  y: z.number().min(0).max(1).optional(),
  lines: z.number().int().min(-20).max(20).optional(),
  text: z.string().max(500).optional(),
  keys: z.string().max(40).optional(),
});
export type ScreenInput = z.infer<typeof ScreenInput>;

/** Live video of the screen (WebRTC): the phone's offer; the answer is in `ack.video`. */
export const ScreenVideo = z.object({
  type: z.literal("screen.video"),
  command_id: Id,
  sdp: z.string().min(1).max(20_000),
});

/** The phone stopped watching: stop the video. */
export const ScreenVideoStop = z.object({ type: z.literal("screen.video.stop"), command_id: Id });

/** This phone's Firebase token, so Malves can ring it (a call; the push carries no content). */
export const CallRegister = z.object({
  type: z.literal("call.register"),
  command_id: Id,
  token: z.string().min(1).max(4096),
});

/** You answered Malves' call: why it called is in `ack.result`. */
export const CallAnswer = z.object({
  type: z.literal("call.answer"),
  command_id: Id,
  call_id: Id,
  /** Also say it in Malves' natural voice, as `assistant.audio`. */
  speak: Speak.optional(),
});

/** You declined Malves' call. */
export const CallDecline = z.object({
  type: z.literal("call.decline"),
  command_id: Id,
  call_id: Id,
});

/**
 * Say this in Malves' natural voice (questions, results, short replies the phone
 * writes itself); the audio comes back as `assistant.audio`, exactly as written.
 */
export const VoiceSpeak = z.object({
  type: z.literal("voice.speak"),
  command_id: Id,
  text: z.string().min(1).max(2000),
  speak: Speak,
});

/** A test call from Settings (rings even in quiet hours). */
export const CallTest = z.object({ type: z.literal("call.test"), command_id: Id });

/** Take the computer back from Malves (handover mode). */
export const HandoverStop = z.object({ type: z.literal("handover.stop"), command_id: Id });

/** Breakglass: stop every running task now (§8). */
export const TasksStopAll = z.object({ type: z.literal("tasks.stop_all"), command_id: Id });

/** Re-check which agents are ready, e.g. right after signing in on the computer. */
export const AgentsCheck = z.object({ type: z.literal("agents.check"), command_id: Id });

/** Fetch this week's leads from the lead engine, through the computer. */
export const LeadsRefresh = z.object({ type: z.literal("leads.refresh"), command_id: Id });

/** Things the phone asks the runner to do. Each is acknowledged once, by `command_id`. */
export const Command = z.discriminatedUnion("type", [
  TaskCreate,
  TaskReply,
  SessionsList,
  SessionsAll,
  SessionRead,
  SessionContinue,
  ChangesDiff,
  AnswerCommand,
  TaskStop,
  TasksStopAll,
  HandoverStop,
  ScreenFrame,
  ScreenInput,
  ScreenVideo,
  ScreenVideoStop,
  CallRegister,
  CallAnswer,
  CallDecline,
  CallTest,
  VoiceSpeak,
  VoiceChunk,
  VoiceTranscribe,
  AssistantSay,
  AssistantConfirm,
  ImageChunk,
  AssistantLook,
  MemoryList,
  MemoryForget,
  IdeAgent,
  IdeOpenChanges,
  IdeResume,
  AgentsCheck,
  LeadsRefresh,
]);
export type Command = z.infer<typeof Command>;

// ── Runner → phone, sealed ──────────────────────────────────────────────────

/** Whether an agent can take a task right now, as last checked on the computer. */
export const AgentState = z.enum(["checking", "ready", "needs_sign_in", "unavailable"]);
export type AgentState = z.infer<typeof AgentState>;

export const AgentInfo = z.object({
  name: z.string(),
  /** e.g. "Claude" */
  label: z.string(),
  state: AgentState,
  /** What the user can do about it, in plain words. */
  hint: z.string().optional(),
  /** Its model calls go through the budget guard, so the phone can show model and tokens. */
  metered: z.boolean().optional(),
});
export type AgentInfo = z.infer<typeof AgentInfo>;

/** An IDE window open on the computer, and the projects it shows (names only, no paths). */
export const IdeInfo = z.object({
  id: Id,
  /** e.g. "Visual Studio Code", "Cursor", "Antigravity". */
  app: z.string().max(60),
  projects: z.array(z.object({ name: z.string().max(200), workspace_id: Id.optional() })).max(20),
});
export type IdeInfo = z.infer<typeof IdeInfo>;

/** Whether Malves has the computer (handover mode), since when, until when; or why it ended. */
export const HandoverState = z.object({
  active: z.boolean(),
  since: z.number().int().optional(),
  until: z.number().int().optional(),
  reason: z.string().max(200).optional(),
});
export type HandoverState = z.infer<typeof HandoverState>;

export const Welcome = z.object({
  type: z.literal("welcome"),
  v: z.number().int(),
  device_id: Id,
  computer: z.string(),
  workspaces: z.array(z.object({ id: Id, name: z.string() })),
  agents: z.array(AgentInfo),
  last_seq: z.number().int().min(0),
  /** Notifications: an `ntfy://` link that subscribes the phone's ntfy app. Only over Tailscale. */
  push: z.object({ subscribe: z.string().max(300) }).optional(),
  /** Whether the Chrome extension is connected, so browser tasks can work. */
  chrome: z.boolean().optional(),
  /** Handover mode, when Malves is set up. */
  handover: HandoverState.optional(),
  /** Whether precise (Whisper) dictation is set up on the computer. */
  transcribe: z.boolean().optional(),
  /** Whether Malves, the assistant, is set up (its brain reachable). */
  assistant: z.boolean().optional(),
  /** IDE windows open on the computer, with malves' IDE extension. */
  ides: z.array(IdeInfo).max(20).optional(),
});
export type Welcome = z.infer<typeof Welcome>;

/** What a running task's agent is doing right now, e.g. "Read index.html". Live only, never logged. */
export const ActivityMessage = z.object({
  type: z.literal("activity"),
  task_id: Id,
  text: z.string().max(500),
  at: z.number().int(),
});

/** Sent when IDE windows open, close or change project. */
export const IdesMessage = z.object({ type: z.literal("ides"), ides: z.array(IdeInfo).max(20) });

/** Sent when Chrome connects or disconnects. */
export const ChromeMessage = z.object({ type: z.literal("chrome"), connected: z.boolean() });

/**
 * Malves' spoken reply, one sentence (`part`) at a time, each in pieces
 * (`index`, `last`). `failed` means the phone says `text` in its own voice;
 * `done` (with no data) means there are no more sentences.
 */
export const AssistantAudio = z.object({
  type: z.literal("assistant.audio"),
  command_id: Id,
  index: z.number().int().min(0),
  last: z.boolean(),
  mime: z.string().max(40),
  data: z.string().max(131_072),
  failed: z.string().max(200).optional(),
  part: z.number().int().min(0).max(200).optional(),
  text: z.string().max(2000).optional(),
  lang: z.enum(["ta", "en"]).optional(),
  done: z.boolean().optional(),
  /** Said once when a voice runs out for the month, e.g. "Cartesia is used up; using ElevenLabs." */
  note: z.string().max(200).optional(),
});

/** Sent when handover mode starts or ends. */
export const HandoverMessage = z.object({ type: z.literal("handover"), state: HandoverState });

/** Sent whenever an agent's readiness changes. */
export const AgentsMessage = z.object({ type: z.literal("agents"), agents: z.array(AgentInfo) });

export const EventMessage = z.object({ type: z.literal("event"), event: LoggedEvent });

/** One saved conversation an agent can continue. */
export const AgentSessionInfo = z.object({
  id: z.string(),
  title: z.string().optional(),
  /** ISO 8601. Recent means it may still be open on the computer. */
  updated_at: z.string().optional(),
});
export type AgentSessionInfo = z.infer<typeof AgentSessionInfo>;

export const Ack = z.object({
  type: z.literal("ack"),
  command_id: Id,
  ok: z.boolean(),
  /** e.g. the new task's id, or how an answer was applied. */
  result: z.string().optional(),
  error: z.string().optional(),
  /** The answer to `sessions.all`. */
  all_sessions: z
    .array(
      z.object({
        tool: SessionTool,
        id: z.string(),
        title: z.string(),
        folder: z.string().optional(),
        updated_at: z.number(),
        how: z.enum(["resume", "bridge", "new"]),
        source: z.string().optional(),
      }),
    )
    .optional(),
  folders: z
    .array(z.object({ path: z.string(), name: z.string(), last_used: z.number() }))
    .optional(),
  /** The answer to `session.read`. */
  messages: z.array(z.object({ who: z.enum(["you", "agent"]), text: z.string() })).optional(),
  /** A task this command started, e.g. by continuing a session. */
  task_id: z.string().optional(),
  /** The answer to `sessions.list`. */
  sessions: z.array(AgentSessionInfo).optional(),
  /** Malves' answer to `assistant.say` / `assistant.confirm`. */
  assistant: z
    .object({
      reply: z.string(),
      pending: z.object({ id: Id, summary: z.string() }).optional(),
      did: z.array(z.string()),
      offline: z.boolean().optional(),
      /** Skills from his library the reply drew on. */
      skills: z.array(z.string().max(80)).max(4).optional(),
    })
    .optional(),
  /** The answer to `screen.video`: the computer's WebRTC answer and the screen's size. */
  video: z
    .object({ sdp: z.string().max(20_000), width: z.number().int(), height: z.number().int() })
    .optional(),
  /** The answer to `screen.frame`: a JPEG of the screen. */
  frame: z
    .object({ jpeg: z.string().max(400_000), width: z.number().int(), height: z.number().int() })
    .optional(),
  /** The answer to `memory.list`. */
  memories: z
    .array(
      z.object({
        id: z.string(),
        kind: z.string(),
        title: z.string(),
        text: z.string(),
        since: z.string(),
      }),
    )
    .optional(),
});
export type Ack = z.infer<typeof Ack>;

/** This week's leads, sent after `leads.refresh`. Not logged: it's the lead engine's data. */
export const LeadsMessage = z.object({
  type: z.literal("leads"),
  leads: z.array(Lead),
  fetched_at: z.number().int(),
});

export const RunnerMessage = z.discriminatedUnion("type", [
  Welcome,
  AgentsMessage,
  ChromeMessage,
  IdesMessage,
  HandoverMessage,
  AssistantAudio,
  ActivityMessage,
  LeadsMessage,
  EventMessage,
  Ack,
]);
export type RunnerMessage = z.infer<typeof RunnerMessage>;

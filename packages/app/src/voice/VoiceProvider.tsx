import { type LinkClient, type LinkStatus, randomToken } from "@malves/protocol";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  isFinished,
  type Model,
  needsYou,
  pickAgent,
  type Question,
  running,
  workspaceName,
} from "../model";
import { buzz } from "../ui";
import { type ReplyAudio, replyAudio } from "./audioInbox";
import { callHandled, onAnsweredCall, registerForCalls, whenUnlocked } from "./calls";
import {
  canListen,
  canRecord,
  discardRecording,
  type Heard,
  type Lang,
  listen,
  playClip,
  readAudio,
  speak,
  stopListening,
  stopSpeaking,
  watchForInterruption,
} from "./engine";
import { type Intent, type Context as IntentContext, interpret } from "./intent";
import { COMMAND_HINTS, phrases } from "./phrases";
import {
  DEFAULT_VOICE,
  loadVoiceSettings,
  saveVoiceSettings,
  type VoiceSettings,
} from "./settings";

/**
 * Voice mode: malves reads questions aloud, listens, and acts — hands-free
 * until "stop listening", or one turn at a time with the mic buttons.
 *
 * When Malves (the assistant) is set up on the computer, what you say goes to
 * its brain, which understands loose speech; the fixed rules below are the
 * fallback when it's off or unreachable. When Android isn't sure what it
 * heard, the recording goes to Whisper on the computer for a second opinion.
 *
 * Safety, as everywhere in malves:
 * - silence never answers anything; an unclear or unsure sentence is asked again;
 * - a high-risk answer is read back and needs "confirm";
 * - starting or stopping a task is read back and needs "start"/"confirm".
 */
export type Phase = "idle" | "speaking" | "listening" | "working";
/** How a natural-voice reply went: nothing arrived, played through, or talked over. */
type Played = "none" | "done" | "interrupted";

type Pending =
  | { kind: "answer"; question: Question; choiceId: string; label: string }
  | { kind: "task"; workspaceId: string; agent: string; prompt: string }
  | { kind: "stop"; taskId: string };

/** One line of the conversation with Malves. */
/** `from`: skills from his library that Malves' reply drew on. */
export type Line = { who: "you" | "malves"; text: string; at: number; from?: string[] | undefined };
/** Lines kept on the phone for this session. */
const MAX_LINES = 100;

type Voice = {
  /** This session's conversation, oldest first. */
  log: Line[];
  canListen: boolean;
  /** Precise dictation: the phone can record, and the computer can transcribe. */
  canBePrecise: boolean;
  settings: VoiceSettings;
  setSettings: (settings: VoiceSettings) => void;
  mode: boolean;
  phase: Phase;
  /** What malves heard (live while you speak). */
  heard: string;
  /** What malves last said. */
  said: string;
  problem: string | undefined;
  /** An action Malves read back and is waiting on (Confirm / Cancel buttons). */
  pending: { id: string; summary: string } | undefined;
  confirmPending: (yes: boolean) => void;
  toggleMode: () => void;
  /** One turn: a command, or an answer to the oldest question. */
  talk: () => void;
  /** One turn answering this question. */
  answer: (question: Question) => void;
  readAloud: (text: string) => void;
  /** Says something to Malves from a button (no mic). */
  tell: (text: string) => void;
  /** Shows Malves a photo; it says what it sees. */
  look: (jpegBase64: string, question: string) => Promise<void>;
  /** Malves is set up on the computer and reachable. */
  assistantOn: boolean;
  /** Dictation into a text box; `onText` gets the words live, then the final text. */
  dictate: (onText: (text: string) => void) => Promise<void>;
  stopDictation: () => void;
  /** Stops talking and listening at once. */
  hush: () => void;
  /** Why calls can't reach this phone, if they can't (undefined: they can). */
  callsProblem: string | undefined;
  testCall: () => Promise<string>;
};

const VoiceContext = createContext<Voice | undefined>(undefined);

export function useVoice(): Voice {
  const voice = useContext(VoiceContext);
  if (!voice) throw new Error("useVoice outside VoiceProvider");
  return voice;
}

/** Silence this long ends hands-free mode. */
const IDLE_MS = 2 * 60_000;
/** Below this, the recognizer wasn't sure: ask again. */
const SURE = 0.4;
/** Said in hands-free mode, these never need the brain. */
const LOCAL_ONLY = new Set<Intent["kind"]>(["stopListening", "repeat", "more", "help"]);
/** How much of a result is read at once; "more" reads the next part. */
const READ_CHUNK = 500;

export function VoiceProvider({
  model,
  client,
  status,
  lastAgent,
  onCall,
  where,
  children,
}: {
  model: Model;
  client: LinkClient | undefined;
  status: LinkStatus;
  lastAgent: string | undefined;
  /** A call from Malves was answered: show the Malves screen. */
  onCall: () => void;
  /** What's on the screen now, so Malves knows what "this one" is. */
  where?: string | undefined;
  children: ReactNode;
}) {
  const [settings, setSettingsState] = useState<VoiceSettings>(DEFAULT_VOICE);
  const [mode, setMode] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [heard, setHeard] = useState("");
  const [said, setSaid] = useState("");
  const [problem, setProblem] = useState<string>();
  const [pending, setPendingState] = useState<{ id: string; summary: string }>();
  const [log, setLog] = useState<Line[]>([]);
  const note = (who: Line["who"], text: string) => {
    // The next reply line carries the skills it drew on (set just before it's said).
    const from = who === "malves" ? live.current.from : undefined;
    if (who === "malves") live.current.from = undefined;
    setLog((lines) => [...lines, { who, text, at: Date.now(), from }].slice(-MAX_LINES));
  };
  // One conversation per app session: Malves keeps its short-term context per id.
  const conversationId = useRef(`app-${Date.now().toString(36)}`).current;

  // The conversation runs across awaits: it reads the latest state from here.
  const live = useRef({
    model,
    client,
    status,
    lastAgent,
    settings,
    mode: false,
    /** Bumped to abandon whatever turn is in progress. */
    turn: 0,
    pending: undefined as Pending | undefined,
    /** Malves' read-back action, decided on the computer. */
    brainPending: undefined as { id: string; summary: string } | undefined,
    lastSaid: "",
    where: undefined as string | undefined,
    /** Malves was talked over: listen next, whatever the mode. */
    interrupted: false,
    /** Skills the reply being said drew on. */
    from: undefined as string[] | undefined,
    reading: { text: "", offset: 0 },
    /** Questions already read out or answered, so they aren't read twice. */
    handled: new Set<string>(),
    quietSince: Date.now(),
    /** When hands-free mode was turned on: only tasks finishing after that are announced. */
    modeSince: Date.now(),
    announced: new Set<string>(),
  });
  Object.assign(live.current, { model, client, status, lastAgent, settings, where });

  useEffect(() => {
    void loadVoiceSettings().then(setSettingsState);
  }, []);
  const setSettings = useCallback((next: VoiceSettings) => {
    setSettingsState(next);
    void saveVoiceSettings(next);
  }, []);

  const P = () => phrases(live.current.settings.lang);
  /** Agent text (questions, results) is English: read it in the matching English voice. */
  const englishVoice = (): Lang => (live.current.settings.lang === "en-US" ? "en-US" : "en-IN");

  /**
   * Everything Malves says (questions, results, short replies) is said in its
   * natural voice. The phone's own voice only when that's chosen in Settings,
   * or when the computer can't be reached.
   */
  const sayIt = async (text: string, lang: Lang = P().voice) => {
    const L = live.current;
    setPhase("speaking");
    setSaid(text);
    note("malves", text);
    L.lastSaid = text;
    const c = L.client;
    if (L.settings.natural && c && L.status === "online") {
      const id = L.turn;
      const voice = startReply(id);
      const sent = await c.speakText(text, speakAs(), voice.commandId).then(
        (ack) => ack.ok,
        () => false,
      );
      if (!sent) voice.cancel();
      const how = (await voice.playing) ?? "none";
      if (how === "interrupted") L.interrupted = true;
      if (how !== "none" || id !== L.turn) return;
    }
    await speak(text, lang, L.settings.voices[lang]);
  };

  /** How Malves is asked to sound: its natural voices, or not at all (the phone speaks). */
  const speakAs = () => {
    const s = live.current.settings;
    return s.natural ? s.naturalVoices : false;
  };

  /**
   * Plays Malves' reply a sentence at a time as it arrives (a sentence no
   * natural voice could say is read by the phone). With interruptions on, the
   * mic listens meanwhile: talking over Malves cuts it short.
   */
  const playReply = async (audio: ReplyAudio, id: number): Promise<Played> => {
    const L = live.current;
    let played = 0;
    let spoken = "";
    let interrupted = false;
    let unwatch = () => {};
    for (;;) {
      const clip = await audio.next();
      if (!clip || id !== L.turn || interrupted) break;
      if (played === 0) {
        stopSpeaking(); // the "one sec" filler, if it's still going
        if (L.settings.bargeIn && canListen()) {
          unwatch = watchForInterruption(
            L.settings.lang,
            () => spoken,
            () => {
              interrupted = true;
              stopSpeaking();
            },
          );
        }
      }
      played += 1;
      spoken += ` ${clip.text}`;
      if (clip.note) note("malves", clip.note);
      setPhase("speaking");
      if (clip.failed) {
        const lang: Lang = clip.lang === "ta" ? "ta-IN" : englishVoice();
        await speak(clip.text, lang, L.settings.voices[lang]);
      } else await playClip(clip.data, clip.mime);
      if (interrupted) break;
    }
    unwatch();
    audio.cancel();
    return interrupted ? "interrupted" : played > 0 ? "done" : "none";
  };

  /** Starts listening for a reply's natural voice before the command is even sent. */
  const startReply = (id: number) => {
    if (!live.current.settings.natural) {
      return { commandId: undefined, playing: undefined, cancel: () => {} };
    }
    const commandId = randomToken(12);
    const audio = replyAudio(commandId);
    return { commandId, playing: playReply(audio, id), cancel: () => audio.cancel() };
  };

  /** Malves' reply: shown at once; heard in the natural voice as it streams, else the phone's. */
  const sayReply = async (text: string, playing: Promise<Played> | undefined, id: number) => {
    if (!playing) return sayIt(text, voiceFor(text));
    note("malves", text);
    setSaid(text);
    live.current.lastSaid = text;
    const how = await playing;
    if (id !== live.current.turn) return;
    if (how === "none") {
      setPhase("speaking");
      const lang = voiceFor(text);
      await speak(text, lang, live.current.settings.voices[lang]);
    }
    live.current.interrupted = how === "interrupted";
  };

  const setBrainPending = (next: { id: string; summary: string } | undefined) => {
    live.current.brainPending = next;
    setPendingState(next);
  };

  /** Malves' brain is there to talk to. */
  const brainOn = () =>
    live.current.model.assistant && live.current.status === "online" && !!live.current.client;

  /** Tamil script is read in the Tamil voice; English and Tanglish in the English one. */
  const voiceFor = (text: string): Lang =>
    /[\u0B80-\u0BFF]/.test(text) ? "ta-IN" : englishVoice();

  /** Whisper's reading of a recording, or undefined. */
  const whisper = async (uri: string): Promise<string | undefined> => {
    const c = live.current.client;
    if (!c) return undefined;
    try {
      const ack = await c.transcribe(await readAudio(uri), live.current.settings.lang.slice(0, 2));
      return ack.ok && ack.result?.trim() ? ack.result.trim() : undefined;
    } catch {
      return undefined;
    }
  };

  /**
   * Sends what was said to Malves and speaks its reply. False when the brain
   * couldn't answer, so the caller falls back to the rules.
   */
  const think = async (text: string, alternatives: string[], id: number): Promise<boolean> => {
    const c = live.current.client;
    if (!c) return false;
    setPhase("working");
    // A short filler if the brain is slow, so silence doesn't feel like a hang.
    const slow = setTimeout(() => {
      if (id === live.current.turn) void sayIt(P().oneSec);
    }, 1500);
    let reply: Awaited<ReturnType<LinkClient["assistantSay"]>>["assistant"];
    const voice = startReply(id);
    try {
      const ack = await c.assistantSay(
        conversationId,
        text,
        alternatives,
        speakAs(),
        voice.commandId,
        live.current.where,
      );
      reply = ack.ok ? ack.assistant : undefined;
    } catch {
      reply = undefined;
    } finally {
      clearTimeout(slow);
    }
    if (id !== live.current.turn || !reply || reply.offline) voice.cancel();
    if (id !== live.current.turn) return true;
    if (!reply || reply.offline) return false;
    setBrainPending(reply.pending);
    if (reply.did.length > 0) buzz();
    live.current.from = reply.skills;
    await sayReply(reply.reply, voice.playing, id);
    return true;
  };

  /** After Malves spoke: its read-back or its question gets an answer, else carry on. */
  const afterThink = (id: number) => {
    const L = live.current;
    if (L.interrupted) {
      L.interrupted = false;
      return turn("command", undefined, id);
    }
    if (L.brainPending || L.lastSaid.trim().endsWith("?")) return turn("command", undefined, id);
    return next(id);
  };

  const hints = (question?: Question) => [
    ...live.current.model.agents.map((a) => a.label),
    ...live.current.model.workspaces.map((w) => w.name),
    ...(question?.choices.map((c) => c.label) ?? []),
    ...COMMAND_HINTS,
  ];

  const stopMode = async (announce = true) => {
    live.current.mode = false;
    live.current.pending = undefined;
    setMode(false);
    stopListening();
    if (announce) await sayIt(P().off);
    setPhase("idle");
  };

  /** Listens once and acts on what was heard. */
  const turn = async (
    awaiting: IntentContext["awaiting"],
    question?: Question,
    id = live.current.turn,
  ): Promise<void> => {
    if (id !== live.current.turn) return;
    if (!canListen()) {
      setProblem("Listening needs the malves app (APK). In Expo Go, malves can only read aloud.");
      setPhase("idle");
      return;
    }
    setPhase("listening");
    setHeard("");
    let result: Heard;
    try {
      result = await listen({
        lang: live.current.settings.lang,
        hints: hints(question),
        record: canRecord() && live.current.model.transcribe && live.current.status === "online",
        onPartial: setHeard,
      });
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      await stopMode(false);
      return;
    }
    const unsure = result.confidence !== undefined && result.confidence < SURE;
    // The recording only serves Whisper's second listen when Android was unsure; never kept.
    if (id !== live.current.turn || !result.text || !unsure) discardRecording(result.audioUri);
    if (id !== live.current.turn) return;
    setHeard(result.text);
    if (!result.text) {
      // Silence: hands-free keeps listening for a while; nothing is ever answered by it.
      if (live.current.mode && Date.now() - live.current.quietSince < IDLE_MS) {
        return turn(awaiting, question, id);
      }
      if (live.current.mode) return stopMode();
      setPhase("idle");
      return;
    }
    live.current.quietSince = Date.now();
    let text = result.text;
    note("you", text);
    if (unsure) {
      // Not sure: Whisper gets a second listen; the brain copes with the rest.
      const better = result.audioUri ? await whisper(result.audioUri) : undefined;
      discardRecording(result.audioUri);
      if (id !== live.current.turn) return;
      if (better) {
        text = better;
        setHeard(text);
      } else if (!brainOn()) {
        await sayIt(P().unsure(result.text));
        return turn(awaiting, question, id);
      }
    }
    const intent = interpret(text, {
      awaiting,
      ...(question ? { choices: question.choices } : {}),
      agents: live.current.model.agents.filter((a) => a.state === "ready"),
      workspaces: live.current.model.workspaces,
    });
    // Phone-only commands stay local; a local read-back waits for its own yes/no.
    const toBrain =
      brainOn() &&
      (awaiting === "command"
        ? !LOCAL_ONLY.has(intent.kind)
        : awaiting === "answer" && intent.kind === "unknown");
    if (toBrain) {
      const alternatives = result.alternatives.filter((a) => a !== text);
      if (text !== result.text) alternatives.unshift(result.text);
      if (await think(text, alternatives, id)) return afterThink(id);
    }
    await act(intent, awaiting, question, id);
  };

  /** Reads a question and waits for the answer. */
  const ask = async (question: Question, id: number) => {
    const { model: m } = live.current;
    live.current.handled.add(question.id);
    const agent =
      m.agents.find((a) => a.name === m.tasks[question.taskId]?.agent)?.label ?? "The agent";
    await sayIt(P().asks(agent));
    if (id !== live.current.turn) return;
    await sayIt(question.text, englishVoice());
    if (id !== live.current.turn) return;
    await sayIt(
      `${question.risk === "high" ? `${P().highRisk} ` : ""}${P().say(question.choices.map((c) => c.label))}`,
    );
    await turn("answer", question, id);
  };

  /** After an action: next question, or (hands-free) the next command. */
  const next = async (id: number) => {
    if (id !== live.current.turn) return;
    if (!live.current.mode) {
      setPhase("idle");
      return;
    }
    const waiting = needsYou(live.current.model).find((q) => !live.current.handled.has(q.id));
    if (waiting) return ask(waiting, id);
    return turn("command", undefined, id);
  };

  const send = async (
    run: (
      c: LinkClient,
    ) => Promise<{ ok: boolean; error?: string | undefined; result?: string | undefined }>,
    success: string,
  ) => {
    const c = live.current.client;
    if (!c) return;
    setPhase("working");
    const offline = live.current.status !== "online";
    const sending = run(c);
    if (offline) {
      void sending.catch(() => {});
      await sayIt(P().offline);
      return;
    }
    try {
      const ack = await sending;
      if (ack.ok) {
        buzz();
        await sayIt(success);
      } else await sayIt(P().problem(ack.error ?? ack.result ?? "not applied"));
    } catch (error) {
      await sayIt(P().problem(error instanceof Error ? error.message : String(error)));
    }
  };

  const readNext = async () => {
    const r = live.current.reading;
    if (!r.text || r.offset >= r.text.length) return sayIt(r.text ? P().end : P().noResult);
    let end = Math.min(r.text.length, r.offset + READ_CHUNK);
    // Stop at a sentence end where possible.
    const stop = r.text.lastIndexOf(". ", end);
    if (end < r.text.length && stop > r.offset + 100) end = stop + 1;
    const part = r.text.slice(r.offset, end);
    r.offset = end;
    await sayIt(part, englishVoice());
    if (r.offset < r.text.length) await sayIt(P().more);
  };

  const lastFinished = () =>
    Object.values(live.current.model.tasks)
      .filter(isFinished)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];

  const act = async (
    intent: Intent,
    awaiting: IntentContext["awaiting"],
    question: Question | undefined,
    id: number,
  ): Promise<void> => {
    const L = live.current;
    const p = P();
    switch (intent.kind) {
      case "answer": {
        if (!question) break;
        if (question.risk === "high") {
          L.pending = { kind: "answer", question, choiceId: intent.choiceId, label: intent.label };
          await sayIt(p.confirmAnswer(intent.label));
          return turn("confirm", undefined, id);
        }
        await send((c) => c.answer({ questionId: question.id, choiceId: intent.choiceId }), p.done);
        return next(id);
      }
      case "confirm": {
        const pending = L.pending;
        L.pending = undefined;
        if (!pending) {
          await sayIt(p.sorry);
          return next(id);
        }
        if (pending.kind === "answer") {
          await send(
            (c) => c.answer({ questionId: pending.question.id, choiceId: pending.choiceId }),
            p.done,
          );
        } else if (pending.kind === "task") {
          await send(
            (c) =>
              c.createTask({
                workspaceId: pending.workspaceId,
                agent: pending.agent,
                prompt: pending.prompt,
              }),
            p.started,
          );
        } else {
          await send((c) => c.stopTask(pending.taskId), p.stopped);
        }
        return next(id);
      }
      case "cancel":
        L.pending = undefined;
        await sayIt(p.cancelled);
        return next(id);
      case "newTask": {
        const workspaceId = intent.workspaceId ?? L.model.workspaces[0]?.id;
        const agent = intent.agent ?? pickAgent(L.model.agents, L.lastAgent);
        if (!workspaceId) await sayIt(p.noProject);
        else if (!agent) await sayIt(p.noAgent);
        else {
          L.pending = { kind: "task", workspaceId, agent, prompt: intent.prompt };
          const label = L.model.agents.find((a) => a.name === agent)?.label ?? agent;
          await sayIt(p.startTask(intent.prompt, workspaceName(L.model, workspaceId), label));
          return turn("confirm", undefined, id);
        }
        return next(id);
      }
      case "needs": {
        const waiting = needsYou(L.model);
        if (waiting[0]) return ask(waiting[0], id);
        await sayIt(p.nothing);
        return next(id);
      }
      case "running": {
        const active = running(L.model);
        await sayIt(p.running(active.length));
        for (const t of active.slice(0, 3)) {
          const now = L.model.activity[t.id]?.at(-1)?.text;
          await sayIt(`${t.prompt.slice(0, 80)}${now ? `. Now: ${now}` : ""}.`, englishVoice());
        }
        return next(id);
      }
      case "result": {
        const task = lastFinished();
        L.reading = { text: task?.result ?? "", offset: 0 };
        await readNext();
        return next(id);
      }
      case "more":
        await readNext();
        return next(id);
      case "stopTask": {
        const active = running(L.model);
        if (active.length === 0) await sayIt(p.running(0));
        else if (active.length > 1) await sayIt(p.stopWhich);
        else if (active[0]) {
          L.pending = { kind: "stop", taskId: active[0].id };
          await sayIt(p.confirmStop(active[0].prompt.slice(0, 80)));
          return turn("confirm", undefined, id);
        }
        return next(id);
      }
      case "reply": {
        const task = lastFinished();
        if (!task?.sessionId) await sayIt(p.nothingToReply);
        else await send((c) => c.reply(task.id, intent.text), p.sent);
        return next(id);
      }
      case "runAgain": {
        const task = lastFinished();
        if (!task) await sayIt(p.nothingToReply);
        else {
          await send(
            (c) =>
              c.createTask({
                workspaceId: task.workspaceId,
                agent: task.agent,
                prompt: task.prompt,
              }),
            p.started,
          );
        }
        return next(id);
      }
      case "leads": {
        if (!L.model.leads && L.client) {
          setPhase("working");
          await L.client.refreshLeads().catch(() => undefined);
          await new Promise((r) => setTimeout(r, 600));
        }
        const leads = L.model.leads?.list ?? [];
        if (leads.length === 0) await sayIt(p.noLeads);
        else {
          await sayIt(p.leads(leads.length, leads.filter((l) => l.tier === "hot").length));
          for (const lead of leads.slice(0, 3)) {
            await sayIt(`${lead.name}. ${lead.why}`, englishVoice());
          }
        }
        return next(id);
      }
      case "repeat":
        await sayIt(L.lastSaid);
        return awaiting === "command" ? next(id) : turn(awaiting, question, id);
      case "help":
        await sayIt(p.help);
        return awaiting === "command" ? next(id) : turn(awaiting, question, id);
      case "stopListening":
        return stopMode();
      case "unknown":
        await sayIt(p.sorry);
        if (question && awaiting === "answer")
          await sayIt(p.say(question.choices.map((c) => c.label)));
        // A question or a confirmation is asked again; a one-off command just ends.
        if (awaiting !== "command" || L.mode) return turn(awaiting, question, id);
        setPhase("idle");
        return;
    }
    return next(id);
  };

  /** Abandons the current turn and starts a new one. */
  const fresh = () => {
    live.current.turn += 1;
    live.current.pending = undefined;
    // A pending Malves action survives: it has its own buttons and expires on the computer.
    stopListening();
    stopSpeaking();
    setProblem(undefined);
    return live.current.turn;
  };

  /**
   * You answered Malves' call: it says why it called (in its natural voice),
   * then the conversation goes on hands-free, as if you'd turned voice mode on.
   */
  const answerCall = async (callId: string) => {
    const c = live.current.client;
    if (!c) return;
    callHandled(callId);
    const id = fresh();
    live.current.mode = true;
    live.current.quietSince = Date.now();
    live.current.modeSince = Date.now();
    setMode(true);
    setPhase("working");
    const voice = startReply(id);
    try {
      const ack = await c.answerCall(callId, speakAs(), voice.commandId);
      if (!ack.ok) {
        voice.cancel();
        await sayIt(ack.error ?? "That call is over.");
      } else await sayReply(ack.result ?? "", voice.playing, id);
    } catch {
      voice.cancel();
      await sayIt(P().problem("Couldn't reach the computer."));
    }
    if (id === live.current.turn) await afterThink(id);
  };

  // Calls: let the computer ring this phone, and pick up answered calls.
  const [callsProblem, setCallsProblem] = useState<string>();
  useEffect(() => {
    if (!client || status !== "online" || !model.assistant) return;
    void registerForCalls(client).then(setCallsProblem);
  }, [client, status, model.assistant]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: answerCall reads the latest state from live.current
  useEffect(() => {
    if (!client || status !== "online") return;
    return onAnsweredCall((callId) => {
      onCall();
      void whenUnlocked().then(() => answerCall(callId));
    });
  }, [client, status, onCall]);
  const testCall = async () => {
    const c = live.current.client;
    if (!c) return "Not connected to the computer.";
    try {
      const ack = await c.testCall();
      return ack.ok ? (ack.result ?? "Calling.") : (ack.error ?? "The computer couldn't call.");
    } catch {
      return "Couldn't reach the computer.";
    }
  };

  const toggleMode = () => {
    if (live.current.mode) {
      fresh();
      void stopMode();
      return;
    }
    const id = fresh();
    live.current.mode = true;
    live.current.quietSince = Date.now();
    live.current.modeSince = Date.now();
    live.current.handled.clear();
    setMode(true);
    void (async () => {
      const waiting = needsYou(live.current.model);
      await sayIt(P().on(waiting.length));
      if (waiting.length === 0) await sayIt(P().commandHint);
      await next(id);
    })();
  };

  const talk = () => {
    const id = fresh();
    const first = needsYou(live.current.model)[0];
    void (first ? turn("answer", first, id) : turn("command", undefined, id));
  };

  const answer = (question: Question) => {
    const id = fresh();
    void turn("answer", question, id);
  };

  /** Says something to Malves from a button instead of the mic. */
  const tell = (text: string) => {
    const id = fresh();
    note("you", text);
    void (async () => {
      if (await think(text, [], id)) await afterThink(id);
      else if (id === live.current.turn) {
        await sayIt(P().problem("Malves isn't reachable right now."));
        setPhase("idle");
      }
    })();
  };

  /** "Look at this": sends a photo (JPEG, base64) to Malves and speaks what it sees. */
  const look = async (jpegBase64: string, question: string) => {
    const c = live.current.client;
    if (!c) return;
    const id = fresh();
    note("you", question ? `(photo) ${question}` : "(photo)");
    setPhase("working");
    const voice = startReply(id);
    try {
      const ack = await c.assistantLook(
        conversationId,
        jpegBase64,
        question,
        speakAs(),
        voice.commandId,
      );
      if (id !== live.current.turn || !ack.assistant) voice.cancel();
      if (id !== live.current.turn) return;
      const reply = ack.assistant?.reply ?? ack.error ?? "I couldn't look at it.";
      await sayReply(reply, ack.assistant ? voice.playing : undefined, id);
    } catch (error) {
      voice.cancel();
      await sayIt(P().problem(error instanceof Error ? error.message : String(error)));
    }
    if (id === live.current.turn) await afterThink(id);
  };

  const readAloud = (text: string) => {
    fresh();
    void sayIt(text, voiceFor(text)).then(() => setPhase("idle"));
  };

  const confirmPending = (yes: boolean) => {
    const target = live.current.brainPending;
    const c = live.current.client;
    if (!target || !c) return;
    const id = fresh();
    setBrainPending(undefined);
    void (async () => {
      setPhase("working");
      const voice = startReply(id);
      try {
        const ack = await c.assistantConfirm(
          conversationId,
          target.id,
          yes,
          speakAs(),
          voice.commandId,
        );
        if (id !== live.current.turn || !ack.assistant) voice.cancel();
        if (id !== live.current.turn) return;
        const reply = ack.assistant;
        if (reply) {
          setBrainPending(reply.pending);
          if (reply.did.length > 0) buzz();
          live.current.from = reply.skills;
          await sayReply(reply.reply, voice.playing, id);
        } else await sayIt(P().problem(ack.error ?? "not applied"));
      } catch (error) {
        voice.cancel();
        await sayIt(P().problem(error instanceof Error ? error.message : String(error)));
      }
      if (id === live.current.turn) await afterThink(id);
    })();
  };

  const hush = () => {
    fresh();
    if (live.current.mode) void stopMode(false);
    setPhase("idle");
  };

  // Hands-free: a new question is read out as soon as it arrives.
  const waitingIds = needsYou(model)
    .map((q) => q.id)
    .join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the set of waiting questions changes; the rest is read from `live`
  useEffect(() => {
    if (!live.current.mode || live.current.pending) return;
    const unread = needsYou(live.current.model).find((q) => !live.current.handled.has(q.id));
    if (!unread) return;
    live.current.turn += 1;
    stopListening();
    void ask(unread, live.current.turn);
  }, [waitingIds]);

  // Hands-free: a task that finishes or fails is announced, then listening resumes.
  const finishedIds = Object.values(model.tasks)
    .filter((t) => t.state === "done" || t.state === "failed")
    .map((t) => t.id)
    .join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the set of finished tasks changes; the rest is read from `live`
  useEffect(() => {
    const L = live.current;
    if (!L.mode || L.pending || L.brainPending) return;
    const fresh = Object.values(L.model.tasks).filter(
      (t) =>
        (t.state === "done" || t.state === "failed") &&
        t.updatedAt >= L.modeSince &&
        !L.announced.has(t.id),
    );
    if (fresh.length === 0) return;
    for (const t of fresh) L.announced.add(t.id);
    L.turn += 1;
    const id = L.turn;
    stopListening();
    void (async () => {
      for (const t of fresh.slice(0, 3)) {
        const who = L.model.agents.find((a) => a.name === t.agent)?.label ?? t.agent;
        const what = t.prompt.slice(0, 80);
        await sayIt(
          t.state === "done" ? `${who} finished: ${what}.` : `${who} couldn't finish: ${what}.`,
          englishVoice(),
        );
        if (id !== L.turn) return;
      }
      await next(id);
    })();
  }, [finishedIds]);

  const dictate = async (onText: (text: string) => void) => {
    fresh();
    const { settings: s, model: m, client: c } = live.current;
    const precise = s.precise && canRecord() && m.transcribe && c !== undefined;
    setPhase("listening");
    let recording: string | undefined;
    try {
      const result = await listen({
        lang: s.lang,
        hints: hints(),
        long: true,
        record: precise,
        onPartial: onText,
      });
      recording = result.audioUri;
      onText(result.text);
      if (precise && result.audioUri && c) {
        setPhase("working");
        const audio = await readAudio(result.audioUri);
        const ack = await c.transcribe(audio, s.lang.slice(0, 2));
        if (ack.ok && ack.result) onText(ack.result);
        else
          setProblem(
            ack.error ?? "Precise mode didn't return any text; kept what the phone heard.",
          );
      }
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      discardRecording(recording);
      setPhase("idle");
    }
  };

  const value: Voice = {
    callsProblem,
    testCall,
    log,
    canListen: canListen(),
    canBePrecise: canRecord() && model.transcribe,
    settings,
    setSettings,
    mode,
    phase,
    heard,
    said,
    problem,
    pending,
    confirmPending,
    toggleMode,
    talk,
    answer,
    readAloud,
    look,
    tell,
    assistantOn: model.assistant && status === "online",
    dictate,
    stopDictation: stopListening,
    hush,
  };
  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>;
}

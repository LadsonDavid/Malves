import type { Lang } from "./engine";

/**
 * Everything malves says in voice mode, in English and Tamil. Text that comes
 * from agents (their questions, results) is read as it is.
 */
export type Phrases = ReturnType<typeof phrases>;

export function phrases(lang: Lang) {
  const or = (labels: string[]) => labels.join(lang === "ta-IN" ? " அல்லது " : " or ");
  if (lang === "ta-IN") {
    return {
      voice: "ta-IN" as Lang,
      on: (n: number) =>
        n === 0
          ? "குரல் முறை தொடங்கியது. இப்போது எதுவும் உங்கள் பதிலுக்காக காத்திருக்கவில்லை."
          : `குரல் முறை தொடங்கியது. ${n} கேள்வி காத்திருக்கிறது.`,
      off: "குரல் முறை நிறுத்தப்பட்டது.",
      asks: (agent: string) => `${agent} கேட்கிறது:`,
      highRisk: "இது அதிக ஆபத்து உள்ளது.",
      say: (labels: string[]) => `சொல்லுங்கள்: ${or(labels)}.`,
      confirmAnswer: (label: string) =>
        `நீங்கள் "${label}" என்று சொன்னீர்கள். இது அதிக ஆபத்து. உறுதி என்று சொல்லுங்கள், அல்லது ரத்து.`,
      done: "முடிந்தது.",
      oneSec: "ஒரு நொடி.",
      cancelled: "ரத்து செய்யப்பட்டது.",
      nothing: "இப்போது எதுவும் காத்திருக்கவில்லை.",
      commandHint: "ஒரு கட்டளை சொல்லுங்கள். உதாரணம்: புதிய பணி, அல்லது என்ன நடக்கிறது.",
      sorry: "மன்னிக்கவும், புரியவில்லை. மீண்டும் சொல்லுங்கள்.",
      unsure: (heard: string) => `"${heard}" என்று கேட்டேன். சரியாக புரியவில்லை, மீண்டும் சொல்லுங்கள்.`,
      startTask: (prompt: string, where: string, agent: string) =>
        `புதிய பணி: ${prompt}. ${where} இல், ${agent} மூலம். தொடங்கு என்று சொல்லுங்கள், அல்லது ரத்து.`,
      started: "பணி தொடங்கியது. உங்கள் பதில் தேவைப்பட்டால் சொல்கிறேன்.",
      noProject: "முதலில் கணினியில் ஒரு project folder சேர்க்கவும்.",
      noAgent: "கணினியில் தயாராக உள்ள agent இல்லை.",
      running: (n: number) => (n === 0 ? "எதுவும் இயங்கவில்லை." : `${n} பணி இயங்குகிறது.`),
      noResult: "படிக்க முடிவு எதுவும் இல்லை.",
      more: "மேலும் கேட்க, மேலும் என்று சொல்லுங்கள்.",
      end: "அவ்வளவுதான்.",
      stopWhich: "பல பணிகள் இயங்குகின்றன. எதை நிறுத்த வேண்டும் என்று app இல் தேர்வு செய்யுங்கள்.",
      confirmStop: (prompt: string) =>
        `"${prompt}" பணியை நிறுத்தவா? உறுதி என்று சொல்லுங்கள், அல்லது ரத்து.`,
      stopped: "பணி நிறுத்தப்பட்டது.",
      sent: "அனுப்பப்பட்டது.",
      nothingToReply: "பதில் அனுப்ப முடிந்த பணி எதுவும் இல்லை.",
      leads: (n: number, hot: number) => `இந்த வாரம் ${n} leads. ${hot} hot.`,
      noLeads: "Leads எதுவும் இல்லை.",
      help: "நீங்கள் சொல்லலாம்: அனுமதி, வேண்டாம், புதிய பணி, என்ன நடக்கிறது, முடிவு, மேலும், மீண்டும் சொல், போதும்.",
      problem: (message: string) => `பிரச்சனை: ${message}`,
      offline: "கணினி இப்போது இணைப்பில் இல்லை. இது வரிசையில் வைக்கப்பட்டது.",
    };
  }
  return {
    voice: lang,
    on: (n: number) =>
      n === 0
        ? "Voice mode on. Nothing needs you right now."
        : `Voice mode on. ${n} question${n === 1 ? "" : "s"} waiting.`,
    off: "Voice mode off.",
    asks: (agent: string) => `${agent} asks:`,
    highRisk: "This is high risk.",
    say: (labels: string[]) => `Say ${or(labels)}.`,
    confirmAnswer: (label: string) =>
      `You said ${label}. This is high risk. Say confirm, or cancel.`,
    done: "Done.",
    oneSec: "One sec.",
    cancelled: "Cancelled.",
    nothing: "Nothing else needs you.",
    commandHint: "Say a command, like: ask Claude to fix the footer, or what's running.",
    sorry: "Sorry, I didn't catch that. Say it again.",
    unsure: (heard: string) => `I heard "${heard}", but I'm not sure. Say it again.`,
    startTask: (prompt: string, where: string, agent: string) =>
      `New task: ${prompt}. In ${where}, with ${agent}. Say start, or cancel.`,
    started: "Started. I'll tell you when it needs you.",
    noProject: "Add a project folder on the computer first.",
    noAgent: "No agent is ready on the computer.",
    running: (n: number) => (n === 0 ? "Nothing is running." : `${n} running.`),
    noResult: "There's no result to read yet.",
    more: "Say more to hear the rest.",
    end: "That's all.",
    stopWhich: "Several tasks are running. Pick the one to stop in the app.",
    confirmStop: (prompt: string) => `Stop "${prompt}"? Say confirm, or cancel.`,
    stopped: "Task stopped.",
    sent: "Sent.",
    nothingToReply: "There's no finished task to reply to.",
    leads: (n: number, hot: number) => `${n} leads this week, ${hot} hot.`,
    noLeads: "No leads yet.",
    help: "You can say: allow, skip, option two, ask Claude to something, new task, what needs me, what's running, read the result, more, reply, run again, stop the task, leads, repeat, or stop listening.",
    problem: (message: string) => `Problem: ${message}`,
    offline: "The computer is offline. It's queued.",
  };
}

/** Words that help the recognizer hear commands right. */
export const COMMAND_HINTS = [
  "allow",
  "skip",
  "confirm",
  "cancel",
  "option two",
  "new task",
  "ask",
  "reply",
  "run again",
  "stop the task",
  "what needs me",
  "what's running",
  "read the result",
  "more",
  "repeat",
  "stop listening",
  "leads",
  "sari",
  "vendaam",
  "uruthi",
  "pothum",
  "சரி",
  "வேண்டாம்",
  "உறுதி",
  "ரத்து",
  "போதும்",
  "புதிய பணி",
  "முடிவு",
  "மேலும்",
];

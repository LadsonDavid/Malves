/** The toolbar popup: paste the code `malves serve` shows, and see whether it's connected. */

const WORDS: Record<string, string> = {
  "no-code": "Paste the code from malves to connect.",
  connecting: "Connecting to malves…",
  connected: "Connected to malves on this computer.",
  offline: "malves isn't running on this computer. Start `malves serve`.",
  "wrong-code":
    "malves didn't accept that code. In malves serve, type `extension` and paste the code it shows.",
};

const statusLine = document.getElementById("status") as HTMLParagraphElement;
const input = document.getElementById("code") as HTMLInputElement;
const save = document.getElementById("save") as HTMLButtonElement;

function show(state: string | undefined): void {
  statusLine.textContent = WORDS[state ?? ""] ?? "…";
  statusLine.dataset.state = state ?? "";
}

async function refresh(): Promise<void> {
  const reply = (await chrome.runtime.sendMessage({ type: "status" })) as { status?: string };
  show(reply?.status);
}

save.addEventListener("click", async () => {
  const code = input.value.trim();
  if (!code) return;
  await chrome.storage.local.set({ code });
  input.value = "";
  show("connecting");
  const reply = (await chrome.runtime.sendMessage({ type: "reconnect" })) as { status?: string };
  show(reply?.status);
  // The answer from malves arrives a moment later.
  setTimeout(() => void refresh(), 1500);
});

void refresh();

export {};

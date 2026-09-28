import path from "node:path";

/**
 * The browser gate's rules (§5, R6). They are enforced in the tool, so they
 * hold whatever the agent decides to do:
 *
 * - reading, navigating to web pages, following links: allowed;
 * - clicking buttons, typing, forms, uploads, dialogs, other keys: asks the phone;
 * - password and payment fields, and running page scripts: refused, never automated;
 * - any tool the gate doesn't know: refused.
 */

export type Risk = "low" | "medium" | "high";

export type Verdict =
  | { action: "allow"; args: Record<string, unknown> }
  | { action: "ask"; text: string; risk: Risk; args: Record<string, unknown> }
  | { action: "refuse"; reason: string };

/** What the gate learns about an element before acting on it. Never includes field values. */
export type ElementInfo = {
  tag: string;
  type: string;
  autocomplete: string;
  name: string;
  id: string;
  label: string;
  text: string;
  href: string;
  inForm: boolean;
};

export type Inspect = (target: string) => Promise<ElementInfo | undefined>;

/** Tools the agent sees. Everything else, including page scripts, is hidden and refused. */
export const EXPOSED_TOOLS = new Set([
  "browser_navigate",
  "browser_navigate_back",
  "browser_snapshot",
  "browser_take_screenshot",
  "browser_find",
  "browser_wait_for",
  "browser_console_messages",
  "browser_network_requests",
  "browser_network_request",
  "browser_tabs",
  "browser_resize",
  "browser_emulate_media",
  "browser_hover",
  "browser_close",
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_select_option",
  "browser_press_key",
  "browser_file_upload",
  "browser_handle_dialog",
  "browser_drag",
  "browser_drop",
]);

const READ_ONLY = new Set([
  "browser_navigate_back",
  "browser_snapshot",
  "browser_take_screenshot",
  "browser_find",
  "browser_wait_for",
  "browser_console_messages",
  "browser_network_requests",
  "browser_network_request",
  "browser_resize",
  "browser_emulate_media",
  "browser_hover",
  "browser_close",
]);

const SAFE_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  "Escape",
  "Tab",
]);

export const REFUSED_SENSITIVE =
  "Refused: this is a password or payment field. malves never automates these. " +
  "Tell the user this step needs them.";

const SENSITIVE_NAME =
  /pass(word|wd|code)?\b|passwd|pwd|\bpin\b|card.?(number|num|no)\b|\bcc.?(num|number|cvc|cvv|csc|exp)|cvv|cvc|\bcsc\b|security.?code|iban|routing.?number|account.?number|\botp\b|one.?time/i;
const SENSITIVE_AUTOCOMPLETE = /(^|\s)(cc-|current-password|new-password|one-time-code)/;
const WEIGHTY =
  /\b(pay|buy|order|purchase|checkout|check out|delete|remove|cancel|confirm|submit|send|sign ?in|log ?in|sign ?up|register|subscribe|transfer|donate|book|publish|post)\b/i;

/** Why an element must never be automated, or undefined if it may be. */
export function sensitive(info: ElementInfo): string | undefined {
  if (info.type === "password") return "password field";
  if (SENSITIVE_AUTOCOMPLETE.test(info.autocomplete)) return "password or payment field";
  if (SENSITIVE_NAME.test(`${info.name} ${info.id} ${info.label}`))
    return "password or payment field";
  return undefined;
}

export async function judge(
  tool: string,
  rawArgs: Record<string, unknown>,
  inspect: Inspect,
  workspace: string,
): Promise<Verdict> {
  if (!EXPOSED_TOOLS.has(tool)) {
    return {
      action: "refuse",
      reason: `Refused: ${tool} is not available through the browser gate.`,
    };
  }
  // The gate decides where files go; the agent can't name them.
  const { filename: _ignored, ...args } = rawArgs;

  if (READ_ONLY.has(tool)) return { action: "allow", args };

  switch (tool) {
    case "browser_navigate":
      return navigation(String(args.url ?? ""), args);

    case "browser_tabs":
      if (args.action === "new" && typeof args.url === "string") return navigation(args.url, args);
      return { action: "allow", args };

    case "browser_click": {
      const info = await inspect(String(args.target ?? ""));
      if (!info) return ask(args, `Click ${describe(args)}?`, "medium");
      if (sensitive(info)) return { action: "refuse", reason: REFUSED_SENSITIVE };
      const plainClick = !args.doubleClick && !args.modifiers && (args.button ?? "left") === "left";
      if (plainClick && isLink(info)) return { action: "allow", args };
      const words = `${info.text} ${info.label}`;
      return ask(
        args,
        `Click "${clip(words.trim() || describe(args), 60)}"?`,
        WEIGHTY.test(words) || info.inForm ? "high" : "medium",
      );
    }

    case "browser_type": {
      const info = await inspect(String(args.target ?? ""));
      if (!info)
        return { action: "refuse", reason: "Refused: could not check what this field is." };
      if (sensitive(info)) return { action: "refuse", reason: REFUSED_SENSITIVE };
      const submit = args.submit === true ? " and press Enter" : "";
      return ask(
        args,
        `Type "${clip(String(args.text ?? ""), 80)}" into ${fieldName(info, args)}${submit}?`,
        submit ? "high" : "medium",
      );
    }

    case "browser_fill_form": {
      const fields = Array.isArray(args.fields)
        ? (args.fields as Array<Record<string, unknown>>)
        : [];
      const lines: string[] = [];
      for (const field of fields) {
        const info = await inspect(String(field.target ?? ""));
        if (!info) return { action: "refuse", reason: "Refused: could not check what a field is." };
        if (sensitive(info)) return { action: "refuse", reason: REFUSED_SENSITIVE };
        lines.push(
          `${clip(String(field.name ?? fieldName(info, field)), 30)}: ${clip(String(field.value ?? ""), 40)}`,
        );
      }
      return ask(args, `Fill in this form?\n${lines.join("\n")}`, "high");
    }

    case "browser_select_option": {
      const info = await inspect(String(args.target ?? ""));
      if (!info)
        return { action: "refuse", reason: "Refused: could not check what this field is." };
      if (sensitive(info)) return { action: "refuse", reason: REFUSED_SENSITIVE };
      const values = Array.isArray(args.values) ? args.values.join(", ") : "";
      return ask(args, `Choose "${clip(values, 60)}" in ${fieldName(info, args)}?`, "medium");
    }

    case "browser_press_key": {
      const key = String(args.key ?? "");
      if (SAFE_KEYS.has(key)) return { action: "allow", args };
      return ask(args, `Press ${clip(key, 20)}?`, key === "Enter" ? "high" : "medium");
    }

    case "browser_handle_dialog":
      if (args.accept !== true) return { action: "allow", args };
      return ask(args, "Accept the page's dialog?", "high");

    case "browser_file_upload":
    case "browser_drop": {
      const paths = Array.isArray(args.paths) ? (args.paths as unknown[]).map(String) : [];
      if (tool === "browser_file_upload" && paths.length === 0) return { action: "allow", args };
      for (const p of paths) {
        if (!inside(workspace, p)) {
          return { action: "refuse", reason: `Refused: ${p} is outside the workspace.` };
        }
      }
      const names = paths.map((p) => path.basename(p)).join(", ");
      return ask(args, paths.length ? `Upload ${names}?` : `Drop onto ${describe(args)}?`, "high");
    }

    case "browser_drag":
      return ask(args, `Drag ${clip(String(args.startElement ?? "an element"), 40)}?`, "medium");
  }
  return {
    action: "refuse",
    reason: `Refused: ${tool} is not available through the browser gate.`,
  };
}

/** Web pages are fine. Anything on the user's own machine or network needs a yes. */
function navigation(raw: string, args: Record<string, unknown>): Verdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { action: "refuse", reason: "Refused: not a valid address." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      action: "refuse",
      reason: `Refused: only web pages can be opened, not ${url.protocol} addresses.`,
    };
  }
  if (isLocal(url.hostname)) {
    return ask(args, `Open ${clip(url.href, 80)} on your own computer or home network?`, "high");
  }
  return { action: "allow", args };
}

export function isLocal(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host.endsWith(".internal") || host.endsWith(".lan") || host.endsWith(".home.arpa"))
    return true;
  if (host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd"))
    return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (!m) return !host.includes(".") && !host.includes(":");
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function isLink(info: ElementInfo): boolean {
  return info.tag === "A" && /^https?:/i.test(info.href) && !info.inForm;
}

function inside(root: string, p: string): boolean {
  if (!path.isAbsolute(p)) return false;
  const rel = path.relative(root, path.resolve(p));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function ask(args: Record<string, unknown>, text: string, risk: Risk): Verdict {
  return { action: "ask", text, risk, args };
}

function describe(args: Record<string, unknown>): string {
  return clip(String(args.element ?? args.target ?? "this element"), 60);
}

function fieldName(info: ElementInfo, args: Record<string, unknown>): string {
  return clip(info.label || info.name || info.id || describe(args), 40);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

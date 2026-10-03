/**
 * Functions that run inside the web page, injected by the background script
 * with `chrome.scripting.executeScript`. Chrome copies each function's own
 * source into the page, so every one must be self-contained: no imports, no
 * helpers from this module. That is why the password/card check appears in
 * both `snapshotPage` and `typeRef` — keep the two copies identical.
 *
 * Nothing here is downloaded at run time: all code ships in the extension.
 */

export type PageElement = {
  ref: string;
  role: string;
  label: string;
  href?: string;
  value?: string;
  /** A password, card or one-time-code field: malves never types here. */
  sensitive?: boolean;
};

export type PageSnapshot = { url: string; title: string; text: string; elements: PageElement[] };

/** What the agent can see: the page text and every visible link, button and field. */
export function snapshotPage(): PageSnapshot {
  const SENSITIVE =
    /(^|[^a-z])(pass(word|code|phrase)?|pwd|cvv2?|cvc|csc|iban|ssn|otp|pin(code)?)([^a-z]|$)|cc-|card.?(number|num|no)|security.?code|one-time-code/i;
  const isSensitive = (el: Element): boolean => {
    if (el instanceof HTMLInputElement && el.type === "password") return true;
    const hints = ["autocomplete", "name", "id", "aria-label", "placeholder"]
      .map((a) => el.getAttribute(a) ?? "")
      .join(" ");
    return SENSITIVE.test(hints);
  };

  const SELECTOR = [
    "a[href]",
    "button",
    "input:not([type=hidden])",
    "select",
    "textarea",
    "summary",
    "[contenteditable=''],[contenteditable='true']",
    ...["button", "link", "checkbox", "radio", "tab", "menuitem", "option", "switch"].map(
      (r) => `[role=${r}]`,
    ),
  ].join(",");

  const roleOf = (el: Element): string => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "select") return "drop-down";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = (el as HTMLInputElement).type;
      if (["checkbox", "radio"].includes(type)) return type;
      if (["submit", "button", "reset", "image"].includes(type)) return "button";
      return type === "password" ? "password field" : "textbox";
    }
    if ((el as HTMLElement).isContentEditable) return "textbox";
    return tag === "summary" ? "button" : tag;
  };

  const labelOf = (el: Element): string => {
    const byId = el.getAttribute("aria-labelledby");
    const labelled = byId
      ?.split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    const field = el as HTMLInputElement;
    return (
      el.getAttribute("aria-label") ||
      labelled ||
      (field.labels?.[0]?.textContent ?? "") ||
      el.getAttribute("placeholder") ||
      el.getAttribute("alt") ||
      el.getAttribute("title") ||
      (el as HTMLElement).innerText ||
      el.textContent ||
      (["submit", "button"].includes(field.type) ? field.value : "") ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
  };

  const win = window as unknown as { __malvesRef?: number };
  const elements: PageElement[] = [];
  for (const el of Array.from(document.querySelectorAll(SELECTOR))) {
    if (elements.length >= 300) break;
    if (
      typeof el.checkVisibility === "function" &&
      !el.checkVisibility({ visibilityProperty: true })
    ) {
      continue;
    }
    const html = el as HTMLElement;
    if (!html.dataset.malvesRef) {
      win.__malvesRef = (win.__malvesRef ?? 0) + 1;
      html.dataset.malvesRef = `e${win.__malvesRef}`;
    }
    const sensitive = isSensitive(el);
    const item: PageElement = { ref: html.dataset.malvesRef, role: roleOf(el), label: labelOf(el) };
    if (sensitive) item.sensitive = true;
    if (el instanceof HTMLAnchorElement) item.href = (el.getAttribute("href") ?? "").slice(0, 200);
    if (el instanceof HTMLInputElement && ["checkbox", "radio"].includes(el.type)) {
      item.value = el.checked ? "checked" : "not checked";
    } else if (
      !sensitive &&
      (el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement) &&
      el.value
    ) {
      item.value = el.value.slice(0, 80);
    }
    elements.push(item);
  }

  return {
    url: location.href,
    title: document.title,
    text: (document.body?.innerText ?? document.body?.textContent ?? "").trim().slice(0, 8000),
    elements,
  };
}

/** Clicks the element a snapshot called `ref`. */
export function clickRef(ref: string): { error?: string } {
  const el = document.querySelector(`[data-malves-ref="${CSS.escape(ref)}"]`);
  if (!(el instanceof HTMLElement)) {
    return { error: "That element isn't on the page any more. Take a new snapshot." };
  }
  el.scrollIntoView({ block: "center" });
  el.click();
  return {};
}

/** Types into a field. Password, card and one-time-code fields are refused, always. */
export function typeRef(
  ref: string,
  text: string,
  submit: boolean,
): { error?: string; refused?: string } {
  const SENSITIVE =
    /(^|[^a-z])(pass(word|code|phrase)?|pwd|cvv2?|cvc|csc|iban|ssn|otp|pin(code)?)([^a-z]|$)|cc-|card.?(number|num|no)|security.?code|one-time-code/i;
  const isSensitive = (el: Element): boolean => {
    if (el instanceof HTMLInputElement && el.type === "password") return true;
    const hints = ["autocomplete", "name", "id", "aria-label", "placeholder"]
      .map((a) => el.getAttribute(a) ?? "")
      .join(" ");
    return SENSITIVE.test(hints);
  };

  const el = document.querySelector(`[data-malves-ref="${CSS.escape(ref)}"]`);
  if (!(el instanceof HTMLElement)) {
    return { error: "That field isn't on the page any more. Take a new snapshot." };
  }
  if (isSensitive(el)) {
    return {
      refused:
        "Refused: malves never types into password, card or one-time-code fields. Ask the user to do this part themselves.",
    };
  }

  el.focus();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    // The prototype's setter, so frameworks like React notice the change.
    const proto =
      el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, text);
  } else if (el.isContentEditable) {
    el.textContent = text;
  } else {
    return { error: "That element can't be typed into." };
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));

  if (submit) {
    const form = (el as HTMLInputElement).form;
    if (form) form.requestSubmit();
    else el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }
  return {};
}

/** Chooses an option in a drop-down, by its value or its visible text. */
export function selectRef(ref: string, value: string): { error?: string } {
  const el = document.querySelector(`[data-malves-ref="${CSS.escape(ref)}"]`);
  if (!(el instanceof HTMLSelectElement)) return { error: "That element isn't a drop-down." };
  const option = Array.from(el.options).find((o) => o.value === value || o.text.trim() === value);
  if (!option) return { error: `There's no "${value}" option.` };
  el.value = option.value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return {};
}

/** Presses a key on whatever has focus. */
export function pressKey(key: string): { error?: string } {
  const target = document.activeElement ?? document.body;
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
  if (key === "Enter" && target instanceof HTMLInputElement && target.form) {
    target.form.requestSubmit();
  }
  return {};
}

export function scrollPage(direction: "up" | "down"): { error?: string } {
  window.scrollBy({ top: (direction === "down" ? 1 : -1) * window.innerHeight * 0.8 });
  return {};
}

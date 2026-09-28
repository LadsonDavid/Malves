import { describe, expect, it } from "vitest";
import {
  type ElementInfo,
  isLocal,
  judge,
  REFUSED_SENSITIVE,
  sensitive,
} from "../src/adapters/browser_gate/policy.js";

const ws = "/home/me/site";
const el = (over: Partial<ElementInfo> = {}): ElementInfo => ({
  tag: "INPUT",
  type: "text",
  autocomplete: "",
  name: "",
  id: "",
  label: "",
  text: "",
  href: "",
  inForm: false,
  ...over,
});
const inspecting = (info: ElementInfo | undefined) => async () => info;
const never = async () => {
  throw new Error("should not inspect");
};

describe("browser gate policy", () => {
  it("allows reading and ordinary web navigation", async () => {
    for (const tool of [
      "browser_snapshot",
      "browser_take_screenshot",
      "browser_navigate_back",
      "browser_find",
    ]) {
      expect((await judge(tool, {}, never, ws)).action).toBe("allow");
    }
    expect(
      (await judge("browser_navigate", { url: "https://example.com/a?b=1" }, never, ws)).action,
    ).toBe("allow");
  });

  it("drops any filename the agent passes", async () => {
    const v = await judge(
      "browser_take_screenshot",
      { filename: "/etc/cron.d/x", type: "png" },
      never,
      ws,
    );
    expect(v).toEqual({ action: "allow", args: { type: "png" } });
  });

  it("refuses page scripts and unknown tools", async () => {
    for (const tool of ["browser_evaluate", "browser_run_code_unsafe", "browser_install", "rm"]) {
      expect((await judge(tool, { function: "() => 1" }, never, ws)).action).toBe("refuse");
    }
  });

  it("refuses non-web schemes and asks before opening local addresses", async () => {
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,x",
      "chrome://settings",
    ]) {
      expect((await judge("browser_navigate", { url }, never, ws)).action).toBe("refuse");
    }
    for (const url of [
      "http://localhost:3000",
      "http://192.168.1.1/admin",
      "http://10.0.0.5",
      "http://nas.local",
    ]) {
      expect(await judge("browser_navigate", { url }, never, ws)).toMatchObject({
        action: "ask",
        risk: "high",
      });
    }
    expect(
      (await judge("browser_tabs", { action: "new", url: "http://127.0.0.1" }, never, ws)).action,
    ).toBe("ask");
  });

  it("follows plain links without asking, but asks for buttons", async () => {
    const link = el({ tag: "A", href: "https://example.com/next", text: "Next" });
    expect((await judge("browser_click", { target: "e1" }, inspecting(link), ws)).action).toBe(
      "allow",
    );
    const pay = el({ tag: "BUTTON", text: "Pay now", inForm: true });
    expect(await judge("browser_click", { target: "e2" }, inspecting(pay), ws)).toMatchObject({
      action: "ask",
      risk: "high",
    });
    const jsLink = el({ tag: "A", href: "javascript:void(0)", text: "Delete" });
    expect((await judge("browser_click", { target: "e3" }, inspecting(jsLink), ws)).action).toBe(
      "ask",
    );
    const ctrlClick = { target: "e1", modifiers: ["Control"] };
    expect((await judge("browser_click", ctrlClick, inspecting(link), ws)).action).toBe("ask");
  });

  it("asks before typing, and never types into password or payment fields", async () => {
    expect(
      await judge(
        "browser_type",
        { target: "e1", text: "cheap flights" },
        inspecting(el({ name: "q" })),
        ws,
      ),
    ).toMatchObject({ action: "ask" });
    for (const field of [
      el({ type: "password" }),
      el({ autocomplete: "cc-number" }),
      el({ autocomplete: "section-x current-password" }),
      el({ name: "cardNumber" }),
      el({ id: "cvv" }),
      el({ label: "Security code" }),
      el({ name: "iban" }),
      el({ autocomplete: "one-time-code" }),
    ]) {
      expect(
        await judge("browser_type", { target: "e1", text: "x" }, inspecting(field), ws),
      ).toEqual({
        action: "refuse",
        reason: REFUSED_SENSITIVE,
      });
    }
  });

  it("fails closed when a field can't be inspected", async () => {
    expect(
      (await judge("browser_type", { target: "?", text: "x" }, inspecting(undefined), ws)).action,
    ).toBe("refuse");
  });

  it("refuses a whole form if any field is sensitive", async () => {
    const infos: Record<string, ElementInfo> = {
      a: el({ name: "email" }),
      b: el({ type: "password" }),
    };
    const inspect = async (t: string) => infos[t];
    const fields = [
      { target: "a", name: "Email", type: "textbox", value: "me@x.com" },
      { target: "b", name: "Password", type: "textbox", value: "hunter2" },
    ];
    expect((await judge("browser_fill_form", { fields }, inspect, ws)).action).toBe("refuse");
    expect(
      (await judge("browser_fill_form", { fields: fields.slice(0, 1) }, inspect, ws)).action,
    ).toBe("ask");
  });

  it("lets scrolling keys through and asks for the rest", async () => {
    expect((await judge("browser_press_key", { key: "PageDown" }, never, ws)).action).toBe("allow");
    expect(await judge("browser_press_key", { key: "Enter" }, never, ws)).toMatchObject({
      action: "ask",
      risk: "high",
    });
  });

  it("uploads only workspace files, and only after asking", async () => {
    expect(
      (await judge("browser_file_upload", { paths: ["/home/me/.ssh/id_ed25519"] }, never, ws))
        .action,
    ).toBe("refuse");
    expect(
      (await judge("browser_file_upload", { paths: ["/home/me/site/../x"] }, never, ws)).action,
    ).toBe("refuse");
    expect(
      (await judge("browser_file_upload", { paths: ["relative.txt"] }, never, ws)).action,
    ).toBe("refuse");
    expect(
      await judge("browser_file_upload", { paths: ["/home/me/site/cv.pdf"] }, never, ws),
    ).toMatchObject({ action: "ask", text: "Upload cv.pdf?" });
    expect((await judge("browser_file_upload", {}, never, ws)).action).toBe("allow");
  });

  it("dismissing a dialog is fine; accepting one asks", async () => {
    expect((await judge("browser_handle_dialog", { accept: false }, never, ws)).action).toBe(
      "allow",
    );
    expect((await judge("browser_handle_dialog", { accept: true }, never, ws)).action).toBe("ask");
  });
});

describe("sensitive", () => {
  it("leaves ordinary fields alone", () => {
    for (const f of [
      el({ name: "q" }),
      el({ name: "email" }),
      el({ label: "Company name" }),
      el({ id: "passenger" }),
    ]) {
      expect(sensitive(f)).toBeUndefined();
    }
  });
});

describe("isLocal", () => {
  it.each([
    ["localhost", true],
    ["127.0.0.1", true],
    ["192.168.0.10", true],
    ["172.20.1.1", true],
    ["100.100.1.1", true],
    ["[::1]", true],
    ["router", true],
    ["example.com", false],
    ["8.8.8.8", false],
    ["172.32.0.1", false],
  ])("%s → %s", (host, local) => {
    expect(isLocal(host)).toBe(local);
  });
});

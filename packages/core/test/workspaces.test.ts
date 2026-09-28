import { command, confine, OutsideWorkspaceError } from "@malves/core";
import { describe, expect, it } from "vitest";
import { setup } from "./fakes.js";

describe("workspaces", () => {
  it("registers once per path, and can be removed", () => {
    const c = setup();
    const a = c.workspaces.register("site", "/home/me/site");
    expect(c.workspaces.register("again", "/home/me/site/")).toEqual(a);
    expect(c.workspaces.list()).toHaveLength(1);
    expect(c.workspaces.remove(a.id)).toBe(true);
    expect(c.workspaces.list()).toEqual([]);
  });

  it("requires an absolute path", () => {
    expect(() => setup().workspaces.register("x", "relative/dir")).toThrow();
  });
});

describe("confine", () => {
  const root = "/home/me/site";
  it.each([
    ["index.html", "/home/me/site/index.html"],
    ["./a/../b.txt", "/home/me/site/b.txt"],
    ["/home/me/site/deep/x", "/home/me/site/deep/x"],
    ["..hidden", "/home/me/site/..hidden"],
    [".", "/home/me/site"],
  ])("allows %s", (requested, expected) => {
    expect(confine(root, requested)).toBe(expected);
  });

  it.each(["..", "../other", "/etc/passwd", "/home/me/site-evil/x", "a/../../x"])(
    "refuses %s",
    (requested) => {
      expect(() => confine(root, requested)).toThrow(OutsideWorkspaceError);
    },
  );
});

describe("command", () => {
  it("keeps program and arguments apart", () => {
    const c = command("npx", ["-y", "some agent; rm -rf /"]);
    expect(c.args).toEqual(["-y", "some agent; rm -rf /"]);
    expect(Object.isFrozen(c.args)).toBe(true);
  });

  it("refuses empty programs and NUL bytes", () => {
    expect(() => command("")).toThrow();
    expect(() => command("a", ["b\0c"])).toThrow();
  });
});

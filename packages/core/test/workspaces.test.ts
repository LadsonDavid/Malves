import path from "node:path";
import { command, confine, OutsideWorkspaceError } from "@malves/core";
import { describe, expect, it } from "vitest";
import { setup } from "./fakes.js";

// Built with `path`, so it is "/home/me/site" on Linux and "D:\home\me\site" on Windows.
const root = path.resolve("/home/me/site");
const onWindows = process.platform === "win32";

describe("workspaces", () => {
  it("registers once per path, and can be removed", () => {
    const c = setup();
    const a = c.workspaces.register("site", root);
    expect(c.workspaces.register("again", `${root}${path.sep}`)).toEqual(a);
    expect(c.workspaces.list()).toHaveLength(1);
    expect(c.workspaces.remove(a.id)).toBe(true);
    expect(c.workspaces.list()).toEqual([]);
  });

  it("requires an absolute path", () => {
    expect(() => setup().workspaces.register("x", "relative/dir")).toThrow();
  });

  it.runIf(onWindows)("treats paths differing only in case as one folder on Windows", () => {
    const c = setup();
    const a = c.workspaces.register("site", root);
    expect(c.workspaces.register("again", root.toUpperCase())).toEqual(a);
    expect(c.workspaces.list()).toHaveLength(1);
  });
});

describe("confine", () => {
  it.each([
    ["index.html", path.join(root, "index.html")],
    ["./a/../b.txt", path.join(root, "b.txt")],
    [path.join(root, "deep", "x"), path.join(root, "deep", "x")],
    ["..hidden", path.join(root, "..hidden")],
    [".", root],
  ])("allows %s", (requested, expected) => {
    expect(confine(root, requested)).toBe(expected);
  });

  it.each(["..", "../other", "/etc/passwd", `${root}-evil/x`, "a/../../x"])(
    "refuses %s",
    (requested) => {
      expect(() => confine(root, requested)).toThrow(OutsideWorkspaceError);
    },
  );

  describe.runIf(onWindows)("on Windows", () => {
    const otherDrive = root.toUpperCase().startsWith("C:") ? "D:\\x" : "C:\\x";

    it.each([otherDrive, "\\\\server\\share\\x", "\\\\?\\C:\\Windows\\x"])(
      "refuses %s",
      (requested) => {
        expect(() => confine(root, requested)).toThrow(OutsideWorkspaceError);
      },
    );

    it("allows the workspace written in different case", () => {
      expect(() => confine(root, path.join(root.toUpperCase(), "a.txt"))).not.toThrow();
    });
  });
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

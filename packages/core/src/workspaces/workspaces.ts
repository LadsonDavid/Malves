import path from "node:path";
import type { EventLog } from "../events/log.js";
import type { Ids } from "../ports.js";

export type Workspace = { id: string; name: string; path: string };

export class OutsideWorkspaceError extends Error {
  constructor(requested: string) {
    super(`Path is outside the workspace: ${requested}`);
    this.name = "OutsideWorkspaceError";
  }
}

/**
 * Project folders registered on the desktop. The phone can only start tasks in
 * one of these, and can never add one (§8 "Least privilege").
 */
export class Workspaces {
  private readonly byId = new Map<string, Workspace>();

  constructor(
    private readonly log: EventLog,
    private readonly ids: Ids,
  ) {
    log.subscribe((event) => {
      if (event.type === "workspace.registered") {
        const { workspace_id: id, name, path } = event.data;
        this.byId.set(id, { id, name, path });
      } else if (event.type === "workspace.removed") {
        this.byId.delete(event.data.workspace_id);
      }
    });
  }

  /** `root` must be an absolute, already-resolved path (the adapter resolves symlinks). */
  register(name: string, root: string): Workspace {
    if (!path.isAbsolute(root)) throw new Error(`Workspace path must be absolute: ${root}`);
    const normalized = path.resolve(root);
    const existing = this.list().find((w) => samePath(w.path, normalized));
    if (existing) return existing;
    const id = this.ids.next("ws");
    this.log.append({
      type: "workspace.registered",
      data: { workspace_id: id, name, path: normalized },
    });
    return { id, name, path: normalized };
  }

  remove(id: string): boolean {
    if (!this.byId.has(id)) return false;
    this.log.append({ type: "workspace.removed", data: { workspace_id: id } });
    return true;
  }

  get(id: string): Workspace | undefined {
    return this.byId.get(id);
  }

  list(): Workspace[] {
    return [...this.byId.values()];
  }
}

/** Whether two resolved paths name the same folder. Windows paths ignore case. */
export function samePath(a: string, b: string): boolean {
  return path.sep === "\\" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Resolves `requested` against `root` and refuses anything that lands outside
 * it. Pure path arithmetic: symlinks must be resolved by the caller.
 */
export function confine(root: string, requested: string): string {
  const resolved = path.resolve(root, requested);
  const relative = path.relative(root, resolved);
  if (relative === "") return resolved;
  const escapes = relative === ".." || relative.startsWith(`..${path.sep}`);
  if (escapes || path.isAbsolute(relative)) {
    throw new OutsideWorkspaceError(requested);
  }
  return resolved;
}

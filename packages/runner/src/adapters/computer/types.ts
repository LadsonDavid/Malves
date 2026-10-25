export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type UiElement = {
  id: string;
  role: string;
  name: string;
  rect: Rect;
  enabled: boolean;
  app: string;
  window: string;
};

export type Act =
  | { kind: "click"; x?: number; y?: number; elementId?: string }
  | { kind: "double"; x?: number; y?: number; elementId?: string }
  | { kind: "right"; x?: number; y?: number; elementId?: string }
  | { kind: "type"; text: string; elementId?: string }
  | { kind: "keys"; combo: string }
  | { kind: "scroll"; lines: number; x?: number; y?: number }
  | { kind: "drag"; fromX: number; fromY: number; toX: number; toY: number }
  | { kind: "wait"; ms: number };

export type ActResult = {
  ok: boolean;
  frameId: string;
  error?: string | undefined;
  changed?: boolean | undefined;
  userActive?: boolean | undefined;
};

export interface Computer {
  snapshot(): Promise<{
    frameId: string;
    jpeg: string;
    width: number;
    height: number;
    elements?: UiElement[] | undefined;
  }>;
  act(a: Act, frameId: string): Promise<ActResult>;
}

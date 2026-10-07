/**
 * Malves' brain: any OpenAI-compatible server — in practice your freellmapi on
 * the Oracle server (MALVES_MODELS_URL / MALVES_MODELS_KEY), which spreads the
 * calls across your free provider keys. Nothing runs on the laptop.
 */
export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type Tool = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export interface Llm {
  /**
   * With `onText`, the reply streams: its words arrive as they're written, so
   * Malves can start speaking early. Text stops being passed on once the model
   * starts proposing a tool call (what's done is told in code-written words).
   */
  chat(
    messages: ChatMessage[],
    tools: Tool[],
    onText?: (delta: string) => void,
  ): Promise<{ content: string; toolCalls: ToolCall[] }>;
  embed(texts: string[]): Promise<number[][]>;
  /** Looks at a JPEG and answers `prompt` about it; tries vision models in order. */
  see?(jpegBase64: string, system: string, prompt: string): Promise<string>;
}

/** Vision models tried in order when MALVES_VISION_MODEL isn't set (all on freellmapi). */
export const VISION_MODELS = [
  "llama-4-scout-17b-16e-instruct",
  "qwen3-vl-30b-a3b-instruct",
  "llama-3.2-11b-vision-instruct",
  "gemini-2.5-flash",
];

export type LlmOptions = {
  url: string;
  key: string;
  /** "auto:fast" asks freellmapi for the quickest model available. */
  model?: string;
  embedModel?: string;
  /** Vision models to try, best first. */
  visionModels?: string[];
  timeoutMs?: number;
};

export function openAiCompatible(o: LlmOptions): Llm {
  const headers = { authorization: `Bearer ${o.key}`, "content-type": "application/json" };
  const post = async (path: string, body: unknown) => {
    let response: Response;
    try {
      response = await fetch(new URL(path, o.url), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(o.timeoutMs ?? 25_000),
      });
    } catch {
      throw new Error("Can't reach Malves' brain (freellmapi). Is the server up?");
    }
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const message = (json.error as { message?: string } | undefined)?.message;
      throw new Error(
        `The brain answered ${response.status}${message ? `: ${message.slice(0, 160)}` : ""}`,
      );
    }
    return json;
  };
  /** A chat answered as server-sent events, words passed on as they come. */
  const stream = async (body: Record<string, unknown>, onText: (delta: string) => void) => {
    let response: Response;
    try {
      response = await fetch(new URL("/v1/chat/completions", o.url), {
        method: "POST",
        headers,
        body: JSON.stringify({ ...body, stream: true }),
        signal: AbortSignal.timeout(o.timeoutMs ?? 25_000),
      });
    } catch {
      throw new Error("Can't reach Malves' brain (freellmapi). Is the server up?");
    }
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `The brain answered ${response.status}${text ? `: ${text.slice(0, 160)}` : ""}`,
      );
    }
    let content = "";
    const calls: ToolCall[] = [];
    const take = (delta: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    }) => {
      for (const t of delta.tool_calls ?? []) {
        const i = t.index ?? 0;
        calls[i] ??= { id: "", type: "function", function: { name: "", arguments: "" } };
        const call = calls[i];
        if (t.id) call.id = t.id;
        call.function.name += t.function?.name ?? "";
        call.function.arguments += t.function?.arguments ?? "";
      }
      if (delta.content) {
        content += delta.content;
        if (calls.length === 0) onText(delta.content);
      }
    };
    if (!response.headers.get("content-type")?.includes("event-stream")) {
      // The server ignored `stream`: one plain answer.
      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] } }>;
      };
      const message = json.choices?.[0]?.message;
      const toolCalls = message?.tool_calls ?? [];
      if (toolCalls.length === 0 && message?.content) onText(message.content);
      return { content: message?.content?.trim() ?? "", toolCalls };
    }
    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of response.body) {
      pending += decoder.decode(chunk as Uint8Array, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const data = line.startsWith("data:") ? line.slice(5).trim() : "";
        if (!data || data === "[DONE]") continue;
        try {
          const event = JSON.parse(data) as {
            choices?: Array<{ delta?: Parameters<typeof take>[0] }>;
          };
          take(event.choices?.[0]?.delta ?? {});
        } catch {
          // A keep-alive or a broken line: skip it.
        }
      }
    }
    return { content: content.trim(), toolCalls: calls.filter((c) => c.function.name) };
  };
  return {
    async chat(messages, tools, onText) {
      const body = {
        model: o.model ?? "auto:fast",
        messages,
        // Some providers refuse an empty tool list: leave it out when there are none.
        ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
        temperature: 0.3,
        max_tokens: 500,
      };
      if (onText) return stream(body, onText);
      const json = await post("/v1/chat/completions", body);
      const message = (
        json.choices as Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] } }>
      )?.[0]?.message;
      return { content: message?.content?.trim() ?? "", toolCalls: message?.tool_calls ?? [] };
    },
    async see(jpegBase64, system, prompt) {
      let last: unknown;
      for (const model of o.visionModels ?? VISION_MODELS) {
        try {
          const json = await post("/v1/chat/completions", {
            model,
            messages: [
              { role: "system", content: system },
              {
                role: "user",
                content: [
                  { type: "text", text: prompt },
                  { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpegBase64}` } },
                ],
              },
            ],
            temperature: 0.2,
            max_tokens: 400,
          });
          const text = (
            json.choices as Array<{ message?: { content?: string | null } }>
          )?.[0]?.message?.content?.trim();
          if (text) return text;
        } catch (error) {
          last = error;
        }
      }
      throw last instanceof Error ? last : new Error("No vision model answered.");
    },
    async embed(texts) {
      const json = await post("/v1/embeddings", {
        model: o.embedModel ?? "@cf/baai/bge-m3",
        input: texts,
      });
      const data = json.data as Array<{ embedding: number[] }> | undefined;
      if (!data || data.length !== texts.length)
        throw new Error("Embeddings came back incomplete.");
      return data.map((d) => d.embedding);
    },
  };
}

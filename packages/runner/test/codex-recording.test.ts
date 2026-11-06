import { expect, it } from "vitest";
import { codexRecording } from "../src/adapters/sessions/codex-recording.js";

const lines = (...data: unknown[]) => data.map((line) => JSON.stringify(line)).join("\n");
it("pairs persisted native tool results and distinguishes recorded completion from runtime status", () => {
  const snapshot = codexRecording(
    lines(
      { type: "event_msg", payload: { type: "task_started" } },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          call_id: "one",
          name: "exec_command",
          arguments: JSON.stringify({ cmd: "rg TODO src" }),
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "one",
          output: "Process exited with code 0\nfound TODO",
        },
      },
      { type: "event_msg", payload: { type: "task_complete" } },
    ),
    123,
  );
  expect(snapshot.provenance).toBe("saved-rollout");
  expect(snapshot.recorded_state).toBe("completed");
  expect(snapshot.operations).toMatchObject([
    { id: "one", kind: "search", status: "completed", text: expect.stringContaining("found TODO") },
  ]);
});
it("does not treat unanswered calls or truncated history as verified live work", () => {
  const snapshot = codexRecording(
    lines({
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "pending",
        name: "exec_command",
        arguments: '{"cmd":"build"}',
      },
    }),
    123,
  );
  expect(snapshot.recorded_state).toBe("unknown");
  expect(snapshot.operations[0]?.status).toBe("pending");
});
it("redacts recorded output, marks failed commands, and bounds text", () => {
  const snapshot = codexRecording(
    lines(
      {
        type: "response_item",
        payload: {
          type: "function_call",
          call_id: "one",
          name: "exec_command",
          arguments: '{"cmd":"test"}',
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "one",
          output: `Process exited with code 1\napi_key=private-value\n${"x".repeat(10000)}`,
        },
      },
    ),
    123,
  );
  expect(snapshot.operations[0]?.status).toBe("failed");
  expect(snapshot.operations[0]?.text).not.toContain("private-value");
  expect(snapshot.operations[0]?.text?.length).toBeLessThan(2100);
});

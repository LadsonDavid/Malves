import { describe, expect, it } from "vitest";
import { MAX_TYPED_CHARS, safeTyped } from "../src/adapters/assistant/safe-text.js";

describe("safeTyped", () => {
  it("keeps ordinary text, line breaks and tabs", () => {
    const text = "Hello,\n\tworld! 12 ₹ தமிழ்";
    expect(safeTyped(text).text).toBe(text);
  });

  it("turns Windows line breaks into one", () => {
    expect(safeTyped("a\r\nb").text).toBe("a\nb");
  });

  it("drops control characters that could press keys", () => {
    // Ctrl+C, Escape, Backspace, Delete, a C1 control, a lone carriage return.
    const result = safeTyped("a\u0003b\u001Bc\u0008d\u007Fe\u009Bf\rg");
    expect(result.text).toBe("abcdefg");
    expect(result.dropped).toBe(6);
  });

  it("drops invisible and direction-changing characters", () => {
    const result = safeTyped("pay\u200Bment\u202Eevil\u2066");
    expect(result.text).toBe("paymentevil");
    expect(result.dropped).toBe(3);
  });

  it("cuts very long text and says so", () => {
    const result = safeTyped("x".repeat(MAX_TYPED_CHARS + 50));
    expect(result.text).toHaveLength(MAX_TYPED_CHARS);
    expect(result.cut).toBe(true);
  });
});

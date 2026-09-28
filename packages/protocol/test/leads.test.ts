import { decodeLeadsInvite, encodeLeadsInvite, type Lead, researchPrompt } from "@malves/protocol";
import { describe, expect, it } from "vitest";

describe("lead engine invite", () => {
  it("round-trips, and trims a trailing slash", () => {
    const text = encodeLeadsInvite({ url: "https://relay.example.com/leads/", key: "k&y=1" });
    expect(decodeLeadsInvite(text)).toEqual({
      url: "https://relay.example.com/leads",
      key: "k&y=1",
    });
  });

  it("rejects other codes, bad addresses and a missing key", () => {
    expect(() => decodeLeadsInvite("malves://pair?v=1")).toThrow();
    expect(() => decodeLeadsInvite("malves://leads?u=javascript%3Aalert(1)&k=x")).toThrow(
      /address/,
    );
    expect(() => decodeLeadsInvite("malves://leads?u=https%3A%2F%2Fx.dev&k=")).toThrow(/key/);
  });
});

describe("researchPrompt", () => {
  it("carries the lead's reason into a read-only browser task", () => {
    const lead: Lead = {
      domain: "acme.dev",
      name: "Acme",
      score: 70,
      tier: "hot",
      types: ["intent"],
      why: "hiring 3 SREs",
      trigger: "status page incident",
      signals: 5,
      contact: { name: "Ada", title: "VP Eng" },
    };
    const prompt = researchPrompt(lead);
    expect(prompt).toContain("Acme (acme.dev)");
    expect(prompt).toContain("hiring 3 SREs");
    expect(prompt).toContain("Ada, VP Eng");
    expect(prompt).toContain("do not fill in forms");
  });
});

import { expect, it } from "vitest";
import { groupOperations } from "../src/operations";

it("groups consecutive completed reads and searches without hiding errors or pending operations", () => {
  const groups = groupOperations([
    { id: "r1", title: "Read one", kind: "read", status: "completed" },
    { id: "r2", title: "Search", kind: "search", status: "completed" },
    { id: "bad", title: "Failed read", kind: "read", status: "failed" },
    { id: "edit", title: "Edit", kind: "edit", status: "completed" },
    { id: "pending", title: "Read", kind: "read", status: "pending" },
  ]);
  expect(groups.map((g) => g.map((o) => o.id))).toEqual([
    ["r1", "r2"],
    ["bad"],
    ["edit"],
    ["pending"],
  ]);
});

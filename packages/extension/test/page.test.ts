// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { clickRef, selectRef, snapshotPage, typeRef } from "../src/page.js";

/** Replaces the page with this (fixed, test-written) HTML, then reads it. */
const page = (html: string) => {
  const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  document.body.replaceChildren(...Array.from(parsed.body.childNodes));
  return snapshotPage();
};
const refOf = (snap: ReturnType<typeof snapshotPage>, label: string) =>
  snap.elements.find((e) => e.label === label)?.ref ?? "missing";

beforeEach(() => {
  document.body.replaceChildren();
});

describe("reading a page", () => {
  it("lists links, buttons and fields with labels and refs", () => {
    const snap = page(`
      <a href="/pricing">Pricing</a>
      <button>Place order</button>
      <label for="email">Email</label><input id="email" value="me@x.com">
      <input aria-label="Search" placeholder="Find…">
      <select aria-label="Size"><option>S</option><option selected>M</option></select>
    `);
    expect(snap.elements.map(({ ref: _ref, ...e }) => e)).toEqual([
      { role: "link", label: "Pricing", href: "/pricing" },
      { role: "button", label: "Place order" },
      { role: "textbox", label: "Email", value: "me@x.com" },
      { role: "textbox", label: "Search" },
      { role: "drop-down", label: "Size", value: "M" },
    ]);
    expect(new Set(snap.elements.map((e) => e.ref)).size).toBe(5);
  });

  it("skips hidden elements", () => {
    const snap = page(
      `<div style="display:none"><button>Hidden</button></div><button>Shown</button>`,
    );
    expect(snap.elements.map((e) => e.label)).toEqual(["Shown"]);
  });

  it("keeps the same ref for an element across snapshots", () => {
    const first = page(`<button>Go</button>`);
    expect(snapshotPage().elements[0]?.ref).toBe(first.elements[0]?.ref);
  });

  it("flags password and card fields, and never shows what's in them", () => {
    const snap = page(`
      <input type="password" aria-label="Password" value="hunter2">
      <input name="card_number" aria-label="Card" value="4111111111111111">
      <input autocomplete="cc-csc" aria-label="CVC">
      <input name="new_password" aria-label="New">
      <input autocomplete="one-time-code" aria-label="Code">
    `);
    expect(snap.elements).toHaveLength(5);
    for (const e of snap.elements) {
      expect(e.sensitive).toBe(true);
      expect(e.value).toBeUndefined();
    }
    expect(JSON.stringify(snap)).not.toContain("hunter2");
    expect(JSON.stringify(snap)).not.toContain("4111");
  });

  it("doesn't mistake harmless fields for secret ones", () => {
    const snap = page(`
      <input name="passport_country" aria-label="Passport country">
      <input name="compass" aria-label="Compass">
      <input name="spinner" aria-label="Spinner">
      <input name="cardholder_name" aria-label="Name on card">
    `);
    expect(snap.elements.filter((e) => e.sensitive)).toEqual([]);
  });
});

describe("acting on a page", () => {
  it("types so that frameworks see the change", () => {
    const snap = page(`<input aria-label="Name">`);
    const input = document.querySelector("input") as HTMLInputElement;
    const seen: string[] = [];
    input.addEventListener("input", () => seen.push(input.value));
    expect(typeRef(refOf(snap, "Name"), "Ada", false)).toEqual({});
    expect(input.value).toBe("Ada");
    expect(seen).toEqual(["Ada"]);
  });

  it("refuses to type into a password or card field, and leaves it untouched", () => {
    const snap = page(`
      <input type="password" aria-label="Password">
      <input autocomplete="cc-number" aria-label="Card number">
    `);
    for (const label of ["Password", "Card number"]) {
      const result = typeRef(refOf(snap, label), "secret", false);
      expect(result.refused).toMatch(/never types/);
    }
    for (const input of Array.from(document.querySelectorAll("input"))) {
      expect(input.value).toBe("");
    }
  });

  it("submits the form when asked", () => {
    const snap = page(`<form><input aria-label="Query"></form>`);
    let submitted = false;
    document.querySelector("form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      submitted = true;
    });
    typeRef(refOf(snap, "Query"), "malves", true);
    expect(submitted).toBe(true);
  });

  it("clicks by ref, and says so when the element is gone", () => {
    const snap = page(`<button>Go</button>`);
    let clicks = 0;
    document.querySelector("button")?.addEventListener("click", () => {
      clicks += 1;
    });
    expect(clickRef(refOf(snap, "Go"))).toEqual({});
    expect(clicks).toBe(1);
    document.body.replaceChildren();
    expect(clickRef(refOf(snap, "Go")).error).toMatch(/new snapshot/);
  });

  it("chooses a drop-down option by value or by its text", () => {
    const snap = page(
      `<select aria-label="Size"><option value="s">Small</option><option value="l">Large</option></select>`,
    );
    const select = document.querySelector("select") as HTMLSelectElement;
    expect(selectRef(refOf(snap, "Size"), "Large")).toEqual({});
    expect(select.value).toBe("l");
    expect(selectRef(refOf(snap, "Size"), "Huge").error).toMatch(/no "Huge"/);
  });
});

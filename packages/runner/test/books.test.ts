import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BookLibrary,
  chunk,
  formatHits,
  type Ocr,
  type PdfText,
  sourcesLine,
} from "../src/adapters/assistant/books.js";

const dirs: string[] = [];
const libs: BookLibrary[] = [];
afterEach(() => {
  for (const l of libs.splice(0)) l.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** One dimension per topic word: a text is close to the queries that share its words. */
const TOPICS = ["habit", "negotiat", "sleep", "strategy"];
const vec = (t: string) => TOPICS.map((w) => (t.toLowerCase().includes(w) ? 1 : 0.01));

/** A paragraph long enough that each page becomes its own chunk. */
const filler = (word: string) => `${word} `.repeat(90).trim();

function setup(
  pages: Record<string, string[]>,
  extra: {
    embed?: (texts: string[]) => Promise<number[][]>;
    now?: () => number;
    ocr?: Ocr;
  } = {},
) {
  const root = mkdtempSync(path.join(tmpdir(), "malves-books-"));
  dirs.push(root);
  mkdirSync(path.join(root, "Extractions"));
  const embedded: string[] = [];
  const extracted: string[] = [];
  const pdf: PdfText = async (file) => {
    extracted.push(path.basename(file));
    return pages[path.basename(file)] ?? [];
  };
  const lib = new BookLibrary({
    roots: [root],
    indexFile: path.join(root, "books.db"),
    embed:
      extra.embed ??
      (async (texts) => {
        embedded.push(...texts);
        return texts.map(vec);
      }),
    pdf,
    ...(extra.now ? { now: extra.now } : {}),
    ...(extra.ocr ? { ocr: extra.ocr } : {}),
  });
  libs.push(lib);
  const put = (name: string, text = "x") => writeFileSync(path.join(root, name), text);
  return { root, lib, put, embedded, extracted };
}

describe("his book library", () => {
  it("cuts text into chunks that keep their page range", () => {
    const pieces = chunk([
      { page: 1, section: null, text: filler("alpha") },
      { page: 2, section: null, text: filler("beta") },
      { page: 3, section: null, text: "tiny" },
      { page: 4, section: null, text: "also tiny" },
    ]);
    expect(pieces.map((p) => [p.p1, p.p2])).toEqual([
      [1, 1],
      [2, 2],
      [3, 4],
    ]);
  });

  it("finds a passage by meaning and by words, and cites the page in code", async () => {
    const { lib, put } = setup({
      "Atomic habits.pdf": [filler("habit"), filler("sleep")],
      "Good Strategy.pdf": [filler("strategy")],
    });
    put("Atomic habits.pdf");
    put("Good Strategy.pdf");
    put("scan.pdf");
    put("Extractions/Deep Work - Notes.md", "# Rules\n\nFocus on negotiating your attention.\n");
    await lib.sync();
    expect(await lib.fill()).toBe(0);

    const habit = await lib.search("how do small habit loops form", 2);
    expect(habit[0]).toMatchObject({ book: "Atomic habits", where: "page 1" });
    const sleep = await lib.search("sleep", 1);
    expect(sleep[0]).toMatchObject({ book: "Atomic habits", where: "page 2" });
    const note = await lib.search("negotiating attention", 1);
    expect(note[0]).toMatchObject({ book: "Deep Work - Notes", where: 'section "Rules"' });

    expect(sourcesLine([...habit.slice(0, 1), ...sleep])).toBe(
      "From your books: Atomic habits (page 1); Atomic habits (page 2).",
    );
    expect(formatHits(habit.slice(0, 1))).toContain("[1] Atomic habits, page 1:");
    // A scan has no text layer: it is listed, never guessed at.
    expect(lib.status().unreadable).toEqual(["scan"]);
  });

  it("reads a file again only when it changed, and keeps the vectors of unchanged chunks", async () => {
    const pages = { "b.pdf": [filler("habit"), filler("sleep")] };
    const { lib, put, embedded, extracted } = setup(pages);
    put("b.pdf", "v1");
    await lib.sync();
    await lib.fill();
    expect(embedded.length).toBe(2);

    await lib.sync();
    expect(extracted).toEqual(["b.pdf"]);

    pages["b.pdf"] = [filler("habit"), filler("strategy")];
    put("b.pdf", "v2 longer");
    await lib.sync();
    await lib.fill();
    expect(extracted).toEqual(["b.pdf", "b.pdf"]);
    // Only the changed page was embedded again.
    expect(embedded.length).toBe(3);
    expect((await lib.search("strategy", 1))[0]?.where).toBe("page 2");
  });

  it("drops books that were deleted and still answers by words when the embedder is down", async () => {
    let calls = 0;
    const { lib, put, root } = setup(
      { "a.pdf": [filler("habit")] },
      {
        embed: async () => {
          calls++;
          throw new Error("down");
        },
        now: () => 1_000_000,
      },
    );
    put("a.pdf");
    await lib.sync();
    expect(await lib.fill()).toBe(1);
    // A failed embedder is not retried for ten minutes.
    await lib.fill();
    expect(calls).toBe(1);
    expect((await lib.search("habit", 1))[0]?.book).toBe("a");

    rmSync(path.join(root, "a.pdf"));
    await lib.sync();
    expect(await lib.search("habit", 1)).toEqual([]);
    expect(lib.status().books).toBe(0);
  });

  describe("scanned books", () => {
    const scanned = { "scan.pdf": ["", ""] };
    const read: Ocr = async () => [
      "Chapter one is about strategy. ".repeat(30),
      "Page two is about habits. ".repeat(30),
    ];

    it("lists a scan as waiting, reads it with OCR, and cites the page", async () => {
      const calls: Array<[string, number]> = [];
      const { lib, put, root } = setup(scanned, {
        ocr: async (file, pages, cache) => {
          calls.push([path.basename(file), pages]);
          expect(cache).toContain("ocr-cache");
          return read(file, pages, cache);
        },
      });
      put("scan.pdf");
      await lib.sync();
      expect(lib.status()).toMatchObject({ books: 0, ocr: 1, unreadable: ["scan"] });

      expect(await lib.ocrNext()).toBe(0);
      expect(calls).toEqual([["scan.pdf", 2]]);
      // The text sits beside the PDF, pages separated by form feeds.
      const sidecar = readFileSync(path.join(root, "scan.pdf.ocr.txt"), "utf8");
      expect(sidecar.split("\f")).toHaveLength(2);
      expect(lib.status()).toMatchObject({ books: 1, ocr: 0, unreadable: [] });
      expect((await lib.search("strategy", 1))[0]).toMatchObject({ book: "scan", where: "page 1" });
      expect((await lib.search("habits", 1))[0]?.where).toBe("page 2");
    });

    it("indexes the OCR text when it arrives from elsewhere, with no OCR of its own", async () => {
      const { lib, put, root } = setup(scanned);
      put("scan.pdf");
      await lib.sync();
      expect(lib.status().unreadable).toEqual(["scan"]);
      // The server copy: Syncthing brings the sidecar the laptop made.
      writeFileSync(path.join(root, "scan.pdf.ocr.txt"), (await read("", 2, "")).join("\f"));
      await lib.sync();
      expect(lib.status()).toMatchObject({ books: 1, unreadable: [] });
      expect((await lib.search("habits", 1))[0]).toMatchObject({ book: "scan", where: "page 2" });
    });

    it("marks a book as failed, with the reason, when OCR can't run", async () => {
      const { lib, put } = setup(scanned, {
        ocr: async () => {
          throw new Error("tesseract is not installed or not on PATH");
        },
      });
      put("scan.pdf");
      await lib.sync();
      expect(await lib.ocrNext()).toBe(0);
      expect(lib.status()).toMatchObject({ books: 0, ocr: 0, unreadable: ["scan"] });
    });
  });
});

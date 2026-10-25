/**
 * Hides secrets in text that is about to be written to a log or a note. It is
 * pattern based: it lowers the risk of a key leaking into serve.log, it is not
 * a guarantee, so secrets still must never be put in messages on purpose.
 */
const HIDDEN = "[hidden]";

/** Keys with a recognisable shape: the whole match is replaced. */
const SHAPES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-[A-Za-z0-9_-]{24,}/g,
  /\bsk_[A-Za-z0-9_]{20,}/g,
  /\bgsk_[A-Za-z0-9]{24,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

/** A key name followed by its value: the name stays, the value goes. */
const NAMED: RegExp[] = [
  /(\b(?:api[_-]?key|x-key|secret|password|passwd|token|access[_-]?token|refresh[_-]?token)["']?\s*[:=]\s*["']?)([^\s"',}]+)/gi,
  /(\bauthorization["']?\s*[:=]\s*["']?bearer\s+)([^\s"',}]+)/gi,
  /(\bbearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi,
];

export function redact(text: string): string {
  let out = text;
  for (const shape of SHAPES) out = out.replace(shape, HIDDEN);
  for (const named of NAMED) out = out.replace(named, (_all, name: string) => `${name}${HIDDEN}`);
  return out;
}

/**
 * Redacts a stream line by line, so a secret split across two chunks is still
 * seen whole. Output lines keep their newline; `end()` flushes a last partial line.
 */
export class LineRedactor {
  private rest = "";
  private inKey = false;

  constructor(private readonly emit: (line: string) => void) {}

  write(chunk: string | Buffer): void {
    const text = this.rest + chunk.toString("utf8");
    const parts = text.split("\n");
    this.rest = parts.pop() ?? "";
    for (const line of parts) this.line(line);
  }

  end(): void {
    if (this.rest) this.line(this.rest);
    this.rest = "";
  }

  /** A private key spans lines: everything between BEGIN and END is hidden. */
  private line(line: string): void {
    if (this.inKey) {
      if (/-----END [A-Z ]*PRIVATE KEY-----/.test(line)) this.inKey = false;
      return;
    }
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line) && !/-----END/.test(line)) {
      this.inKey = true;
      this.emit(`${HIDDEN}\n`);
      return;
    }
    this.emit(`${redact(line)}\n`);
  }
}

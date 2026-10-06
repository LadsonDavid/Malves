/**
 * Files the phone sends in pieces over the link (a frame is at most 256 KB),
 * e.g. a photo for Malves. Pieces arrive in order; unfinished uploads expire.
 */
type Upload = { chunks: Buffer[]; bytes: number; started: number };

export class Uploads {
  private readonly uploads = new Map<string, Upload>();

  constructor(
    private readonly o: { maxBytes: number; maxOpen: number; ttlMs: number; what: string },
  ) {}

  add(uploadId: string, index: number, base64: string): void {
    const now = Date.now();
    for (const [id, u] of this.uploads) if (now - u.started > this.o.ttlMs) this.uploads.delete(id);
    let upload = this.uploads.get(uploadId);
    if (!upload) {
      if (index !== 0) throw new Error(`That ${this.o.what} isn't on the computer any more.`);
      if (this.uploads.size >= this.o.maxOpen) throw new Error(`Too many ${this.o.what}s at once.`);
      upload = { chunks: [], bytes: 0, started: now };
      this.uploads.set(uploadId, upload);
    }
    if (index !== upload.chunks.length)
      throw new Error(`A piece of the ${this.o.what} went missing.`);
    const piece = Buffer.from(base64, "base64");
    upload.bytes += piece.length;
    if (upload.bytes > this.o.maxBytes) {
      this.uploads.delete(uploadId);
      throw new Error(`That ${this.o.what} is too big.`);
    }
    upload.chunks.push(piece);
  }

  /** The whole file, removed from the store. */
  take(uploadId: string): Buffer {
    const upload = this.uploads.get(uploadId);
    this.uploads.delete(uploadId);
    if (!upload) throw new Error(`That ${this.o.what} isn't on the computer any more. Try again.`);
    return Buffer.concat(upload.chunks);
  }
}

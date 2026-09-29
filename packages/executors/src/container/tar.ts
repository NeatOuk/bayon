// A minimal ustar writer for the image build context: regular files at the top
// level, owner 0:0 and mtime 0, so the same files always give the same bytes and so the same
// render hash. `docker build -` reads it from the ssh channel's stdin.
import { frmError } from "../errors.js";

const BLOCK = 512;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
/** The 12-byte octal size field's ceiling. */
const MAX_SIZE = 8 ** 11 - 1;

export interface TarFile {
  readonly name: string;
  /** Permission bits, e.g. 0o644; COPY keeps them. */
  readonly mode: number;
  readonly content: Buffer;
}

function octal(h: Buffer, offset: number, width: number, value: number): void {
  h.write(
    `${value.toString(8).padStart(width - 1, "0")}\0`,
    offset,
    width,
    "ascii",
  );
}

function header(file: TarFile): Buffer {
  if (!NAME.test(file.name) || file.content.length > MAX_SIZE) {
    throw frmError(
      "validation",
      `tar: refusing ${JSON.stringify(file.name)} (${file.content.length} bytes)`,
    );
  }
  const h = Buffer.alloc(BLOCK);
  h.write(file.name, 0, "ascii");
  octal(h, 100, 8, file.mode & 0o7777);
  octal(h, 108, 8, 0);
  octal(h, 116, 8, 0);
  octal(h, 124, 12, file.content.length);
  octal(h, 136, 12, 0);
  h.fill(0x20, 148, 156);
  h.write("0", 156, "ascii");
  h.write("ustar\0", 257, "ascii");
  h.write("00", 263, "ascii");
  const sum = h.reduce((total, byte) => total + byte, 0);
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return h;
}

/** The files in order, each padded to a block, then the two zero blocks that end an archive. */
export function tarball(files: readonly TarFile[]): Buffer {
  const parts = files.flatMap((file) => [
    header(file),
    file.content,
    Buffer.alloc((BLOCK - (file.content.length % BLOCK)) % BLOCK),
  ]);
  return Buffer.concat([...parts, Buffer.alloc(2 * BLOCK)]);
}

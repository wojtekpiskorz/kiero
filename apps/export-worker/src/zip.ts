/**
 * A bounded, streaming ZIP writer (I3 export worker): the STORE method
 * (no compression) with CRC-32 computed while bytes stream through, local
 * file headers carrying the data-descriptor flag, and a central directory
 * at the end. Nothing is buffered whole: every file's bytes are pushed
 * through the sink in chunks, so Worker memory stays bounded by the chunk
 * size, not the archive size.
 *
 * BOUNDS (asserted, the protocol's "bounded archive"): at most 65,534
 * entries and a total under 4 GiB, because this writer does not emit
 * ZIP64 fields; the exporter's media bounds keep both true by construction.
 *
 * DOS encodes timestamps (the ZIP format's own clock, UTC): dates before
 * 1980 clamp to 1980-01-01.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** Table-driven CRC state update (no framing xors; state starts 0xffffffff). */
export function crc32Update(state: number, chunk: Uint8Array): number {
  let crc = state;
  for (let i = 0; i < chunk.length; i++) {
    const byte = chunk[i]!;
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return crc >>> 0;
}

/** CRC-32 (IEEE 802.3) of one whole byte sequence. */
export function crc32(bytes: Uint8Array): number {
  return (crc32Update(0xffffffff, bytes) ^ 0xffffffff) >>> 0;
}

/** Where a file's bytes go (an R2 multipart part stream, a memory buffer). */
export interface ByteSink {
  push(chunk: Uint8Array): void;
}

const encoder = new TextEncoder();

function asciiBytes(value: string): Uint8Array {
  // ZIP name fields are byte strings; archive paths are ASCII by
  // construction (safePathSegment), so this never loses information.
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) {
    bytes[i] = value.charCodeAt(i) & 0x7f;
  }
  return bytes;
}

function u16(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
}

function u32(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** DOS date/time pair of a UTC timestamp (clamped to 1980-01-01). */
export function dosDateTime(epochMs: number): { readonly date: number; readonly time: number } {
  const date = new Date(Math.max(epochMs, Date.UTC(1980, 0, 1)));
  return {
    date: ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
  };
}

interface CentralRecord {
  readonly nameBytes: Uint8Array;
  readonly crc: number;
  readonly bytes: number;
  readonly offset: number;
  readonly dos: { readonly date: number; readonly time: number };
}

/** One archive being written to a sink; files in order, finish() closes it. */
export class ZipWriter {
  private readonly records: CentralRecord[] = [];
  private offset = 0;
  private closed = false;
  private inFile = false;
  private currentCrc = 0xffffffff;
  private currentBytes = 0;
  private currentName: Uint8Array | null = null;
  private currentDos = dosDateTime(0);
  private currentOffset = 0;

  constructor(private readonly sink: ByteSink) {}

  /** Starts one stored entry (ASCII path; UTF-8 flag set for safety). */
  beginFile(path: string, modifiedMs: number): void {
    if (this.closed || this.inFile) {
      throw new Error("zip writer: beginFile state violated");
    }
    if (this.records.length >= 65_534) {
      throw new Error("zip writer: entry bound exceeded");
    }
    this.currentName = asciiBytes(path);
    this.currentDos = dosDateTime(modifiedMs);
    this.currentCrc = 0xffffffff;
    this.currentBytes = 0;
    this.currentOffset = this.offset;
    this.inFile = true;
    // Local file header: version 20, flags 0x08 (data descriptor) | 0x800
    // (UTF-8 names), method 0 (store), sizes 0 until the descriptor.
    this.write(
      concat([
        u32(0x04034b50),
        u16(20),
        u16(0x0808),
        u16(0),
        u16(this.currentDos.time),
        u16(this.currentDos.date),
        u32(0),
        u32(0),
        u32(0),
        u16(this.currentName.length),
        u16(0),
        this.currentName,
      ]),
    );
  }

  /** Streams one chunk of the current file's bytes (CRC updated inline). */
  append(chunk: Uint8Array): void {
    if (!this.inFile) {
      throw new Error("zip writer: append before beginFile");
    }
    if (chunk.length === 0) {
      return;
    }
    this.currentCrc = crc32Update(this.currentCrc, chunk);
    this.currentBytes += chunk.length;
    this.write(chunk);
  }

  /** Ends the current entry with its data descriptor. */
  endFile(): void {
    if (!this.inFile || this.currentName === null) {
      throw new Error("zip writer: endFile before beginFile");
    }
    this.write(
      concat([
        u32(0x08074b50),
        u32((this.currentCrc ^ 0xffffffff) >>> 0),
        u32(this.currentBytes),
        u32(this.currentBytes),
      ]),
    );
    this.records.push({
      nameBytes: this.currentName,
      crc: (this.currentCrc ^ 0xffffffff) >>> 0,
      bytes: this.currentBytes,
      offset: this.currentOffset,
      dos: this.currentDos,
    });
    this.inFile = false;
    this.currentName = null;
  }

  /** Writes one whole small entry in one call (JSON/HTML files). */
  addFile(path: string, contents: string | Uint8Array, modifiedMs: number): void {
    const bytes = typeof contents === "string" ? encoder.encode(contents) : contents;
    this.beginFile(path, modifiedMs);
    this.append(bytes);
    this.endFile();
  }

  /** Central directory + end record; the sink is complete after this. */
  finish(): void {
    if (this.inFile) {
      throw new Error("zip writer: finish with open file");
    }
    if (this.closed) {
      throw new Error("zip writer: already finished");
    }
    const directoryOffset = this.offset;
    for (const record of this.records) {
      this.write(
        concat([
          u32(0x02014b50),
          u16(20),
          u16(20),
          u16(0x0808),
          u16(0),
          u16(record.dos.time),
          u16(record.dos.date),
          u32(record.crc),
          u32(record.bytes),
          u32(record.bytes),
          u16(record.nameBytes.length),
          u16(0),
          u16(0),
          u16(0),
          u16(0),
          u32(0),
          u32(record.offset),
          record.nameBytes,
        ]),
      );
    }
    const directoryBytes = this.offset - directoryOffset;
    this.write(
      concat([
        u32(0x06054b50),
        u16(0),
        u16(0),
        u16(this.records.length),
        u16(this.records.length),
        u32(directoryBytes),
        u32(directoryOffset),
        u16(0),
      ]),
    );
    this.closed = true;
  }

  /** Total bytes pushed so far (the finished archive's size). */
  get bytesWritten(): number {
    return this.offset;
  }

  get entries(): number {
    return this.records.length;
  }

  private write(bytes: Uint8Array): void {
    if (bytes.length === 0) {
      return;
    }
    if (this.offset + bytes.length > 0xffff_ffff) {
      throw new Error("zip writer: 4GiB bound exceeded (ZIP64 not emitted)");
    }
    this.sink.push(bytes);
    this.offset += bytes.length;
  }
}

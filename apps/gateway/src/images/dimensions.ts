/**
 * Bounded image-dimension decoding: the ONE pure source of pixel
 * width/height for the images drive, decoded from a bounded byte window —
 * never a served guess and never a 0×0 stand-in.
 *
 * JPEG (SOF marker scan), PNG (IHDR at its fixed offset) and WebP (VP8X
 * canvas / VP8 keyframe / VP8L lossless) — the three formats the drive's
 * own sniff vocabulary and the binding's WebP output use. A format whose
 * header does not fit the window, or that fails to parse, decodes to null:
 * the caller omits the dimensions (the honest state) instead of inventing
 * them. The retentions this serves:
 *
 * - the binding adapter's OUTPUT contract (a WebP whose real dimensions the
 *   recorded evidence needs);
 * - the retained-original exception rows (the received original's own pixel
 *   space, so vision region validation over the fallback is meaningful).
 */

/** One decoded pixel space. */
export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

/** The head window the decoder is guaranteed to work within. */
export const DIMENSION_HEAD_WINDOW_BYTES = 65_536;

const jpegStart = (bytes: Uint8Array): boolean =>
  bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

const pngStart = (bytes: Uint8Array): boolean =>
  bytes.length >= 8 &&
  bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;

const webpStart = (bytes: Uint8Array): boolean =>
  bytes.length >= 12 &&
  bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
  bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;

/** The SOFn markers that carry the frame's dimensions (DHT/JPG/DAC excluded). */
function isSofMarker(marker: number): boolean {
  if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2 || marker === 0xc3) {
    return true;
  }
  if (marker >= 0xc5 && marker <= 0xc7) {
    return true;
  }
  if (marker >= 0xc9 && marker <= 0xcb) {
    return true;
  }
  return marker === 0xcd || marker === 0xce || marker === 0xcf;
}

/** Scans JPEG markers to the first SOFn frame header. */
function jpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  // The bounded accessor: every read is guarded by the caller's window
  // checks; a read past the end means "header did not resolve".
  const at = (index: number): number => bytes[index] ?? 0;
  // Skip the SOI; walk marker segments until SOS (or the window ends).
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (at(offset) !== 0xff) {
      return null; // not a marker boundary: undecodable, never a guess
    }
    const marker = at(offset + 1);
    if (marker === 0xda || marker === 0xd9) {
      return null; // scan data / EOI before any SOF: nothing to read
    }
    const length = (at(offset + 2) << 8) | at(offset + 3);
    if (length < 2 || offset + 2 + length > bytes.length) {
      return null;
    }
    if (isSofMarker(marker)) {
      const base = offset + 4;
      if (base + 5 > bytes.length) {
        return null;
      }
      const height = (at(base + 1) << 8) | at(base + 2);
      const width = (at(base + 3) << 8) | at(base + 4);
      if (width < 1 || height < 1) {
        return null;
      }
      return { width, height };
    }
    offset += 2 + length;
  }
  return null;
}

/** Reads the IHDR pixel space (PNG's fixed layout). */
function pngDimensions(bytes: Uint8Array): ImageDimensions | null {
  // signature(8) + length(4) + "IHDR"(4) then width/height, big-endian.
  if (bytes.length < 24) {
    return null;
  }
  const at = (index: number): number => bytes[index] ?? 0;
  const width = (at(16) << 24) | (at(17) << 16) | (at(18) << 8) | at(19);
  const height = (at(20) << 24) | (at(21) << 16) | (at(22) << 8) | at(23);
  // The high bits make no sense for a phone photo: a sign bit or an absurd
  // canvas means the header is not what it claims — refuse, never guess.
  if (width < 1 || height < 1 || width > 0x00ff_ffff || height > 0x00ff_ffff) {
    return null;
  }
  return { width, height };
}

/** Reads the WebP canvas: VP8X first, else the VP8/VP8L frame headers. */
function webpDimensions(bytes: Uint8Array): ImageDimensions | null {
  // RIFF(4) size(4) WEBP(4) then the first chunk: fourcc(4) size(4) data.
  const at = (index: number): number => bytes[index] ?? 0;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const fourcc = String.fromCharCode(at(offset), at(offset + 1), at(offset + 2), at(offset + 3));
    const chunkSize = at(offset + 4) | (at(offset + 5) << 8) | (at(offset + 6) << 16) | (at(offset + 7) << 24);
    const data = offset + 8;
    if (fourcc === "VP8X") {
      if (data + 10 > bytes.length) {
        return null;
      }
      const width = 1 + (at(data + 4) | (at(data + 5) << 8) | (at(data + 6) << 16));
      const height = 1 + (at(data + 7) | (at(data + 8) << 8) | (at(data + 9) << 16));
      return width >= 1 && height >= 1 ? { width, height } : null;
    }
    if (fourcc === "VP8 ") {
      // frame tag(3) + sync 0x9D012A(3), then 14-bit LE dims (2+2).
      const base = data + 6;
      if (base + 4 > bytes.length) {
        return null;
      }
      const width = (at(base) | (at(base + 1) << 8)) & 0x3fff;
      const height = (at(base + 2) | (at(base + 3) << 8)) & 0x3fff;
      return width >= 1 && height >= 1 ? { width, height } : null;
    }
    if (fourcc === "VP8L") {
      if (data + 5 > bytes.length) {
        return null;
      }
      // signature(1) then width-1 (14 bits) and height-1 (14 bits) packed LE.
      const bits = at(data + 1) | (at(data + 2) << 8) | (at(data + 3) << 16) | (at(data + 4) << 24);
      const width = 1 + (bits & 0x3fff);
      const height = 1 + ((bits >> 14) & 0x3fff);
      return width >= 1 && height >= 1 ? { width, height } : null;
    }
    offset = data + chunkSize + (chunkSize % 2); // chunks are word-aligned
  }
  return null;
}

/**
 * Decodes one image's pixel dimensions from a bounded byte window. Null
 * when the bytes are not one of the three supported formats or the header
 * does not resolve within the window — the caller omits, never invents.
 */
export function decodeImageDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (jpegStart(bytes)) {
    return jpegDimensions(bytes);
  }
  if (pngStart(bytes)) {
    return pngDimensions(bytes);
  }
  if (webpStart(bytes)) {
    return webpDimensions(bytes);
  }
  return null;
}

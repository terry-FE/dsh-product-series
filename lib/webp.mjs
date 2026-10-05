/**
 * Minimal WebP container reader.
 *
 * Used to verify a delivered frame's real dimensions and container without
 * decoding pixels: the generation path delegates all image work to ffmpeg, and a
 * test that asked ffmpeg to check ffmpeg's own output would prove less than one
 * that reads the bytes independently.
 *
 * Covers the three chunk layouts libwebp emits: lossy (`VP8 `), lossless
 * (`VP8L`), and extended (`VP8X`, used for alpha and animation).
 */

/** Reject anything that is not a RIFF/WEBP container. */
export function isWebp(data) {
  return data.length >= 12
    && data.toString('latin1', 0, 4) === 'RIFF'
    && data.toString('latin1', 8, 12) === 'WEBP';
}

/**
 * Read the canvas dimensions from a WebP file's header.
 *
 * @param {Buffer} data - candidate WebP bytes.
 * @returns {{width: number, height: number, format: 'webp', variant: string}} parsed facts.
 * @throws {Error} when the container or chunk layout is not recognised.
 */
export function readWebpSize(data) {
  if (!isWebp(data)) throw new Error('not a WebP file (missing RIFF/WEBP signature)');

  // Walk the chunk list rather than assuming an offset: the canvas size lives in
  // the first of VP8X / VP8L / VP8, and the order is not fixed by the spec.
  let offset = 12;
  while (offset + 8 <= data.length) {
    const chunk = data.toString('latin1', offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (chunk === 'VP8X') {
      if (body + 10 > data.length) throw new Error('truncated VP8X chunk');
      // 24-bit little-endian, minus one: the field stores width - 1.
      return {
        width: 1 + (data[body + 4] | (data[body + 5] << 8) | (data[body + 6] << 16)),
        height: 1 + (data[body + 7] | (data[body + 8] << 8) | (data[body + 9] << 16)),
        format: 'webp',
        variant: 'VP8X',
      };
    }
    if (chunk === 'VP8L') {
      if (body + 5 > data.length) throw new Error('truncated VP8L chunk');
      // 14 bits of width-1 then 14 bits of height-1, packed little-endian.
      const bits = data.readUInt32LE(body + 1);
      return {
        width: 1 + (bits & 0x3fff),
        height: 1 + ((bits >> 14) & 0x3fff),
        format: 'webp',
        variant: 'VP8L',
      };
    }
    if (chunk === 'VP8 ') {
      if (body + 10 > data.length) throw new Error('truncated VP8 chunk');
      // The lossy keyframe header carries a 3-byte start code then 16-bit
      // dimensions masked to 14 bits.
      return {
        width: data.readUInt16LE(body + 6) & 0x3fff,
        height: data.readUInt16LE(body + 8) & 0x3fff,
        format: 'webp',
        variant: 'VP8',
      };
    }
    // RIFF chunks are padded to an even length.
    offset = body + size + (size % 2);
  }
  throw new Error('no VP8/VP8L/VP8X chunk found');
}

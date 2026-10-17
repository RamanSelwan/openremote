import jpeg from 'jpeg-js';

/**
 * Read width/height from a JPEG header without decoding the image.
 * Walks the marker segments until it hits a SOFn frame header.
 */
export function readJpegSize(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buf[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = buf.readUInt16BE(offset + 2);
    const isSOF =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) {
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

export function decode(buf) {
  const { data, width, height } = jpeg.decode(buf, {
    useTArray: true,
    formatAsRGBA: true,
  });
  return { data, width, height };
}

/** Nearest-neighbour downscale of RGBA pixels (fast enough for live frames). */
export function resizeNearest(src, sw, sh, dw, dh) {
  const out = new Uint8Array(dw * dh * 4);
  const xRatio = sw / dw;
  const yRatio = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor((y + 0.5) * yRatio));
    const srcRow = sy * sw;
    const dstRow = y * dw;
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor((x + 0.5) * xRatio));
      const s = (srcRow + sx) * 4;
      const d = (dstRow + x) * 4;
      out[d] = src[s];
      out[d + 1] = src[s + 1];
      out[d + 2] = src[s + 2];
      out[d + 3] = src[s + 3];
    }
  }
  return out;
}

export function encode(data, width, height, quality = 60) {
  const { data: bytes } = jpeg.encode({ data, width, height }, quality);
  return Buffer.from(bytes);
}

/**
 * Convert raw OS pixels (BGRA or RGBA) to RGBA while resizing in a single
 * nearest-neighbour pass - one loop instead of decode + resize + encode.
 */
export function convertRaw(src, sw, sh, dw, dh, isBgra) {
  const out = new Uint8Array(dw * dh * 4);
  const xRatio = sw / dw;
  const yRatio = sh / dh;
  const rOff = isBgra ? 2 : 0;
  const bOff = isBgra ? 0 : 2;
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor((y + 0.5) * yRatio));
    const srcRow = sy * sw;
    const dstRow = y * dw;
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor((x + 0.5) * xRatio));
      const s = (srcRow + sx) * 4;
      const d = (dstRow + x) * 4;
      out[d] = src[s + rOff];
      out[d + 1] = src[s + 1];
      out[d + 2] = src[s + bOff];
      out[d + 3] = 255;
    }
  }
  return out;
}

/**
 * Applies the requested scale/quality to a captured frame.
 * Accepts either a JPEG buffer or raw pixels (robotjs) and always returns
 * { data, width, height } as a JPEG buffer.
 */
export function processFrame(frame, { scale = 1, quality = 60 } = {}) {
  const { width, height } = frame;
  const targetW = Math.max(160, Math.round(width * scale));
  const targetH = Math.max(90, Math.round(height * scale));
  const needsResize = targetW < width || targetH < height;

  if (frame.raw) {
    const rgba = convertRaw(frame.raw, width, height, targetW, targetH, frame.bgra);
    return { data: encode(rgba, targetW, targetH, quality), width: targetW, height: targetH };
  }

  if (!needsResize && frame.mime === 'image/jpeg') {
    return { data: frame.data, width, height };
  }

  // Re-encode through jpeg-js when we must resize; otherwise reuse the JPEG.
  const src = decode(frame.data);
  const rgba = needsResize
    ? resizeNearest(src.data, src.width, src.height, targetW, targetH)
    : src.data;
  const outW = needsResize ? targetW : src.width;
  const outH = needsResize ? targetH : src.height;
  return { data: encode(rgba, outW, outH, quality), width: outW, height: outH };
}

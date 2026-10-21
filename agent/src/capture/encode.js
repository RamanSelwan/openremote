import { encode, processFrame as processFrameJs, convertRaw } from './jpeg.js';

/**
 * Frame processor with two backends:
 *   sharp      - native libvips; ~4x faster JPEG encoding (preferred)
 *   jpeg-js    - pure JS fallback, zero native dependencies
 *
 * Both accept the same frame shapes:
 *   { raw, width, height, bgra }              raw pixels from robotjs
 *   { data, width, height, mime }             JPEG from other capture drivers
 */


export async function createFrameProcessor() {
  let sharp = null;
  try {
    const mod = await import('sharp');
    sharp = mod.default || mod;
    // Smoke test: a native load failure must not break the agent later.
    await sharp(Buffer.alloc(2 * 2 * 4, 255), {
      raw: { width: 2, height: 2, channels: 4 },
    })
      .jpeg({ quality: 50 })
      .toBuffer();
  } catch {
    sharp = null;
  }

  const backend = sharp ? 'sharp' : 'jpeg-js';

  async function process(frame, { scale = 1, quality = 60 } = {}) {
    const targetW = Math.max(160, Math.round(frame.width * scale));
    const targetH = Math.max(90, Math.round(frame.height * scale));
    const needsResize = targetW < frame.width || targetH < frame.height;

    // ffmpeg already scaled and encoded this frame at the requested quality.
    // Re-encoding it would only burn CPU and add generational artefacts.
    if (frame.mime === 'image/jpeg' && frame.encoded && !needsResize) {
      return { data: frame.data, width: frame.width, height: frame.height };
    }

    if (!sharp) {
      return processFrameJs(frame, { scale, quality });
    }

    let pipeline;
    if (frame.raw) {
      // robotjs hands us BGRA on Windows/Linux; swap in one linear pass
      // (measured ~13 ms faster than letting libvips recombine a 4x4 matrix).
      const pixels = frame.bgra ? swapBR(frame.raw) : frame.raw;
      // Alpha is useless for JPEG; dropping it before the resize makes the
      // scaler work on 3 channels instead of 4 (~10 ms cheaper per frame).
      pipeline = sharp(pixels, {
        raw: { width: frame.width, height: frame.height, channels: 4 },
      }).removeAlpha();
    } else {
      pipeline = sharp(frame.data);
    }

    if (needsResize) {
      pipeline = pipeline.resize(targetW, targetH, {
        kernel: 'nearest',
        fastShrinkOnLoad: true,
      });
    }
    const { data, info } = await pipeline
      .jpeg({ quality, chromaSubsampling: '4:2:0', optimiseCoding: false })
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  }

  return { backend, process };
}

/** Swap R and B channels (BGRA -> RGBA). */
function swapBR(src) {
  const out = Buffer.allocUnsafe(src.length);
  for (let i = 0; i < src.length; i += 4) {
    out[i] = src[i + 2];
    out[i + 1] = src[i + 1];
    out[i + 2] = src[i];
    out[i + 3] = 255;
  }
  return out;
}

export { encode, convertRaw, processFrameJs };

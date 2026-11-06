// Reading and decoding a response body under hard bounds: the raw read is limited by the caller, the decoded size by
// `MAX_DECODED_BYTES`. The body is only analysed in memory, never stored.
import zlib from 'node:zlib';
import type { Dispatcher } from 'undici';
import { toProbeError } from './errors.ts';

/** Bound of the decoded body; the compressed read is limited separately. */
export const MAX_DECODED_BYTES = 4 * 1024 * 1024;

type Decompressor = zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress;

// Decoders by `Content-Encoding`. They finish the stream on its last byte (the default flush), so a stream that stops
// before its end is reported as an error after the prefix it decoded, instead of passing for a complete body.
const DECODERS: Readonly<Record<string, () => Decompressor>> = {
  gzip: () => zlib.createGunzip(),
  'x-gzip': () => zlib.createGunzip(),
  deflate: () => zlib.createInflate(),
  br: () => zlib.createBrotliDecompress(),
};

const encodingOf = (encoding: string | null): string => (encoding ?? '').trim().toLowerCase();

/** False for a `Content-Encoding` without a decoder here: the body is then the raw bytes, not text to read. */
export function canDecode(encoding: string | null): boolean {
  const enc = encodingOf(encoding);
  return enc === '' || enc === 'identity' || Object.hasOwn(DECODERS, enc);
}

function decompressor(enc: string): Decompressor | null {
  return Object.hasOwn(DECODERS, enc) ? (DECODERS[enc] as () => Decompressor)() : null;
}

interface DecodedBody {
  body: Buffer;
  truncated: boolean;
  /** The stream was corrupt or incomplete: `body` is what came out before the error, possibly nothing. */
  failed: boolean;
}

// Decodes a (possibly cut) body by `Content-Encoding`, streaming, with at most `maxOutput` decoded bytes so a small
// compressed response cannot expand into hundreds of megabytes. A corrupt or cut stream yields the prefix decoded so
// far; `truncated` = the output hit the limit, `failed` = the stream was corrupt or ended before its end. Whether a cut
// was expected (the read limit) the caller knows.
export function decodeBody(buf: Buffer, encoding: string | null, maxOutput: number): Promise<DecodedBody> {
  const d = decompressor(encodingOf(encoding));
  if (!d) return Promise.resolve(capBody(buf, maxOutput));
  return inflateCapped(d, buf, maxOutput);
}

function capBody(buf: Buffer, maxOutput: number): DecodedBody {
  return buf.length > maxOutput
    ? { body: buf.subarray(0, maxOutput), truncated: true, failed: false }
    : { body: buf, truncated: false, failed: false };
}

function inflateCapped(d: Decompressor, buf: Buffer, maxOutput: number) {
  return new Promise<DecodedBody>((resolve) => {
    const out: Buffer[] = [];
    let size = 0;
    let done = false;

    const finish = (truncated: boolean, failed = false) => {
      if (done) return;
      done = true;
      d.removeAllListeners('data');
      d.destroy();
      resolve({ body: Buffer.concat(out, size), truncated, failed });
    };

    d.on('data', (chunk: Buffer) => {
      const room = maxOutput - size;
      if (chunk.length > room) {
        if (room > 0) out.push(chunk.subarray(0, room));
        size += room;
        finish(true);
        return;
      }
      out.push(chunk);
      size += chunk.length;
    });
    d.on('end', () => finish(false));
    d.on('error', () => finish(false, true));

    d.end(buf);
  });
}

/** At most `readLimit` raw bytes; a stream that fails after the first byte keeps what arrived. */
export async function readPrefix(
  body: Dispatcher.ResponseData['body'],
  readLimit: number,
  signal: AbortSignal,
): Promise<{ raw: Buffer; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let read = 0;
  let truncated = false;

  try {
    for await (const chunk of body) {
      const b = chunk as Buffer;
      if (read + b.length > readLimit) {
        chunks.push(b.subarray(0, readLimit - read));
        read = readLimit;
        truncated = true;
        break;
      }
      chunks.push(b);
      read += b.length;
    }
  } catch (err) {
    if (read === 0) throw toProbeError(err, signal);
    truncated = true;
  } finally {
    if (truncated) body.destroy();
  }

  return { raw: Buffer.concat(chunks), truncated };
}

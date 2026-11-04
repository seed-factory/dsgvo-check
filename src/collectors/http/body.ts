// Reading and decoding a response body under hard bounds: the raw read is limited by the caller, the decoded size by
// `MAX_DECODED_BYTES`. The body is only analysed in memory, never stored.
import zlib from 'node:zlib';
import type { Dispatcher } from 'undici';
import { toProbeError } from './errors.ts';

/** Bound of the decoded body; the compressed read is limited separately. */
export const MAX_DECODED_BYTES = 4 * 1024 * 1024;

type Decompressor = zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress;

function decompressor(enc: string): Decompressor | null {
  if (enc === 'gzip' || enc === 'x-gzip')
    return zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH });
  if (enc === 'deflate') return zlib.createInflate({ finishFlush: zlib.constants.Z_SYNC_FLUSH });
  if (enc === 'br')
    return zlib.createBrotliDecompress({ finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH });
  return null;
}

interface DecodedBody {
  body: Buffer;
  truncated: boolean;
}

// Decodes a (possibly cut) body by `Content-Encoding`, streaming, with at most `maxOutput` decoded bytes so a small
// compressed response cannot expand into hundreds of megabytes. A corrupt or cut stream yields the prefix decoded so
// far; `truncated` = the output hit the limit.
export function decodeBody(buf: Buffer, encoding: string | null, maxOutput: number): Promise<DecodedBody> {
  const d = decompressor((encoding ?? '').trim().toLowerCase());
  if (!d) return Promise.resolve(capBody(buf, maxOutput));
  return inflateCapped(d, buf, maxOutput);
}

function capBody(buf: Buffer, maxOutput: number): DecodedBody {
  return buf.length > maxOutput
    ? { body: buf.subarray(0, maxOutput), truncated: true }
    : { body: buf, truncated: false };
}

function inflateCapped(d: Decompressor, buf: Buffer, maxOutput: number) {
  return new Promise<DecodedBody>((resolve) => {
    const out: Buffer[] = [];
    let size = 0;
    let done = false;

    const finish = (truncated: boolean) => {
      if (done) return;
      done = true;
      d.removeAllListeners('data');
      d.destroy();
      resolve({ body: Buffer.concat(out, size), truncated });
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
    d.on('error', () => finish(false));

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

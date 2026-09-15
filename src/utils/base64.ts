/**
 * Base64 encoding for microphone frames.
 *
 * Implemented here rather than relying on a global `btoa`, which is not
 * guaranteed to exist in every React Native runtime. Frames are small (a few
 * hundred bytes to a few kilobytes), so a straightforward implementation is
 * more than fast enough for realtime audio.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function encodeBase64(bytes: Uint8Array): string {
  const length = bytes.length;
  const parts: string[] = [];

  let index = 0;
  for (; index + 2 < length; index += 3) {
    const value = (bytes[index] << 16) | (bytes[index + 1] << 8) | bytes[index + 2];
    parts.push(
      ALPHABET[(value >> 18) & 63] +
        ALPHABET[(value >> 12) & 63] +
        ALPHABET[(value >> 6) & 63] +
        ALPHABET[value & 63]
    );
  }

  const remaining = length - index;
  if (remaining === 1) {
    const value = bytes[index] << 16;
    parts.push(ALPHABET[(value >> 18) & 63] + ALPHABET[(value >> 12) & 63] + '==');
  } else if (remaining === 2) {
    const value = (bytes[index] << 16) | (bytes[index + 1] << 8);
    parts.push(
      ALPHABET[(value >> 18) & 63] + ALPHABET[(value >> 12) & 63] + ALPHABET[(value >> 6) & 63] + '='
    );
  }

  return parts.join('');
}

/** Views an ArrayBuffer (or a view onto one) as bytes without copying when possible. */
export function toBytes(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

/** Splits a byte array into slices of at most `maxBytes`, preserving order. */
export function sliceBytes(bytes: Uint8Array, maxBytes: number): Uint8Array[] {
  if (bytes.byteLength <= maxBytes) return [bytes];

  const slices: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += maxBytes) {
    slices.push(bytes.subarray(offset, Math.min(offset + maxBytes, bytes.byteLength)));
  }
  return slices;
}

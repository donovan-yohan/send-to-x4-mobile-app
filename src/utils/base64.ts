/**
 * Base64 <-> Uint8Array helpers.
 *
 * Single home for what used to be verbatim copies in crosspoint_upload.ts,
 * image_converter.ts and the former queue_processor.ts, plus the encoder that
 * used to live in the former queue_prefetch.ts (both since deleted).
 *
 * Zero third-party imports; `atob`/`btoa` are provided by the Hermes/RN runtime
 * and by Node >= 16, so this module is safe to import from `scripts/*.test.js`.
 */

/** Decode a base64 string into raw bytes. */
export function base64ToUint8Array(base64: string): Uint8Array {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
}

/**
 * Encode raw bytes as base64.
 *
 * Chunked: the previous implementation built one ~N-character string by
 * repeated `+=`, which is O(n^2)-ish and unusable on the ~1 MB wallpaper
 * payloads. `String.fromCharCode.apply` is capped per chunk to stay well
 * under the engine's argument limit.
 */
export function uint8ArrayToBase64(data: Uint8Array): string {
    const CHUNK = 0x8000; // 32768 bytes per apply() call
    const parts: string[] = [];
    for (let i = 0; i < data.length; i += CHUNK) {
        const slice = data.subarray(i, Math.min(i + CHUNK, data.length));
        parts.push(String.fromCharCode.apply(null, slice as unknown as number[]));
    }
    return btoa(parts.join(''));
}

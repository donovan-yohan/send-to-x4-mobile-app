import test from 'node:test';
import { strict as assert } from 'node:assert';
import { base64ToUint8Array, uint8ArrayToBase64 } from '../src/utils/base64';

/** The pre-hoist implementation from queue_prefetch.ts:124 (O(n) string concat). */
function legacyUint8ArrayToBase64(data) {
    let binary = '';
    for (let i = 0; i < data.length; i++) {
        binary += String.fromCharCode(data[i]);
    }
    return btoa(binary);
}

test('uint8ArrayToBase64 matches the pre-hoist implementation byte-for-byte', () => {
    const cases = [
        new Uint8Array(0),
        new Uint8Array([0]),
        new Uint8Array([0, 1, 2]),
        new Uint8Array([0xff, 0xfe, 0x00, 0x7f, 0x80]),
        Uint8Array.from({ length: 255 }, (_, i) => i),
    ];
    for (const bytes of cases) {
        assert.equal(uint8ArrayToBase64(bytes), legacyUint8ArrayToBase64(bytes));
    }
});

test('uint8ArrayToBase64 is correct across the 32768-byte chunk boundary', () => {
    // The chunked encoder splits at 0x8000; sizes either side of that boundary
    // (and either side of the 3-byte base64 group) are where a naive chunker breaks.
    for (const len of [0x7fff, 0x8000, 0x8001, 0x8002, 0x8003, 0x10000, 0x10001]) {
        const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 31 + 7) & 0xff);
        assert.equal(
            uint8ArrayToBase64(bytes),
            legacyUint8ArrayToBase64(bytes),
            `mismatch at length ${len}`
        );
    }
});

test('base64ToUint8Array round-trips uint8ArrayToBase64', () => {
    // ~1 MB, the wallpaper-path size that motivated chunking.
    const bytes = Uint8Array.from({ length: 1024 * 1024 }, (_, i) => (i * 17 + 3) & 0xff);
    const decoded = base64ToUint8Array(uint8ArrayToBase64(bytes));
    assert.equal(decoded.byteLength, bytes.byteLength);
    assert.deepEqual(decoded, bytes);
});

test('base64ToUint8Array decodes a known vector', () => {
    assert.deepEqual(
        base64ToUint8Array('SGVsbG8='),
        new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f])
    );
    assert.equal(base64ToUint8Array('').byteLength, 0);
});

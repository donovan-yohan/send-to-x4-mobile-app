
/**
 * Sanitize a string to be used as a filename
 */
export function sanitizeFilename(text: string, maxLength = 80): string {
    if (!text) return 'untitled';
    return text
        .replace(/[\/\\:*?"<>|]/g, '')           // Remove illegal chars
        .replace(/\s+/g, ' ')                     // Normalize whitespace
        .replace(/[\u{1F300}-\u{1F9FF}]/gu, '')   // Remove emojis
        .trim()
        .substring(0, maxLength) || 'untitled';
}

/**
 * Generate a UUID v4
 */
let uuidFallbackCounter = 0;

export function generateUuid(): string {
    const cryptoApi = globalThis.crypto;

    if (cryptoApi?.randomUUID) {
        return cryptoApi.randomUUID();
    }

    if (cryptoApi?.getRandomValues) {
        const bytes = new Uint8Array(16);
        cryptoApi.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        return bytesToUuid(bytes);
    }

    // Last-resort fallback for runtimes without Web Crypto.
    const now = Date.now().toString(16).padStart(12, '0');
    const perfNow = typeof performance !== 'undefined'
        ? Math.floor(performance.now() * 1000).toString(16).padStart(12, '0')
        : '000000000000';
    const counter = (uuidFallbackCounter++).toString(16).padStart(8, '0');
    const seed = `${now}${perfNow}${counter}`.slice(0, 32).padEnd(32, '0').split('');

    seed[12] = '4';
    seed[16] = '8';

    return `${seed.slice(0, 8).join('')}-${seed.slice(8, 12).join('')}-${seed.slice(12, 16).join('')}-${seed.slice(16, 20).join('')}-${seed.slice(20, 32).join('')}`;
}

function bytesToUuid(bytes: Uint8Array): string {
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Validate if a string is a valid URL
 */
export function isValidUrl(text: string): boolean {
    try {
        const url = new URL(text.trim());
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

/**
 * Truncate a URL for display
 */
export function truncateUrl(url: string, maxLength = 50): string {
    if (url.length <= maxLength) return url;
    return url.substring(0, maxLength - 3) + '...';
}

import type { QueuedScreensaver, Settings, UploadResult } from '../types';
import { getScreensaverQueue, updateScreensaverStatus } from './screensaver_queue';
import { convertImageToScreensaverBmp } from './image_converter';
import { uploadScreensaverToCrossPoint } from './crosspoint_upload';
import { getCurrentIp } from './settings';
import { generateAndSaveThumbnail } from './thumbnail_generator';
import * as FileSystem from 'expo-file-system/legacy';
import { base64ToUint8Array } from '../utils/base64';

export interface ScreensaverDumpResult {
    total: number;
    succeeded: number;
    failed: { id: string; filename: string; error: string }[];
}

// Helper: read a local file as Uint8Array
async function readFileAsUint8Array(uri: string): Promise<Uint8Array> {
    const base64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
    });
    return base64ToUint8Array(base64);
}

/**
 * Process the entire screensaver queue: convert -> upload -> update status.
 */
export async function processScreensaverQueue(
    settings: Settings,
    onProgress?: (current: number, total: number, filename?: string) => void,
    onUploadProgress?: (percent: number) => void
): Promise<ScreensaverDumpResult> {
    const queue = await getScreensaverQueue();
    const pendingItems = queue.filter(
        item => item.status === 'pending' || item.status === 'failed' || item.status === 'processing'
    );

    const total = pendingItems.length;
    let current = 0;
    let succeeded = 0;
    const failed: { id: string; filename: string; error: string }[] = [];

    const ip = getCurrentIp(settings);

    for (const item of pendingItems) {
        current++;
        onProgress?.(current, total, item.filename);

        try {
            await updateScreensaverStatus(item.id, 'processing');

            let bmpData: Uint8Array;
            let bmpFilename: string;

            if (item.isPreDownloaded) {
                // Pre-downloaded BMP (from x4papers) — read directly
                bmpData = await readFileAsUint8Array(item.uri);
                bmpFilename = item.filename;
            } else {
                // Gallery image — convert to BMP
                const bmp = await convertImageToScreensaverBmp(item.uri, item.width, item.height);
                bmpData = bmp.data;
                bmpFilename = bmp.filename;
            }

            // Upload — CrossPoint only; the stock branch here was already a stub
            // that returned an error, and went with x4_upload.ts.
            const uploadResult: UploadResult = await uploadScreensaverToCrossPoint(
                ip, bmpData, bmpFilename, onUploadProgress
            );

            if (uploadResult.success) {
                // Generate a local thumbnail mapping for the sent item.
                // Always use item.uri (local file) because manipulateAsync
                // requires a local URI, not a remote URL.
                await generateAndSaveThumbnail(item.uri, bmpFilename);

                await updateScreensaverStatus(item.id, 'success');
                succeeded++;
            } else {
                throw new Error(uploadResult.error || 'Upload failed');
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            console.warn(`Failed to process screensaver ${item.filename}:`, error);
            await updateScreensaverStatus(item.id, 'failed', message);
            failed.push({ id: item.id, filename: item.filename, error: message });
        }
    }

    return { total, succeeded, failed };
}


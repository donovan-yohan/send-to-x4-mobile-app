export interface ArticleImage {
  id: string;
  filename: string;
  mediaType: string;
  data: string; // base64 encoded string
}

// Article extracted from a URL
export interface Article {
  title: string;
  author: string;
  date: string;           // YYYY-MM-DD format
  body: string;           // Clean HTML content
  rawText: string;        // Plain text
  wordCount: number;
  sourceUrl: string;
  images?: ArticleImage[]; // Optional array of downloaded images
}

// Result of article extraction
export interface ExtractionResult {
  success: boolean;
  article?: Article;
  error?: string;
}

// Result of EPUB generation
export interface EpubResult {
  data: Uint8Array;     // The EPUB file as bytes
  filename: string;     // Suggested filename
}

// Result of X4 upload
export interface UploadResult {
  success: boolean;
  error?: string;
}

// The messenger's two operating modes.
//   host   — paired with the reader over Wi-Fi, owns PERMANENT device state
//            (wallpaper, file browser) and relays messages.
//   client — partner's phone, no direct reader access; only sends TEMPORARY
//            love-notes through the mailbox.
// Declared here rather than in services/role.ts so `Settings` stays free of
// service imports; role.ts re-exports it as `Role`.
export type Role = 'host' | 'client';

// App settings
//
// PERSISTENCE CONTRACT (see R8): this is an UNVERSIONED JSON blob under the
// single key '@send-to-x4/settings', loaded as `{ ...DEFAULTS, ...JSON.parse }`.
// There is no migration hook. ADDING a field is backward-compatible for free.
// REMOVING one is only safe if every coercion that dereferences it in
// services/settings.ts is deleted in the same change — otherwise getSettings()
// throws on existing installs. Keys removed from this interface (firmwareType,
// stockIp) linger in already-written blobs forever; that is harmless because the
// spread simply carries unknown keys through.
export interface Settings {
  // Device — CrossPoint firmware only. The stock-firmware fork (stockIp,
  // firmwareType) was removed together with src/services/x4_upload.ts.
  crossPointIp: string;
  articleFolder: string;
  noteFolder: string;
  useDateFolders: boolean;
  includeImagesInArticles: boolean;
  hideAiWallpapers: boolean;
  hideSensitiveWallpapers: boolean;

  // Messenger role / pairing model.
  role: Role;
  /** Shared secret established at pairing time. Absent until paired. */
  pairingSecret?: string;
  /** SSID of the reader's own access point (M3 auto-join). */
  apSsid: string;
  /**
   * WPA2 passphrase for that access point. Empty means an OPEN AP.
   *
   * The firmware's `AP_PASSWORD` is a compile-time `nullptr` today, so open is
   * the shipping state and '' is the correct default — but A3's security finding
   * makes a per-reader PSK REQUIRED before the unattended variant exists (an
   * open AP lets a stranger occupy one of four station slots, and lets an
   * on-link attacker impersonate the proxy and serve the reader a book the user
   * never sent). Stored per install rather than derived from `pairingSecret`
   * because it is the reader's own compile/provision-time secret, shown on its
   * panel, not something the app gets to choose.
   *
   * Like `mailboxWriteToken`, this NEVER leaves the phone except into the
   * platform's Wi-Fi join request — it is not written to the reader, and not
   * part of any URL.
   */
  readerApPsk?: string;
  /** Base URL of the tailnet mailbox a client posts to. Absent until configured. */
  mailboxUrl?: string;
  /**
   * Bearer token for WRITING to that mailbox. Absent until configured.
   *
   * SEPARATE FROM mailboxUrl ON PURPOSE. `mailboxUrl` is the exact string that
   * gets typed into the READER (its `messageSyncUrl` setting, 128 chars max),
   * and the reader has no secret storage — it echoes its settings back over its
   * own HTTP API. A token folded into the URL would therefore be readable by
   * anyone who can reach the reader. The firmware sends no auth headers on its
   * reads, so the read side is protected by the unguessable URL alone; this
   * token protects only the write side, and never leaves the phone except as an
   * `Authorization: Bearer` header (see services/mailbox_client.ts).
   */
  mailboxWriteToken?: string;
}

// Connection status
export interface ConnectionStatus {
  connected: boolean;
  ip: string;
  /**
   * Mirrored from Settings.role so status surfaces (banner, StatusIndicator) can
   * render without reaching for settings separately. A client has no direct
   * reader access, so for `role === 'client'` `connected` should eventually
   * describe MAILBOX reachability rather than reader reachability.
   */
  role: Role;
  checking: boolean;
  lastError?: string;
  /**
   * `Date.now()` at the moment the probe that produced `connected` RESOLVED —
   * absent until the first one has.
   *
   * Load-bearing, not telemetry: a send's fast skip
   * (`services/reader_reachability.ts`) will trust this instead of paying for
   * its own probe, and without an age there is no way to tell an observation
   * from one second ago from one that has sat in the context since launch.
   * Trusting the latter is what would route a note to the mailbox while the
   * reader sits awake on the desk.
   */
  checkedAt?: number;
}

// App state
export type AppState =
  | 'idle'
  | 'clipboard-detected'
  | 'processing'
  | 'success'
  | 'error'
  | 'not-connected';

// Remote file on X4
export interface RemoteFile {
  name: string;
  rawName?: string; // Original filename from server (may be URL encoded)
  size?: number;
  date?: string; // Parsed or raw date
  timestamp?: number; // Used for sorting
  folder?: string; // Which folder the file lives in (for date-subfolder deletion)
}

// A queued article reference (saved for later batch sending)
export interface QueuedArticle {
  id: string;            // unique ID (timestamp-based)
  url: string;           // the article URL
  title?: string;        // optional display title (from og:title or domain)
  addedAt: number;       // timestamp when added to queue
  status: 'pending' | 'processing' | 'failed';
  errorMessage?: string; // populated when status === 'failed'
  isLocalFile?: boolean; // true if this is a local .epub file (skip extraction)
  cachedEpubPath?: string;     // local filesystem path to pre-fetched EPUB
  cachedEpubFilename?: string; // original EPUB filename for upload
}

// Result of a batch dump operation
export interface DumpResult {
  total: number;
  succeeded: number;
  failed: { id: string; url: string; title?: string; error: string }[];
}

// ── Canvas / composer element model ─────────────────────────────────
// Hoisted out of the old src/screens/SleepScreenTab.tsx (since deleted) so that
// services (design_storage) no longer type-depend on a screen module.

export type CanvasElementType = 'text' | 'image' | 'sign';

export interface CanvasElement {
  id: string;
  type: CanvasElementType;
  content: string; // text string or image URI
  x: number;
  y: number;
  scale: number;
  rotation: number;
  zIndex: number;
  locked: boolean;
}

// A payload handed over by the OS share sheet (expo-share-intent).
// Single owner: the Compose screen (App.tsx routes both media and text there).
export interface SharedImage {
  uri: string;
  filename: string;
  width?: number;
  height?: number;
}

// A queued screensaver image
export interface QueuedScreensaver {
  id: string;            // unique ID (timestamp-based)
  uri: string;           // local file URI
  filename: string;      // desired filename (e.g. "image.bmp")
  width?: number;        // optional dimensions (if known)
  height?: number;
  addedAt: number;
  status: 'pending' | 'processing' | 'failed' | 'success';
  error?: string;
  sourceUrl?: string;        // webp preview URL (for x4papers items)
  isPreDownloaded?: boolean; // true if uri already points to a ready-to-upload BMP
}

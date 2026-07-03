'use strict';

// Minimal dependency-free ZIP writer (STORE method, no compression).
// Files inside the archive keep their category folder structure, e.g.
// images/<character>/file.png, chat-backups/file.jsonl, thumbnails/avatars/x.png.
// Names are encoded as UTF-8 (general purpose bit 11) so cyrillic file names work.

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[n] = c >>> 0;
    }
    return table;
})();

// CRC over a slice, resumable: pass the previous raw state to continue.
function crc32Chunk(bytes, start, end, state) {
    let crc = state;
    for (let i = start; i < end; i++) {
        crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return crc;
}

// CRC32 is the only CPU-heavy part of packing. Computing it synchronously
// over multi-gigabyte selections froze the UI (and the progress bar) for
// seconds. This version processes data in slices and yields to the event
// loop between them so rendering, animations, and progress updates keep going.
const CRC_YIELD_SLICE = 8 * 1024 * 1024; // 8 MB per slice between yields

async function crc32Async(bytes) {
    let crc = 0xFFFFFFFF;
    for (let start = 0; start < bytes.length; start += CRC_YIELD_SLICE) {
        crc = crc32Chunk(bytes, start, Math.min(start + CRC_YIELD_SLICE, bytes.length), crc);
        if (start + CRC_YIELD_SLICE < bytes.length) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(date = new Date()) {
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const day = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time, day };
}

// Resolve duplicate archive paths by appending " (n)" before the extension.
function uniquePath(path, usedPaths) {
    if (!usedPaths.has(path)) {
        return path;
    }
    const slash = path.lastIndexOf('/');
    const dot = path.lastIndexOf('.');
    const hasExt = dot > slash + 1;
    let candidate;
    let index = 1;
    do {
        candidate = hasExt
            ? `${path.slice(0, dot)} (${index})${path.slice(dot)}`
            : `${path} (${index})`;
        index += 1;
    } while (usedPaths.has(candidate));
    return candidate;
}

/**
 * Build a ZIP archive Blob from entries without blocking the UI thread.
 * CRC work is sliced with event-loop yields, and `onProgress(done, total)`
 * fires after each entry so the caller can drive a live progress bar.
 * @param {{path: string, data: Uint8Array}[]} entries Archive entries; `path` may contain forward slashes for folders.
 * @param {(done: number, total: number) => void} [onProgress] Called after each packed entry.
 * @returns {Promise<Blob>} The assembled zip file.
 */
export async function buildZipBlob(entries, onProgress) {
    const encoder = new TextEncoder();
    const { time, day } = dosDateTime();
    const localParts = [];
    const centralParts = [];
    const usedPaths = new Set();
    let offset = 0;
    let done = 0;

    for (const entry of entries) {
        const cleanPath = uniquePath(String(entry.path).replace(/\\/g, '/').replace(/^\/+/, ''), usedPaths);
        usedPaths.add(cleanPath);
        const nameBytes = encoder.encode(cleanPath);
        const data = entry.data;
        const crc = await crc32Async(data);

        const local = new DataView(new ArrayBuffer(30));
        local.setUint32(0, 0x04034B50, true);      // local file header signature
        local.setUint16(4, 20, true);              // version needed to extract
        local.setUint16(6, 0x0800, true);          // flags: UTF-8 names
        local.setUint16(8, 0, true);               // method: store
        local.setUint16(10, time, true);
        local.setUint16(12, day, true);
        local.setUint32(14, crc, true);
        local.setUint32(18, data.length, true);    // compressed size
        local.setUint32(22, data.length, true);    // uncompressed size
        local.setUint16(26, nameBytes.length, true);
        local.setUint16(28, 0, true);              // extra field length
        localParts.push(new Uint8Array(local.buffer), nameBytes, data);

        const central = new DataView(new ArrayBuffer(46));
        central.setUint32(0, 0x02014B50, true);    // central directory signature
        central.setUint16(4, 20, true);            // version made by
        central.setUint16(6, 20, true);            // version needed
        central.setUint16(8, 0x0800, true);        // flags: UTF-8 names
        central.setUint16(10, 0, true);            // method: store
        central.setUint16(12, time, true);
        central.setUint16(14, day, true);
        central.setUint32(16, crc, true);
        central.setUint32(20, data.length, true);
        central.setUint32(24, data.length, true);
        central.setUint16(28, nameBytes.length, true);
        // extra(30), comment(32), disk(34), internal attrs(36), external attrs(38) all zero
        central.setUint32(42, offset, true);       // local header offset
        centralParts.push(new Uint8Array(central.buffer), nameBytes);

        offset += 30 + nameBytes.length + data.length;
        done += 1;
        onProgress?.(done, entries.length);
    }

    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054B50, true);           // end of central directory signature
    eocd.setUint16(8, usedPaths.size, true);       // entries on this disk
    eocd.setUint16(10, usedPaths.size, true);      // total entries
    eocd.setUint32(12, centralSize, true);
    eocd.setUint32(16, offset, true);              // central directory offset
    eocd.setUint16(20, 0, true);                   // comment length

    return new Blob([...localParts, ...centralParts, new Uint8Array(eocd.buffer)], { type: 'application/zip' });
}

'use strict';

// script.js lives at public/script.js, i.e. four levels up from
// scripts/extensions/third-party/<name>/ — not three. A wrong path here means
// getRequestHeaders (and its CSRF token) is silently missing, so every POST
// request gets rejected with 403 and scans return nothing.
const _st = await import('../../../../script.js').catch(() => ({}));
const getRequestHeaders = _st.getRequestHeaders
    ?? window.SillyTavern?.getContext?.()?.getRequestHeaders
    ?? window.getRequestHeaders
    ?? (() => ({}));

/** Low-level fetch wrapper that injects SillyTavern request headers. */
export async function apiRequestJson(url, options = {}) {
    const response = await fetch(url, {
        credentials: 'include',
        cache: 'no-store',
        ...options,
        headers: {
            ...(options.headers || {}),
            ...getRequestHeaders(options.omitContentType ? { omitContentType: true } : undefined),
        },
    });

    return response;
}

/** POST a JSON body and return the parsed JSON response, throwing on non-2xx. */
export async function postJson(url, body, options = {}) {
    const response = await apiRequestJson(url, {
        method: 'POST',
        body: JSON.stringify(body),
        ...options,
    });

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`${url} failed: ${response.status} ${response.statusText}${text ? ` — ${text}` : ''}`);
    }

    return response.json();
}

// Cache of resolved image sizes keyed by relative image path. Image files are
// immutable once written (SillyTavern always creates new files), so a size that
// was resolved once stays valid for the lifetime of the dialog. This avoids
// re-issuing HEAD/range requests on rescans and before delete/download.
const imageSizeCache = new Map();

export function invalidateImageSize(path) {
    imageSizeCache.delete(path);
}

export function clearImageSizeCache() {
    imageSizeCache.clear();
}

// Range-request fallback for servers that don't return content-length on HEAD.
async function resolveSizeViaRange(url) {
    try {
        // Try to get total size from the content-range header.
        const ranged = await apiRequestJson(url, {
            method: 'GET',
            omitContentType: true,
            headers: { Range: 'bytes=0-0' },
        });

        const contentRange = ranged.headers.get('content-range');
        if (contentRange) {
            const match = /\/(\d+)\s*$/.exec(contentRange); // ".../<total>"
            if (match) {
                return Number(match[1]);
            }
        }

        // Server ignored the Range header (200 instead of 206) — content-length is the full size.
        if (ranged.status === 200) {
            const length = Number(ranged.headers.get('content-length'));
            if (Number.isFinite(length) && length >= 0) {
                return length;
            }
            const buffer = await ranged.arrayBuffer();
            return buffer.byteLength;
        }

        // Range was honoured (206) but content-range is absent — last resort: full GET.
        const full = await apiRequestJson(url, { method: 'GET', omitContentType: true });
        const fullLength = Number(full.headers.get('content-length'));
        if (Number.isFinite(fullLength) && fullLength >= 0) {
            return fullLength;
        }
        const fullBuffer = await full.arrayBuffer();
        return fullBuffer.byteLength;
    } catch {
        return 0;
    }
}

/** Resolve a static file's byte size, caching by `cacheKey`. */
export async function resolveStaticSize(url, cacheKey = url) {
    if (imageSizeCache.has(cacheKey)) {
        return imageSizeCache.get(cacheKey);
    }

    let size = null;
    try {
        // A single HEAD request is the fast path and works for the vast majority
        // of setups. Only fall back to a range GET when content-length is absent.
        const head = await apiRequestJson(url, { method: 'HEAD', omitContentType: true });
        if (head.ok) {
            const length = Number(head.headers.get('content-length'));
            if (Number.isFinite(length) && length >= 0) {
                size = length;
            }
        }
    } catch {
        // ignore and fall back to the range request
    }

    if (size === null) {
        size = await resolveSizeViaRange(url);
    }

    imageSizeCache.set(cacheKey, size);
    return size;
}

export function buildImageUrl(folder, filename) {
    return `/user/images/${encodeURIComponent(folder)}/${encodeURIComponent(filename)}`;
}

export function imagePath(folder, filename) {
    return `user/images/${folder}/${filename}`;
}

export class DataMaidUnavailableError extends Error {
    constructor(message) {
        super(message);
        this.name = 'DataMaidUnavailableError';
    }
}

// HTTP statuses that mean "this SillyTavern build has no Data Maid endpoint"
// rather than a transient failure worth surfacing as an error.
const DATA_MAID_MISSING_STATUSES = new Set([404, 501]);

/** Fetch the Data Maid report, throwing DataMaidUnavailableError when absent. */
export async function scanCleanupReport() {
    // TauriTavern (Tauri v2 + Rust backend) intercepts API fetches with its own
    // route registry, which has no data-maid routes — the endpoint does not
    // exist on that platform. Short-circuit instead of firing a request that
    // may fall through to the webview and return misleading non-JSON content.
    if (typeof window !== 'undefined' && window.__TAURITAVERN__) {
        throw new DataMaidUnavailableError('Data Maid is not implemented by the TauriTavern backend');
    }

    let response;
    try {
        response = await apiRequestJson('/api/data-maid/report', {
            method: 'POST',
            omitContentType: true,
        });
    } catch (error) {
        // Network-level failure (endpoint not reachable) — treat as unavailable.
        throw new DataMaidUnavailableError(error?.message || 'Data Maid unreachable');
    }

    if (DATA_MAID_MISSING_STATUSES.has(response.status)) {
        throw new DataMaidUnavailableError(`Data Maid not available (${response.status})`);
    }

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Data Maid report failed: ${response.status} ${response.statusText}${text ? ` — ${text}` : ''}`);
    }

    // A 200 response that isn't JSON (e.g. an HTML fallback page served by a
    // build without the endpoint) also means Data Maid is absent, not broken.
    try {
        return await response.json();
    } catch {
        throw new DataMaidUnavailableError('Data Maid endpoint returned a non-JSON response');
    }
}

/** Best-effort release of a Data Maid token; failures are ignored. */
export async function finalizeToken(token) {
    if (!token) {
        return;
    }
    try {
        await postJson('/api/data-maid/finalize', { token });
    } catch (error) {
        console.debug('Cleanup finalize ignored:', error);
    }
}

// HTTP statuses that commonly indicate an invalid/expired Data Maid token.
export function isLikelyTokenError(status) {
    return status === 400 || status === 401 || status === 403 || status === 409 || status === 419;
}

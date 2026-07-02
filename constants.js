'use strict';

export const MODULE_NAME = 'Cleaning';

// Concurrency limits. Image scanning is nested: up to IMAGE_SCAN_CONCURRENCY
// folders are processed in parallel, and within each folder up to
// IMAGE_SIZE_CONCURRENCY size probes run at once. The effective peak of
// simultaneous requests is therefore roughly the product of the two, so keep it
// below typical browser per-host connection limits.
export const IMAGE_SCAN_CONCURRENCY = 4;   // folders scanned in parallel
export const IMAGE_SIZE_CONCURRENCY = 8;   // size probes per folder (~32 peak)
export const DELETE_CONCURRENCY = 8;       // parallel image delete requests
export const DATA_MAID_DELETE_CHUNK = 50;  // hashes per Data Maid delete request

// Downloads: more than ZIP_DOWNLOAD_THRESHOLD selected files are packed into a
// single zip archive (organized by category folders) instead of being
// downloaded one by one.
export const ZIP_DOWNLOAD_THRESHOLD = 5;
export const DOWNLOAD_CONCURRENCY = 4;      // parallel file fetches while zipping

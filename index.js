'use strict';

import { callGenericPopup, Popup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';
import { humanFileSize } from '../../../utils.js';
import { t } from '../../../i18n.js';

import {
    MODULE_NAME,
    IMAGE_SCAN_CONCURRENCY,
    IMAGE_SIZE_CONCURRENCY,
    DELETE_CONCURRENCY,
    DATA_MAID_DELETE_CHUNK,
    ZIP_DOWNLOAD_THRESHOLD,
    DOWNLOAD_CONCURRENCY,
} from './constants.js';
import { buildZipBlob } from './zip.js';
import { ce, setI18n, makePlainButton, mapLimit } from './dom.js';
import {
    apiRequestJson,
    postJson,
    resolveStaticSize,
    invalidateImageSize,
    clearImageSizeCache,
    buildImageUrl,
    imagePath,
    DataMaidUnavailableError,
    scanCleanupReport,
    finalizeToken,
    isLikelyTokenError,
} from './api.js';

const state = {
    root: null,
    popupOpen: false,
    busy: false,
    scanning: false,
    token: null,
    report: null,
    images: null,
    dataMaidAvailable: true,

    progressTotal: 0,
    progressDone: 0,
    progressMessage: '',
};

function updateProgress(root, message, done = state.progressDone, total = state.progressTotal) {
    if (!root) {
        return;
    }
    state.progressDone = done;
    state.progressTotal = total;
    state.progressMessage = message || '';
    const bar = root.querySelector('.cleanupProgressBar');
    const text = root.querySelector('.cleanupProgressText');
    const percent = total > 0 ? Math.max(0, Math.min(100, (done / total) * 100)) : 0;
    if (bar) {
        bar.style.width = `${percent.toFixed(2)}%`;
    }
    if (text) {
        text.textContent = message || '';
    }
}

function updateSummary(root) {
    if (!root) {
        return;
    }
    const selected = [...root.querySelectorAll('input[data-cleanup-item]:checked:not(:disabled)')];
    const totalBytes = selected.reduce((sum, input) => sum + Number(input.dataset.bytes || 0), 0);
    const totalCount = selected.length;
    const summaryBytes = root.querySelector('.cleanupSummaryBytes');
    const summaryCount = root.querySelector('.cleanupSummaryCount');
    if (summaryBytes) {
        summaryBytes.textContent = humanFileSize(totalBytes);
    }
    if (summaryCount) {
        summaryCount.textContent = String(totalCount);
    }
    const imageDeleteButtons = root.querySelectorAll('[data-image-delete-action]');
    for (const button of imageDeleteButtons) {
        button.disabled = state.busy;
    }
    const genericDeleteButtons = root.querySelectorAll('[data-generic-delete-action]');
    for (const button of genericDeleteButtons) {
        button.disabled = state.busy;
    }
}

function getSectionSelectedInputs(root, sectionKey) {
    const section = root.querySelector(`[data-section="${CSS.escape(sectionKey)}"]`);
    return section ? [...section.querySelectorAll('input[data-cleanup-item]:checked:not(:disabled)')] : [];
}

function getSectionSelectedIds(root, sectionKey) {
    return getSectionSelectedInputs(root, sectionKey).map(input => input.dataset.cleanupId).filter(Boolean);
}

function setBusy(root, busy, message = '') {
    state.busy = busy;
    if (root) {
        root.classList.toggle('cleanupBusy', busy);
        const scanButton = root.querySelector('[data-cleanup-scan]');
        if (scanButton) {
            scanButton.disabled = busy;
        }
        const closeButton = root.closest('dialog')?.querySelector('.popup-button-ok');
        if (closeButton) {
            closeButton.disabled = busy;
        }
    }
    updateProgress(root, message || (busy ? t`Scanning...` : ''), state.progressDone, state.progressTotal);
    updateSummary(root);
}

// Progress label for long deletions: "Delete in progress 123/456 • 1.2 GB".
// The live counter and freed-bytes total make it obvious the job is moving
// even when individual files (large backups, big image packs) take a while.
function formatDeleteProgress(done, total, freedBytes) {
    const base = `${t`Delete in progress`} ${done}/${total}`;
    return freedBytes > 0 ? `${base} • ${humanFileSize(freedBytes)}` : base;
}

function sortByMtimeThenNameDesc(a, b) {
    return (Number(b.mtime || 0) - Number(a.mtime || 0)) || String(b.name || '').localeCompare(String(a.name || ''));
}

// Image folders that must never be deleted: reference folders (*_refs) and
// the "generated" folder with images produced by image generation.
function isProtectedImageFolder(folder) {
    return /_refs$/i.test(folder) || /^generated$/i.test(String(folder).trim());
}

async function scanChatImages(root, progressRoot = root) {
    const folders = await postJson('/api/images/folders', {});
    const sortedFolders = [...folders].sort((a, b) => String(a).localeCompare(String(b)));
    const folderData = [];
    let processed = 0;
    const total = sortedFolders.length;
    updateProgress(progressRoot, t`Refreshing...`, 0, total || 1);

    await mapLimit(sortedFolders, IMAGE_SCAN_CONCURRENCY, async folder => {
        const fileNames = await postJson('/api/images/list', {
            folder,
            sortField: 'date',
            sortOrder: 'desc',
        });
        const files = await mapLimit(fileNames, IMAGE_SIZE_CONCURRENCY, async filename => {
            const url = buildImageUrl(folder, filename);
            const path = imagePath(folder, filename);
            const size = await resolveStaticSize(url, path);
            return {
                folder,
                filename,
                path,
                url,
                size,
                protected: isProtectedImageFolder(folder),
            };
        });
        const totalSize = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
        folderData.push({
            folder,
            protected: isProtectedImageFolder(folder),
            files,
            totalSize,
            count: files.length,
        });
        processed += 1;
        updateProgress(progressRoot, `${t`Scanning...`} ${processed}/${total || 1}`, processed, total || 1);
    });

    folderData.sort((a, b) => String(a.folder).localeCompare(String(b.folder)));
    return folderData;
}

// Sections are collapsible <details> blocks: the summary shows the category
// title with total count and size, and the item lists stay hidden until the
// user expands the section, keeping the dialog compact by default.
function createSectionCard({ key, title, note, buttons = [], totals = null, open = false }) {
    const section = ce('details', 'cleanupSection', { 'data-section': key });
    section.open = open;
    const header = ce('summary', 'cleanupSectionHeader');
    header.append(ce('i', 'fa-solid fa-chevron-right cleanupSectionChevron'));
    const titleWrap = ce('div', 'cleanupSectionTitleWrap');
    const titleRow = ce('div', 'cleanupSectionTitleRow');
    const heading = ce('h3', '', { text: title });
    setI18n(heading, title);
    titleRow.append(heading);
    if (totals) {
        const totalsEl = ce('span', 'cleanupSectionTotals', {
            text: `${totals.count} • ${humanFileSize(totals.bytes)}`,
        });
        titleRow.append(totalsEl);
    }
    titleWrap.append(titleRow);
    if (note) {
        const noteEl = ce('div', 'cleanupSectionNote', { text: note });
        setI18n(noteEl, note);
        titleWrap.append(noteEl);
    }
    header.append(titleWrap);
    const headerButtons = ce('div', 'cleanupSectionActions');
    for (const button of buttons) {
        headerButtons.append(button);
    }
    header.append(headerButtons);
    section.append(header);
    return section;
}

// Compute {count, bytes} totals for a flat item list (files or report entries).
function sumTotals(items, sizeKey = 'size') {
    return {
        count: items.length,
        bytes: items.reduce((sum, item) => sum + Number(item[sizeKey] || 0), 0),
    };
}

function renderDataMaidUnavailableNotice() {
    const section = createSectionCard({
        key: 'dataMaidUnavailable',
        title: t`Backups & thumbnails`,
        note: '',
        open: true,
    });
    const notice = ce('div', 'cleanupEmpty cleanupNotice', {
        text: t`Data Maid is not available in this SillyTavern build, so chat backups, settings backups, and orphan thumbnails cannot be scanned. Chat image cleanup still works.`,
    });
    setI18n(notice, 'Data Maid is not available in this SillyTavern build, so chat backups, settings backups, and orphan thumbnails cannot be scanned. Chat image cleanup still works.');
    section.append(notice);
    return section;
}

function createSelectionButton(label, className, actionName) {
    const button = makePlainButton(label, className);
    button.dataset[actionName] = 'true';
    return button;
}

// Filter visible rows within a section by a case-insensitive substring of the
// item name. Empty query shows everything. Also toggles empty-result hints and
// hides folder groups (details) that end up with no visible rows.
function applySectionFilter(section, query) {
    const needle = String(query || '').trim().toLowerCase();
    const rows = section.querySelectorAll('.cleanupItemRow');
    for (const row of rows) {
        const name = row.querySelector('.cleanupItemName')?.textContent?.toLowerCase() || '';
        const match = !needle || name.includes(needle);
        row.classList.toggle('cleanupHidden', !match);
    }
    // Collapse folder groups (image section) that have no visible rows.
    for (const folder of section.querySelectorAll('.cleanupFolder')) {
        const anyVisible = [...folder.querySelectorAll('.cleanupItemRow')].some(r => !r.classList.contains('cleanupHidden'));
        folder.classList.toggle('cleanupHidden', Boolean(needle) && !anyVisible);
    }
    // Same for thumbnail sub-sections.
    for (const sub of section.querySelectorAll('.cleanupSubSection')) {
        const anyVisible = [...sub.querySelectorAll('.cleanupItemRow')].some(r => !r.classList.contains('cleanupHidden'));
        sub.classList.toggle('cleanupHidden', Boolean(needle) && !anyVisible);
    }
}

function createSectionFilter(section) {
    const wrap = ce('div', 'cleanupFilter');
    const input = ce('input', 'text_pole cleanupFilterInput', {
        type: 'search',
        placeholder: t`Filter by name...`,
    });
    setI18n(input, 'Filter by name...', true);
    input.addEventListener('input', () => applySectionFilter(section, input.value));
    wrap.append(input);
    return wrap;
}

// Reorder the rows of every item list inside a section without rebuilding them.
// Sorting operates on the live DOM so it composes with filtering and selection.
// Lists are rendered newest-first, so the "newest" mode restores the original
// DOM order captured before the first reordering.
const SECTION_SORTERS = {
    'newest': (a, b) => a.originalIndex - b.originalIndex,
    'name-asc': (a, b) => a.name.localeCompare(b.name),
    'name-desc': (a, b) => b.name.localeCompare(a.name),
    'size-desc': (a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name),
    'size-asc': (a, b) => a.bytes - b.bytes || a.name.localeCompare(b.name),
};

function applySectionSort(section, mode) {
    const sorter = SECTION_SORTERS[mode];
    if (!sorter) {
        return;
    }
    // Rows may live directly inside a `.cleanupItemList` (image folders) or a
    // `.cleanupFlatList` (Data Maid lists and thumbnail sub-sections). Reorder
    // rows within their own parent so each group/sub-section is sorted in place.
    const lists = new Set();
    for (const row of section.querySelectorAll('.cleanupItemRow')) {
        if (row.parentElement) {
            lists.add(row.parentElement);
        }
    }
    for (const list of lists) {
        const rows = [...list.querySelectorAll(':scope > .cleanupItemRow')];
        // Stamp the initial (newest-first) position once, before any reorder,
        // so the default "Newest first" mode can restore it later.
        rows.forEach((row, index) => {
            if (row.dataset.cleanupOriginalIndex === undefined) {
                row.dataset.cleanupOriginalIndex = String(index);
            }
        });
        const decorated = rows.map(row => ({
            row,
            name: row.querySelector('.cleanupItemName')?.textContent || '',
            bytes: Number(row.querySelector('input[data-cleanup-item]')?.dataset.bytes || 0),
            originalIndex: Number(row.dataset.cleanupOriginalIndex || 0),
        }));
        decorated.sort(sorter);
        for (const { row } of decorated) {
            list.append(row);
        }
    }
}

function createSectionSort(section) {
    const wrap = ce('div', 'cleanupSort');
    const select = ce('select', 'text_pole cleanupSortSelect');
    setI18n(select, 'Sort', true);
    const options = [
        { value: 'newest', label: t`Newest first` },
        { value: 'size-desc', label: t`Largest first` },
        { value: 'size-asc', label: t`Smallest first` },
        { value: 'name-asc', label: t`Name (A–Z)` },
        { value: 'name-desc', label: t`Name (Z–A)` },
    ];
    for (const opt of options) {
        const optionEl = ce('option', '', { value: opt.value, text: opt.label });
        setI18n(optionEl, opt.label);
        select.append(optionEl);
    }
    select.addEventListener('change', () => applySectionSort(section, select.value));
    wrap.append(select);
    return wrap;
}

function renderCheckboxRow({ id, name, size, disabled = false, checked = false, meta = '', badge = null, checkboxTitle = null, extraActions = [] }) {
    const row = ce('div', 'cleanupItemRow');
    const label = ce('label', 'cleanupItemLabel');
    const checkbox = ce('input', '', {
        type: 'checkbox',
        'data-cleanup-item': 'true',
        'data-cleanup-id': id,
        'data-bytes': String(size || 0),
    });
    if (checkboxTitle) {
        setI18n(checkbox, checkboxTitle, true);
    }
    checkbox.checked = checked;
    checkbox.disabled = disabled;
    label.append(checkbox, ce('span', 'cleanupItemName', { text: name }));
    const metaWrap = ce('div', 'cleanupItemActions');
    if (badge) {
        metaWrap.append(ce('span', `cleanupBadge ${badge.className || ''}`.trim(), { text: badge.text }));
    }
    if (meta) {
        metaWrap.append(ce('span', 'cleanupItemMeta', { text: meta }));
    }
    for (const action of extraActions) {
        metaWrap.append(action);
    }
    if (disabled) {
        row.classList.add('cleanupDisabled');
    }
    row.append(label, metaWrap);
    return row;
}

function renderGroupControls({ root, sectionKey, items, disabled = false, deleteHandler, downloadHandler = null, selectLabel = t`Select all in group`, deleteLabel = t`Delete group` }) {
    const controls = ce('div', 'cleanupFolderActions');
    const selectAll = createSelectionButton(selectLabel, 'cleanupGroupSelectAll', 'cleanupGroupSelectAll');
    setI18n(selectAll, selectLabel);
    selectAll.disabled = disabled || !items.length;
    selectAll.addEventListener('click', () => {
        const currentChecked = items.filter(item => item.checkbox && !item.checkbox.disabled && item.checkbox.checked).length;
        const target = currentChecked !== items.filter(item => !item.checkbox.disabled).length;
        for (const item of items) {
            if (!item.checkbox.disabled) {
                item.checkbox.checked = target;
            }
        }
        updateSummary(root);
    });
    controls.append(selectAll);

    const deleteButton = createSelectionButton(deleteLabel, 'cleanupGroupDelete', 'cleanupGroupDelete');
    setI18n(deleteButton, deleteLabel);
    deleteButton.disabled = disabled || !items.length;
    deleteButton.addEventListener('click', async () => {
        if (disabled || !items.length) {
            return;
        }
        await deleteHandler(items);
    });
    controls.append(deleteButton);

    if (downloadHandler) {
        const downloadButton = createSelectionButton(t`Download selected before deleting`, 'cleanupGroupDownload', 'cleanupGroupDownload');
        setI18n(downloadButton, t`Download selected before deleting`);
        downloadButton.disabled = disabled || !items.length;
        downloadButton.addEventListener('click', async () => {
            if (disabled || !items.length) {
                return;
            }
            await downloadHandler(items);
        });
        controls.append(downloadButton);
    }

    return controls;
}

function renderImageFolder(root, folderData, handlers) {
    const details = ce('details', 'cleanupFolder');
    // Folders start collapsed: the summary already shows per-character count
    // and total size, and files appear only when the folder is expanded.
    const summary = ce('summary', 'cleanupFolderSummary');
    const titleWrap = ce('div', 'cleanupFolderHeader');
    const title = ce('strong', '', { text: folderData.folder });
    const count = ce('span', 'cleanupFolderMeta', { text: `${t`Count`}: ${folderData.count}` });
    const size = ce('span', 'cleanupFolderMeta', { text: `${t`Size`}: ${humanFileSize(folderData.totalSize)}` });
    titleWrap.append(title, count, size);
    if (folderData.protected) {
        titleWrap.append(ce('span', 'cleanupBadge cleanupBadgeProtected', { text: t`Protected` }));
    }
    summary.append(titleWrap);
    details.append(summary);

    const body = ce('div', 'cleanupFolderDetails');

    // Build rows first so each file.checkbox points to the real checkbox node
    // before we pass the same file objects into renderGroupControls.
    const list = ce('div', 'cleanupItemList');
    for (const file of folderData.files) {
        const row = renderCheckboxRow({
            id: file.path,
            name: file.filename,
            size: file.size,
            disabled: folderData.protected,
            meta: humanFileSize(file.size),
            badge: folderData.protected ? { className: 'cleanupBadgeProtected', text: t`Protected` } : null,
            checkboxTitle: file.path,
        });
        const checkbox = row.querySelector('input[type="checkbox"]');
        file.checkbox = checkbox;
        checkbox.addEventListener('change', () => updateSummary(root));
        list.append(row);
    }

    // Pass the original file objects (which now own .checkbox) as items.
    const controls = renderGroupControls({
        root,
        sectionKey: 'images',
        items: folderData.files,
        disabled: folderData.protected,
        deleteHandler: async () => handlers.deleteImageGroup(folderData),
        selectLabel: t`Select all in group`,
        deleteLabel: t`Delete group`,
    });

    body.append(controls, list);
    details.append(body);
    return details;
}

function renderImageSection(root, imageGroups, handlers) {
    const allFiles = imageGroups.flatMap(folder => folder.files);
    const section = createSectionCard({
        key: 'images',
        title: t`Chat images`,
        note: t`Chat images are deleted permanently. There is no trash.`,
        buttons: [],
        totals: sumTotals(allFiles),
    });

    const tools = ce('div', 'cleanupToolbar');
    const selectAllButton = createSelectionButton(t`Select all in section`, 'cleanupImagesSelectAll', 'cleanupImagesSelectAll');
    setI18n(selectAllButton, t`Select all in section`);
    selectAllButton.disabled = !imageGroups.length;
    selectAllButton.addEventListener('click', () => {
        const selectable = [...section.querySelectorAll('input[data-cleanup-item]:not(:disabled)')];
        const target = selectable.some(box => !box.checked);
        for (const checkbox of selectable) {
            checkbox.checked = target;
        }
        updateSummary(root);
    });
    tools.append(selectAllButton);

    const downloadButton = createSelectionButton(t`Download selected before deleting`, 'cleanupImagesDownloadSelected', 'cleanupImagesDownloadSelected');
    setI18n(downloadButton, t`Download selected before deleting`);
    downloadButton.addEventListener('click', async () => handlers.downloadSelectedImages());
    tools.append(downloadButton);

    const deleteButton = createSelectionButton(t`Delete selected`, 'cleanupImagesDeleteSelected', 'imageDeleteAction');
    setI18n(deleteButton, t`Delete selected`);
    deleteButton.addEventListener('click', async () => handlers.deleteSelectedImages());
    tools.append(deleteButton);

    tools.append(createSectionSort(section));
    tools.append(createSectionFilter(section));
    section.append(tools);

    if (!imageGroups.length) {
        section.append(ce('div', 'cleanupEmpty', { text: t`No images folders found.` }));
        return section;
    }

    const folders = ce('div', 'cleanupFolders');
    for (const folderData of imageGroups) {
        folders.append(renderImageFolder(root, folderData, handlers));
    }
    section.append(folders);
    return section;
}

function buildDataMaidList(root, items, sectionKey, title, note, handlers, options = {}) {
    const section = createSectionCard({ key: sectionKey, title, note, totals: sumTotals(items) });
    const toolbar = ce('div', 'cleanupToolbar');
    const selectAllButton = createSelectionButton(t`Select all in section`, `${sectionKey}SelectAll`, `${sectionKey}SelectAll`);
    setI18n(selectAllButton, t`Select all in section`);
    selectAllButton.disabled = !items.length;
    selectAllButton.addEventListener('click', () => {
        const selectable = [...section.querySelectorAll('input[data-cleanup-item]:not(:disabled)')];
        const target = selectable.some(box => !box.checked);
        for (const checkbox of selectable) {
            checkbox.checked = target;
        }
        updateSummary(root);
    });
    toolbar.append(selectAllButton);

    if (handlers.downloadSelected) {
        const downloadButton = createSelectionButton(t`Download selected before deleting`, `${sectionKey}DownloadSelected`, `${sectionKey}DownloadSelected`);
        setI18n(downloadButton, t`Download selected before deleting`);
        downloadButton.addEventListener('click', async () => handlers.downloadSelected(sectionKey));
        toolbar.append(downloadButton);
    }

    const deleteButton = createSelectionButton(t`Delete selected`, `${sectionKey}DeleteSelected`, 'genericDeleteAction');
    setI18n(deleteButton, t`Delete selected`);
    deleteButton.dataset.genericDeleteAction = 'true';
    deleteButton.addEventListener('click', async () => handlers.deleteSelected(sectionKey));
    toolbar.append(deleteButton);
    toolbar.append(createSectionSort(section));
    toolbar.append(createSectionFilter(section));
    section.append(toolbar);

    if (!items.length) {
        section.append(ce('div', 'cleanupEmpty', { text: t`No items found.` }));
        return section;
    }

    const list = ce('div', 'cleanupFlatList');
    for (const item of items) {
        const row = renderCheckboxRow({
            id: item.hash,
            name: item.name,
            size: item.size || 0,
            disabled: Boolean(item.protected),
            meta: item.parent ? `${item.parent} • ${humanFileSize(item.size || 0)}` : humanFileSize(item.size || 0),
            badge: item.protected ? { className: 'cleanupBadgeProtected', text: item.protectedLabel || t`Protected` } : null,
            checkboxTitle: item.hash,
        });
        const checkbox = row.querySelector('input[type="checkbox"]');
        item.checkbox = checkbox;
        checkbox.addEventListener('change', () => updateSummary(root));
        list.append(row);
    }
    section.append(list);
    return section;
}

function renderThumbnailSection(root, report, handlers) {
    const allThumbs = [
        ...(report.avatarThumbnails || []),
        ...(report.backgroundThumbnails || []),
        ...(report.personaThumbnails || []),
    ];
    const section = createSectionCard({
        key: 'thumbnails',
        title: t`Orphan thumbnails`,
        note: t`Orphan thumbnails are safe to delete because SillyTavern regenerates them.`,
        buttons: [],
        totals: sumTotals(allThumbs),
    });

    const toolbar = ce('div', 'cleanupToolbar');
    const selectAllButton = createSelectionButton(t`Select all in section`, 'cleanupThumbnailsSelectAll', 'cleanupThumbnailsSelectAll');
    setI18n(selectAllButton, t`Select all in section`);
    selectAllButton.disabled = false;
    selectAllButton.addEventListener('click', () => {
        const selectable = [...section.querySelectorAll('input[data-cleanup-item]:not(:disabled)')];
        const target = selectable.some(box => !box.checked);
        for (const checkbox of selectable) {
            checkbox.checked = target;
        }
        updateSummary(root);
    });
    toolbar.append(selectAllButton);

    if (handlers.downloadSelected) {
        const downloadButton = createSelectionButton(t`Download selected before deleting`, 'cleanupThumbnailsDownloadSelected', 'cleanupThumbnailsDownloadSelected');
        setI18n(downloadButton, t`Download selected before deleting`);
        downloadButton.addEventListener('click', async () => handlers.downloadSelected());
        toolbar.append(downloadButton);
    }

    const deleteButton = createSelectionButton(t`Delete selected`, 'cleanupThumbnailsDeleteSelected', 'genericDeleteAction');
    setI18n(deleteButton, t`Delete selected`);
    deleteButton.dataset.genericDeleteAction = 'true';
    deleteButton.addEventListener('click', async () => handlers.deleteSelected());
    toolbar.append(deleteButton);
    toolbar.append(createSectionSort(section));
    toolbar.append(createSectionFilter(section));
    section.append(toolbar);

    const groups = [
        { key: 'avatarThumbnails', title: t`Avatar Thumbnails`, items: report.avatarThumbnails || [] },
        { key: 'backgroundThumbnails', title: t`Background Thumbnails`, items: report.backgroundThumbnails || [] },
        { key: 'personaThumbnails', title: t`Persona Thumbnails`, items: report.personaThumbnails || [] },
    ];

    for (const group of groups) {
        const sub = ce('div', 'cleanupSubSection');
        const header = ce('div', 'cleanupSectionHeader');
        header.append(
            ce('h4', '', { text: group.title }),
            ce('span', 'cleanupSectionMeta', { text: `${t`Count`}: ${group.items.length}` }),
        );
        setI18n(header.firstElementChild, group.title);
        sub.append(header);

        const list = ce('div', 'cleanupFlatList');
        const sorted = [...group.items].sort(sortByMtimeThenNameDesc);
        if (!sorted.length) {
            list.append(ce('div', 'cleanupEmpty', { text: t`No items found.` }));
        } else {
            for (const item of sorted) {
                const row = renderCheckboxRow({
                    id: item.hash,
                    name: item.name,
                    size: item.size || 0,
                    disabled: false,
                    meta: item.parent ? `${item.parent} • ${humanFileSize(item.size || 0)}` : humanFileSize(item.size || 0),
                    checkboxTitle: item.hash,
                });
                const checkbox = row.querySelector('input[type="checkbox"]');
                item.checkbox = checkbox;
                checkbox.addEventListener('change', () => updateSummary(root));
                list.append(row);
            }
        }
        sub.append(list);
        section.append(sub);
    }

    return section;
}

function buildDialogShell() {
    const root = ce('div', 'cleanupDialog');

    const header = ce('div', 'cleanupDialogHeader');
    header.append(
        ce('h2', 'cleanupDialogTitle', { text: MODULE_NAME }),
        ce('div', 'cleanupDialogLead', { text: t`Use the scan button to populate the four cleanup sections.` }),
    );
    setI18n(header.firstElementChild, MODULE_NAME);
    setI18n(header.children[1], 'Use the scan button to populate the four cleanup sections.');

    const toolbar = ce('div', 'cleanupToolbar');
    const scanButton = makePlainButton(t`Scan`, 'cleanupScanButton');
    scanButton.dataset.cleanupScan = 'true';
    scanButton.addEventListener('click', async () => {
        if (state.busy || state.scanning) {
            toastr.warning(t`A cleanup job is already running.`);
            return;
        }
        await handleScan(root);
    });
    toolbar.append(scanButton);

    const status = ce('div', 'cleanupSummaryLine');
    status.append(
        ce('span', '', { text: `${t`Selected items`}: ` }),
        ce('strong', 'cleanupSummaryCount', { text: '0' }),
        ce('span', '', { text: ` • ${t`Freed space`}: ` }),
        ce('strong', 'cleanupSummaryBytes', { text: humanFileSize(0) }),
    );
    setI18n(status.children[0], 'Selected items');
    setI18n(status.children[2], 'Freed space');

    header.append(toolbar, status);

    const progressWrap = ce('div', 'cleanupProgressWrap');
    progressWrap.append(
        ce('div', 'cleanupProgress'),
        ce('div', 'cleanupProgressText', { text: '' }),
    );
    progressWrap.firstElementChild.append(ce('div', 'cleanupProgressBar'));

    const sections = ce('div', 'cleanupSections');
    sections.append(ce('div', 'cleanupEmpty', { text: t`Scan first` }));

    root.append(header, progressWrap, sections);
    setI18n(sections.firstElementChild, 'Scan first');

    return root;
}

function gatherSelectedImagePaths(root) {
    return getSectionSelectedIds(root, 'images');
}

function gatherImageGroupPaths(folderData) {
    if (folderData.protected) {
        return [];
    }
    return folderData.files
        .filter(file => file.checkbox?.checked)
        .map(file => file.path);
}

async function confirmDestructiveAction(root, count, size, description) {
    const content = ce('div', 'cleanupDeleteConfirm');

    const heading = ce('div', 'cleanupConfirmHeading', { text: description });
    setI18n(heading, description);

    const stats = ce('div', 'cleanupConfirmStats');
    const countLabel = ce('span', '', { text: `${t`Selected for removal`}:` });
    setI18n(countLabel, 'Selected for removal');
    const sizeLabel = ce('span', '', { text: `${t`Selected size`}:` });
    setI18n(sizeLabel, 'Selected size');
    stats.append(
        countLabel,
        ce('strong', '', { text: String(count) }),
        sizeLabel,
        ce('strong', '', { text: size }),
    );

    const ackLabel = ce('label', 'cleanupConfirmAck');
    const ackCheckbox = ce('input', '', { type: 'checkbox' });
    const ackText = ce('span', '', { text: t`I understand this deletion is permanent and cannot be undone.` });
    setI18n(ackText, 'I understand this deletion is permanent and cannot be undone.');
    ackLabel.append(ackCheckbox, ackText);

    content.append(heading, stats, ackLabel);

    const popup = new Popup(content, POPUP_TYPE.CONFIRM, '', {
        okButton: t`Delete`,
        cancelButton: t`Cancel`,
    });

    // ST popup buttons are <div> elements, so `disabled` alone won't block
    // clicks. We visually disable the OK button and guard the result with the
    // checkbox state, also intercepting clicks while it is not acknowledged.
    const okButton = popup.okButton;
    if (okButton) {
        const syncOkState = () => {
            okButton.classList.toggle('cleanupOkDisabled', !ackCheckbox.checked);
        };
        syncOkState();
        ackCheckbox.addEventListener('change', syncOkState);
        okButton.addEventListener('click', event => {
            if (!ackCheckbox.checked) {
                event.preventDefault();
                event.stopImmediatePropagation();
                ackCheckbox.focus();
            }
        }, true);
    }

    const result = await popup.show();
    return result === POPUP_RESULT.AFFIRMATIVE && ackCheckbox.checked;
}

function triggerBlobDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Delay revocation so the browser has time to start the download.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

// Keep archive paths safe: strip characters that are invalid in file names.
function sanitizeArchivePart(part) {
    const clean = String(part).replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_').trim();
    return clean || '_';
}

async function fetchImageData(file) {
    const response = await apiRequestJson(file.url, { method: 'GET', omitContentType: true });
    if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
    }
    return new Uint8Array(await response.arrayBuffer());
}

async function fetchDataMaidData(hash) {
    const query = `token=${encodeURIComponent(state.token || '')}&hash=${encodeURIComponent(hash)}`;
    const response = await apiRequestJson(`/api/data-maid/view?${query}`, { method: 'GET', omitContentType: true });
    if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
    }
    return new Uint8Array(await response.arrayBuffer());
}

// Smart download dispatcher. Up to ZIP_DOWNLOAD_THRESHOLD files are saved
// individually; larger selections are fetched in parallel and packed into a
// single zip archive whose inner folders mirror the cleanup categories
// (images/<character folder>/, chat-backups/, settings-backups/, thumbnails/...).
async function downloadTargets(root, targets) {
    if (!targets.length) {
        toastr.warning(t`Scan first`);
        return;
    }

    setBusy(root, true, t`Downloading...`);
    try {
        let failedCount = 0;

        if (targets.length > ZIP_DOWNLOAD_THRESHOLD) {
            const entries = [];
            let done = 0;
            let fetchedBytes = 0;
            updateProgress(root, `${t`Downloading...`} 0/${targets.length}`, 0, targets.length);
            await mapLimit(targets, DOWNLOAD_CONCURRENCY, async target => {
                try {
                    const data = await target.fetchData();
                    fetchedBytes += data.length;
                    entries.push({ path: target.archivePath, data });
                } catch (error) {
                    failedCount += 1;
                    console.error(`Download failed for ${target.archivePath}:`, error);
                }
                done += 1;
                updateProgress(root, `${t`Downloading...`} ${done}/${targets.length} • ${humanFileSize(fetchedBytes)}`, done, targets.length);
            });

            if (!entries.length) {
                toastr.error(t`Download failed`);
                return;
            }

            // Packing restarts the bar as a second phase with its own counter;
            // buildZipBlob yields to the event loop while hashing, so the UI
            // and the striped busy animation stay live even on huge archives.
            updateProgress(root, `${t`Packing zip archive...`} 0/${entries.length}`, 0, entries.length);
            const blob = await buildZipBlob(entries, (packed, total) => {
                updateProgress(root, `${t`Packing zip archive...`} ${packed}/${total}`, packed, total);
            });
            const stamp = new Date().toISOString().slice(0, 10);
            triggerBlobDownload(blob, `st-cleanup-${stamp}.zip`);
        } else {
            let done = 0;
            updateProgress(root, t`Downloading...`, 0, targets.length);
            for (const target of targets) {
                try {
                    const data = await target.fetchData();
                    triggerBlobDownload(new Blob([data]), target.filename);
                    // Small gap between saves so browsers don't drop downloads.
                    await new Promise(resolve => setTimeout(resolve, 150));
                } catch (error) {
                    failedCount += 1;
                    console.error(`Download failed for ${target.archivePath}:`, error);
                }
                done += 1;
                updateProgress(root, t`Downloading...`, done, targets.length);
            }
        }

        if (failedCount === 0) {
            toastr.success(t`Download complete`);
        } else if (failedCount === targets.length) {
            toastr.error(t`Download failed`);
        } else {
            toastr.warning(t`Some files failed to download.`);
        }
    } finally {
        setBusy(root, false, '');
        updateProgress(root, '', 0, 0);
    }
}

// Archive folder names per Data Maid category, mirroring the dialog sections.
const DATA_MAID_ARCHIVE_FOLDERS = {
    chatBackups: 'chat-backups',
    settingsBackups: 'settings-backups',
    avatarThumbnails: 'thumbnails/avatars',
    backgroundThumbnails: 'thumbnails/backgrounds',
    personaThumbnails: 'thumbnails/personas',
};

function buildDataMaidTargets(hashes, categoryKeys) {
    const report = state.report || {};
    const wanted = new Set(hashes);
    const targets = [];
    for (const key of categoryKeys) {
        const folder = DATA_MAID_ARCHIVE_FOLDERS[key] || key;
        for (const item of (Array.isArray(report[key]) ? report[key] : [])) {
            if (!wanted.has(item.hash)) {
                continue;
            }
            targets.push({
                archivePath: `${folder}/${sanitizeArchivePart(item.name)}`,
                filename: item.name,
                fetchData: () => fetchDataMaidData(item.hash),
            });
        }
    }
    return targets;
}

// Report the result of a bulk deletion, distinguishing full success, partial
// success, and total failure so partial failures are never silently swallowed.
function reportDeletionOutcome(deletedCount, failedCount) {
    if (failedCount === 0) {
        toastr.success(t`Delete complete`);
    } else if (deletedCount === 0) {
        toastr.error(t`Deletion failed. No items were removed.`);
    } else {
        toastr.warning(t`Deleted ${deletedCount} item(s), ${failedCount} failed.`);
    }
}

async function deleteImagePaths(root, paths) {
    if (!paths.length) {
        toastr.info(t`No cleanup job is running.`);
        return;
    }

    // Build the size lookup once from the in-memory scan state. Summing sizes
    // via per-path DOM queries was O(n²) over the whole dialog and froze the
    // UI for seconds before the confirmation popup with large selections.
    const sizeByPath = new Map((state.images || [])
        .flatMap(folder => folder.files)
        .map(file => [file.path, Number(file.size || 0)]));
    const totalBytes = paths.reduce((sum, pathId) => sum + (sizeByPath.get(pathId) || 0), 0);

    const ok = await confirmDestructiveAction(root, paths.length, humanFileSize(totalBytes), t`Delete selected chat images?`);
    if (!ok) {
        return;
    }

    // Validate the selection against the already-loaded state instead of running
    // a full rescan. The delete endpoint itself is authoritative: a 404 means the
    // file is already gone and is treated as success, so stale entries are safe.
    // Protected folders (e.g. *_refs, "generated") are excluded here as a last
    // line of defense, even if their checkboxes were somehow selected.
    const knownPaths = new Set((state.images || [])
        .filter(folder => !folder.protected)
        .flatMap(folder => folder.files.filter(file => !file.protected).map(file => file.path)));
    const filtered = knownPaths.size ? paths.filter(pathId => knownPaths.has(pathId)) : [];
    if (!filtered.length) {
        toastr.info(t`Scan first`);
        return;
    }

    let shouldRefresh = false;
    setBusy(root, true, t`Delete in progress`);
    try {
        state.progressTotal = filtered.length;
        state.progressDone = 0;
        updateProgress(root, formatDeleteProgress(0, filtered.length, 0), 0, filtered.length);

        let deletedCount = 0;
        let failedCount = 0;
        let freedBytes = 0;

        await mapLimit(filtered, DELETE_CONCURRENCY, async pathId => {
            const response = await apiRequestJson('/api/images/delete', {
                method: 'POST',
                body: JSON.stringify({ path: pathId }),
            });
            // 404 means the file is already gone — treat as success.
            if (response.ok || response.status === 404) {
                deletedCount += 1;
                freedBytes += sizeByPath.get(pathId) || 0;
                invalidateImageSize(pathId);
            } else {
                failedCount += 1;
                const text = await response.text().catch(() => '');
                console.error(`Delete failed for ${pathId}: ${response.status} ${response.statusText}${text ? ` — ${text}` : ''}`);
            }
            state.progressDone += 1;
            updateProgress(root, formatDeleteProgress(state.progressDone, state.progressTotal, freedBytes), state.progressDone, state.progressTotal);
        });

        reportDeletionOutcome(deletedCount, failedCount);
        shouldRefresh = deletedCount > 0;
    } finally {
        setBusy(root, false, '');
    }

    if (shouldRefresh) {
        await handleScan(root, { silent: true });
    }
}

async function deleteDataMaidHashes(root, categoryKeys, hashes, confirmText = t`Delete selected files?`) {
    if (!hashes.length) {
        toastr.info(t`No cleanup job is running.`);
        return;
    }

    // The pre-delete token refresh runs a full server-side scan, which can take
    // a while with large data folders. Show the busy progress bar during it so
    // the pause before the confirmation popup doesn't look like a freeze.
    let fresh;
    setBusy(root, true, t`Preparing deletion...`);
    try {
        fresh = await scanCleanupReport();
    } finally {
        setBusy(root, false, '');
        updateProgress(root, '', 0, 0);
    }
    state.token = fresh.token;
    const report = fresh.report;
    const keyList = Array.isArray(categoryKeys) ? categoryKeys : [categoryKeys];
    const pool = keyList.flatMap(key => Array.isArray(report[key]) ? report[key] : []);
    const map = new Map(pool.map(item => [item.hash, item]));
    const selected = hashes.map(hash => map.get(hash)).filter(Boolean);
    if (!selected.length) {
        toastr.info(t`Scan first`);
        return;
    }

    const totalBytes = selected.reduce((sum, item) => sum + Number(item.size || 0), 0);
    const ok = await confirmDestructiveAction(root, selected.length, humanFileSize(totalBytes), confirmText);
    if (!ok) {
        return;
    }

    setBusy(root, true, t`Delete in progress`);
    let shouldRefresh = false;
    try {
        state.progressTotal = selected.length;
        state.progressDone = 0;
        updateProgress(root, formatDeleteProgress(0, selected.length, 0), 0, selected.length);

        const chunks = [];
        for (let index = 0; index < selected.length; index += DATA_MAID_DELETE_CHUNK) {
            chunks.push(selected.slice(index, index + DATA_MAID_DELETE_CHUNK));
        }

        let deletedCount = 0;
        let failedCount = 0;
        let freedBytes = 0;
        let tokenRefreshed = false;

        for (const chunk of chunks) {
            // Refresh the label before the request goes out: a chunk of large
            // backups can take a long time server-side, and the striped
            // busy animation plus the up-to-date counter show the job is alive.
            updateProgress(root, formatDeleteProgress(state.progressDone, state.progressTotal, freedBytes), state.progressDone, state.progressTotal);

            let response = await apiRequestJson('/api/data-maid/delete', {
                method: 'POST',
                body: JSON.stringify({ token: state.token, hashes: chunk.map(item => item.hash) }),
            });

            // A stale/expired token usually surfaces as a 4xx. Refresh the report
            // once to obtain a fresh token, then retry this chunk a single time.
            if (!response.ok && isLikelyTokenError(response.status) && !tokenRefreshed) {
                tokenRefreshed = true;
                try {
                    const refreshed = await scanCleanupReport();
                    state.token = refreshed.token;
                    response = await apiRequestJson('/api/data-maid/delete', {
                        method: 'POST',
                        body: JSON.stringify({ token: state.token, hashes: chunk.map(item => item.hash) }),
                    });
                } catch (error) {
                    console.error('Cleanup: token refresh failed:', error);
                }
            }

            if (response.ok) {
                deletedCount += chunk.length;
                freedBytes += chunk.reduce((sum, item) => sum + Number(item.size || 0), 0);
            } else {
                failedCount += chunk.length;
                const text = await response.text().catch(() => '');
                console.error(`Data Maid delete failed: ${response.status} ${response.statusText}${text ? ` — ${text}` : ''}`);
            }

            state.progressDone += chunk.length;
            updateProgress(root, formatDeleteProgress(state.progressDone, state.progressTotal, freedBytes), state.progressDone, state.progressTotal);
        }

        reportDeletionOutcome(deletedCount, failedCount);
        shouldRefresh = deletedCount > 0;
    } finally {
        setBusy(root, false, '');
    }

    if (shouldRefresh) {
        await handleScan(root, { silent: true });
    }
}

async function deleteImagesSelected(root) {
    const paths = gatherSelectedImagePaths(root);
    await deleteImagePaths(root, paths);
}

async function downloadSelectedImages(root) {
    const paths = getSectionSelectedIds(root, 'images');
    if (!paths.length) {
        toastr.warning(t`Scan first`);
        return;
    }
    // Resolve download targets from the already-loaded state; no rescan needed.
    const map = new Map((state.images || []).flatMap(folder => folder.files).map(file => [file.path, file]));
    const targets = paths
        .map(pathId => map.get(pathId))
        .filter(Boolean)
        .map(file => ({
            archivePath: `images/${sanitizeArchivePart(file.folder)}/${sanitizeArchivePart(file.filename)}`,
            filename: file.filename,
            fetchData: () => fetchImageData(file),
        }));
    if (!targets.length) {
        toastr.warning(t`Scan first`);
        return;
    }
    await downloadTargets(root, targets);
}

async function downloadSelectedFromReport(root, sectionKey) {
    const selected = getSectionSelectedIds(root, sectionKey);
    if (!selected.length) {
        toastr.warning(t`Scan first`);
        return;
    }
    await downloadTargets(root, buildDataMaidTargets(selected, [sectionKey]));
}

async function downloadSelectedThumbnails(root) {
    const selected = getSectionSelectedIds(root, 'thumbnails');
    if (!selected.length) {
        toastr.warning(t`Scan first`);
        return;
    }
    await downloadTargets(root, buildDataMaidTargets(selected, ['avatarThumbnails', 'backgroundThumbnails', 'personaThumbnails']));
}

async function deleteImageGroup(root, folderData) {
    const paths = gatherImageGroupPaths(folderData);
    if (!paths.length) {
        toastr.info(t`No images selected in this group.`);
        return;
    }
    await deleteImagePaths(root, paths);
}

async function deleteSelectedFromReport(root, sectionKey) {
    const selected = getSectionSelectedIds(root, sectionKey);
    if (!selected.length) {
        toastr.warning(t`Scan first`);
        return;
    }
    await deleteDataMaidHashes(root, sectionKey, selected);
}

async function deleteSelectedThumbnails(root) {
    const selected = getSectionSelectedIds(root, 'thumbnails');
    if (!selected.length) {
        toastr.warning(t`Scan first`);
        return;
    }
    await deleteDataMaidHashes(root, ['avatarThumbnails', 'backgroundThumbnails', 'personaThumbnails'], selected, t`Delete selected files?`);
}

async function renderAll(root) {
    if (!root) {
        return;
    }
    const sections = root.querySelector('.cleanupSections');
    sections.replaceChildren();

    const images = state.images || [];
    const report = state.report || {};

    sections.append(
        renderImageSection(root, images, {
            deleteSelectedImages: () => deleteImagesSelected(root),
            downloadSelectedImages: () => downloadSelectedImages(root),
            deleteImageGroup: folderData => deleteImageGroup(root, folderData),
        }),
    );

    if (state.dataMaidAvailable) {
        sections.append(
            buildDataMaidList(root, [...(report.chatBackups || [])].sort(sortByMtimeThenNameDesc), 'chatBackups', t`Chat backups`, '', {
                deleteSelected: sectionKey => deleteSelectedFromReport(root, sectionKey),
                downloadSelected: sectionKey => downloadSelectedFromReport(root, sectionKey),
            }),
            buildDataMaidList(root, [...(report.settingsBackups || [])].sort(sortByMtimeThenNameDesc).map((item, index) => ({
                ...item,
                protected: index === 0,
                protectedLabel: index === 0 ? t`Newest backup kept` : null,
            })), 'settingsBackups', t`Settings backups`, t`Settings backups keep the newest file. The newest item is protected.`, {
                deleteSelected: sectionKey => deleteSelectedFromReport(root, sectionKey),
                downloadSelected: sectionKey => downloadSelectedFromReport(root, sectionKey),
            }),
            renderThumbnailSection(root, report, {
                deleteSelected: () => deleteSelectedThumbnails(root),
                downloadSelected: () => downloadSelectedThumbnails(root),
            }),
        );
    } else {
        sections.append(renderDataMaidUnavailableNotice());
    }

    // Change listeners are attached per-row inside the section renderers
    // (renderImageFolder / buildDataMaidList / renderThumbnailSection), so we
    // only need to refresh the summary once after the initial render.
    updateSummary(root);
}

async function handleScan(root, { silent = false } = {}) {
    if (state.scanning || state.busy) {
        if (!silent) {
            toastr.warning(t`A cleanup job is already running.`);
        }
        return;
    }

    state.scanning = true;
    setBusy(root, true, t`Scanning...`);

    // Images and the Data Maid report are scanned independently so that a
    // missing or broken Data Maid endpoint never prevents the image section
    // from working (graceful degradation).
    const [imagesResult, reportResult] = await Promise.allSettled([
        scanChatImages(root, root),
        scanCleanupReport(),
    ]);

    let imagesFailed = false;
    if (imagesResult.status === 'fulfilled') {
        state.images = imagesResult.value;
    } else {
        imagesFailed = true;
        state.images = [];
        console.error('Cleanup image scan failed:', imagesResult.reason);
    }

    let dataMaidMissing = false;
    if (reportResult.status === 'fulfilled') {
        state.report = reportResult.value.report;
        state.token = reportResult.value.token;
        state.dataMaidAvailable = true;
    } else if (reportResult.reason instanceof DataMaidUnavailableError) {
        dataMaidMissing = true;
        state.report = null;
        state.token = null;
        state.dataMaidAvailable = false;
        console.info('Cleanup: Data Maid is not available, showing chat images only.');
    } else {
        state.report = null;
        state.token = null;
        state.dataMaidAvailable = true; // real error, keep sections but warn
        console.error('Cleanup report scan failed:', reportResult.reason);
    }

    try {
        await renderAll(root);
        updateProgress(root, '', 0, 0);

        if (imagesFailed && (dataMaidMissing || reportResult.status === 'rejected')) {
            toastr.error(t`Scan failed`);
        } else if (imagesFailed) {
            toastr.error(t`Chat image scan failed.`);
        } else if (dataMaidMissing) {
            if (!silent) {
                toastr.info(t`Data Maid is not available. Showing chat images only.`);
            }
        } else if (reportResult.status === 'rejected') {
            toastr.warning(t`Backups and thumbnails could not be loaded.`);
        } else if (!silent) {
            toastr.success(t`Scan complete`);
        }
    } finally {
        state.scanning = false;
        setBusy(root, false, '');
    }
}

async function openCleanupDialog() {
    if (state.popupOpen) {
        return;
    }

    const root = buildDialogShell();
    state.root = root;
    state.popupOpen = true;

    await callGenericPopup(root, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        allowHorizontalScrolling: false,
        okButton: t`Close`,
        cancelButton: false,
        onClose: async () => {
            await finalizeToken(state.token);
            state.popupOpen = false;
            state.token = null;
            state.report = null;
            state.images = null;
            state.dataMaidAvailable = true;
            state.root = null;
            clearImageSizeCache();
        },
        onClosing: () => !state.busy,
    });
}

/** Build the launcher item for the wand (extensions) menu next to the message input. */
function buildWandMenuItem() {
    const item = ce('div', 'list-group-item flex-container flexGap5 interactable', {
        id: 'cleaning-open-btn',
        tabindex: '0',
        title: t`Open Cleanup`,
    });
    setI18n(item, 'Open Cleanup', true);
    const icon = ce('div', 'fa-solid fa-broom extensionsMenuExtensionButton');
    const label = ce('span', '', { text: t`Open Cleanup` });
    setI18n(label, 'Open Cleanup');
    item.append(icon, label);
    return item;
}

jQuery(async () => {
    const menu = document.getElementById('extensionsMenu');
    if (menu) {
        menu.append(buildWandMenuItem());
    } else {
        console.error('Cleanup: #extensionsMenu not found, launcher not added.');
    }

    $(document).on('click', '#cleaning-open-btn', function () {
        openCleanupDialog().catch(error => console.error('Cleanup dialog failed:', error));
    });
});

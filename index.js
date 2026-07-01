'use strict';

import { getContext } from '../../../extensions.js';
import { callGenericPopup, Popup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';
import { humanFileSize } from '../../../utils.js';
import { t } from '../../../i18n.js';

const _st = await import('../../../script.js').catch(() => ({}));
const getRequestHeaders = _st.getRequestHeaders ?? window.getRequestHeaders ?? (() => ({}));

const MODULE_NAME = 'Cleaning';
const IMAGE_SIZE_CONCURRENCY = 12;
const IMAGE_SCAN_CONCURRENCY = 4;
const DELETE_CONCURRENCY = 8;
const DATA_MAID_DELETE_CHUNK = 50;

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

function ce(tag, className = '', attrs = {}, children = []) {
    const el = document.createElement(tag);
    if (className) {
        el.className = className;
    }
    for (const [key, value] of Object.entries(attrs)) {
        if (key === 'dataset') {
            Object.assign(el.dataset, value);
            continue;
        }
        if (key === 'text') {
            el.textContent = value;
            continue;
        }
        if (key === 'html') {
            el.innerHTML = value;
            continue;
        }
        if (value === false || value === null || value === undefined) {
            continue;
        }
        if (key === 'classList' && Array.isArray(value)) {
            el.classList.add(...value);
            continue;
        }
        el.setAttribute(key, String(value));
    }
    for (const child of Array.isArray(children) ? children : [children]) {
        if (child === null || child === undefined) {
            continue;
        }
        el.append(child);
    }
    return el;
}

function setI18n(node, key, title = false) {
    if (!node) {
        return node;
    }
    node.dataset.i18n = title ? `[title]${key}` : key;
    return node;
}

function makeButton(label, icon, className, title = label) {
    const button = ce('button', `menu_button ${className || ''}`.trim());
    setI18n(button, title, true);
    const iconEl = ce('i', icon);
    const text = ce('span', '', { text: label });
    setI18n(text, label);
    button.append(iconEl, text);
    return button;
}

function makePlainButton(label, className, title = label, icon = null) {
    const button = ce('button', `menu_button ${className || ''}`.trim(), { type: 'button' });
    setI18n(button, title, true);
    if (icon) {
        button.append(ce('i', icon), ce('span', '', { text: label }));
        setI18n(button.lastElementChild, label);
    } else {
        button.textContent = label;
        setI18n(button, label);
    }
    return button;
}

function mapLimit(items, limit, worker) {
    const results = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
        while (cursor < items.length) {
            const index = cursor++;
            results[index] = await worker(items[index], index);
        }
    });
    return Promise.all(workers).then(() => results);
}

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

function getSelectedInputs(root, selector = 'input[data-cleanup-item]:checked:not(:disabled)') {
    return [...root.querySelectorAll(selector)];
}

function selectedBytes(root) {
    return getSelectedInputs(root).reduce((sum, input) => sum + Number(input.dataset.bytes || 0), 0);
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

async function apiRequestJson(url, options = {}) {
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

async function postJson(url, body, options = {}) {
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

async function resolveStaticSize(url) {
    try {
        const head = await apiRequestJson(url, { method: 'HEAD', omitContentType: true });
        if (head.ok) {
            const length = Number(head.headers.get('content-length'));
            if (Number.isFinite(length) && length >= 0) {
                return length;
            }
        }
    } catch {
        // ignore and fall back
    }

    try {
        const ranged = await apiRequestJson(url, {
            method: 'GET',
            omitContentType: true,
            headers: {
                Range: 'bytes=0-0',
            },
        });
        const contentRange = ranged.headers.get('content-range');
        if (contentRange) {
            const match = /\/(\d+)\s*$/.exec(contentRange);
            if (match) {
                return Number(match[1]);
            }
        }
        const length = Number(ranged.headers.get('content-length'));
        if (Number.isFinite(length) && length >= 0 && ranged.status === 206) {
            return length > 1 ? length : 0;
        }
        const buffer = await ranged.arrayBuffer();
        return buffer.byteLength;
    } catch {
        return 0;
    }
}

function buildImageUrl(folder, filename) {
    return `/user/images/${encodeURIComponent(folder)}/${encodeURIComponent(filename)}`;
}

function imagePath(folder, filename) {
    return `user/images/${folder}/${filename}`;
}

function sortByMtimeThenNameDesc(a, b) {
    return (Number(b.mtime || 0) - Number(a.mtime || 0)) || String(b.name || '').localeCompare(String(a.name || ''));
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
            const size = await resolveStaticSize(url);
            return {
                folder,
                filename,
                path: imagePath(folder, filename),
                url,
                size,
                protected: /_refs$/i.test(folder),
            };
        });
        const totalSize = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
        folderData.push({
            folder,
            protected: /_refs$/i.test(folder),
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

class DataMaidUnavailableError extends Error {
    constructor(message) {
        super(message);
        this.name = 'DataMaidUnavailableError';
    }
}

// HTTP statuses that mean "this SillyTavern build has no Data Maid endpoint"
// rather than a transient failure worth surfacing as an error.
const DATA_MAID_MISSING_STATUSES = new Set([404, 501]);

async function scanCleanupReport(root) {
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

    return response.json();
}

async function finalizeToken(token) {
    if (!token) {
        return;
    }
    try {
        await postJson('/api/data-maid/finalize', { token });
    } catch (error) {
        console.debug('Cleanup finalize ignored:', error);
    }
}

function createSectionCard({ key, title, note, buttons = [] }) {
    const section = ce('section', 'cleanupSection', { 'data-section': key });
    const header = ce('div', 'cleanupSectionHeader');
    const titleWrap = ce('div', 'cleanupSectionTitleWrap');
    titleWrap.append(
        ce('h3', '', { text: title }),
    );
    setI18n(titleWrap.firstElementChild, title);
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

function renderDataMaidUnavailableNotice() {
    const section = createSectionCard({
        key: 'dataMaidUnavailable',
        title: t`Backups & thumbnails`,
        note: '',
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

function renderFlatList(section, items, emptyLabel = t`No items found.`) {
    const list = ce('div', 'cleanupFlatList');
    if (!items.length) {
        list.append(ce('div', 'cleanupEmpty', { text: emptyLabel }));
        setI18n(list.lastElementChild, emptyLabel);
        section.append(list);
        return list;
    }
    const itemList = ce('div', 'cleanupItemList');
    for (const item of items) {
        itemList.append(renderCheckboxRow(item));
    }
    list.append(itemList);
    section.append(list);
    return list;
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
    details.open = true;
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
    const items = folderData.files.map(file => ({
        ...file,
        checkbox: null,
    }));
    const controls = renderGroupControls({
        root,
        sectionKey: 'images',
        items,
        disabled: folderData.protected,
        deleteHandler: async () => handlers.deleteImageGroup(folderData),
        selectLabel: t`Select all in group`,
        deleteLabel: t`Delete group`,
    });
    body.append(controls);

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
    body.append(list);
    details.append(body);
    return details;
}

function renderImageSection(root, imageGroups, handlers) {
    const section = createSectionCard({
        key: 'images',
        title: t`Chat images`,
        note: t`Chat images are deleted permanently. There is no trash.`,
        buttons: [],
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

    const deleteButton = createSelectionButton(t`Delete selected`, 'cleanupImagesDeleteSelected', 'data-image-delete-action');
    setI18n(deleteButton, t`Delete selected`);
    deleteButton.dataset.imageDeleteAction = 'true';
    deleteButton.addEventListener('click', async () => handlers.deleteSelectedImages());
    tools.append(deleteButton);

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
    const section = createSectionCard({ key: sectionKey, title, note });
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

    const deleteButton = createSelectionButton(t`Delete selected`, `${sectionKey}DeleteSelected`, 'genericDeleteAction');
    setI18n(deleteButton, t`Delete selected`);
    deleteButton.dataset.genericDeleteAction = 'true';
    deleteButton.addEventListener('click', async () => handlers.deleteSelected(sectionKey));
    toolbar.append(deleteButton);
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
    const section = createSectionCard({
        key: 'thumbnails',
        title: t`Orphan thumbnails`,
        note: t`Orphan thumbnails are safe to delete because SillyTavern regenerates them.`,
        buttons: [],
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

    const deleteButton = createSelectionButton(t`Delete selected`, 'cleanupThumbnailsDeleteSelected', 'genericDeleteAction');
    setI18n(deleteButton, t`Delete selected`);
    deleteButton.dataset.genericDeleteAction = 'true';
    deleteButton.addEventListener('click', async () => handlers.deleteSelected());
    toolbar.append(deleteButton);
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
    return folderData.files.filter(file => !folderData.protected).map(file => file.path);
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

async function downloadImageFiles(files) {
    for (const file of files) {
        const a = document.createElement('a');
        a.href = file.url;
        a.download = file.filename;
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
        await new Promise(resolve => setTimeout(resolve, 40));
    }
}

// HTTP statuses that commonly indicate an invalid/expired Data Maid token.
function isLikelyTokenError(status) {
    return status === 400 || status === 401 || status === 403 || status === 409 || status === 419;
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

    const totalBytes = paths.reduce((sum, pathId) => {
        const input = root.querySelector(`input[data-cleanup-id="${CSS.escape(pathId)}"]`);
        return sum + Number(input?.dataset.bytes || 0);
    }, 0);

    const ok = await confirmDestructiveAction(root, paths.length, humanFileSize(totalBytes), t`Delete selected chat images?`);
    if (!ok) {
        return;
    }

    let shouldRefresh = false;
    setBusy(root, true, t`Delete in progress`);
    try {
        const fresh = await scanChatImages(root, root);
        const freshPaths = new Set(fresh.flatMap(folder => folder.files.map(file => file.path)));
        const filtered = paths.filter(pathId => freshPaths.has(pathId));
        if (!filtered.length) {
            toastr.info(t`Scan first`);
            return;
        }
        state.progressTotal = filtered.length;
        state.progressDone = 0;
        updateProgress(root, t`Delete in progress`, 0, filtered.length);

        let deletedCount = 0;
        let failedCount = 0;

        await mapLimit(filtered, DELETE_CONCURRENCY, async pathId => {
            const response = await apiRequestJson('/api/images/delete', {
                method: 'POST',
                body: JSON.stringify({ path: pathId }),
            });
            // 404 means the file is already gone — treat as success.
            if (response.ok || response.status === 404) {
                deletedCount += 1;
            } else {
                failedCount += 1;
                const text = await response.text().catch(() => '');
                console.error(`Delete failed for ${pathId}: ${response.status} ${response.statusText}${text ? ` — ${text}` : ''}`);
            }
            state.progressDone += 1;
            updateProgress(root, t`Delete in progress`, state.progressDone, state.progressTotal);
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

    const fresh = await scanCleanupReport(root);
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
        updateProgress(root, t`Delete in progress`, 0, selected.length);

        const chunks = [];
        for (let index = 0; index < selected.length; index += DATA_MAID_DELETE_CHUNK) {
            chunks.push(selected.slice(index, index + DATA_MAID_DELETE_CHUNK));
        }

        let deletedCount = 0;
        let failedCount = 0;
        let tokenRefreshed = false;

        for (const chunk of chunks) {
            let response = await apiRequestJson('/api/data-maid/delete', {
                method: 'POST',
                body: JSON.stringify({ token: state.token, hashes: chunk.map(item => item.hash) }),
            });

            // A stale/expired token usually surfaces as a 4xx. Refresh the report
            // once to obtain a fresh token, then retry this chunk a single time.
            if (!response.ok && isLikelyTokenError(response.status) && !tokenRefreshed) {
                tokenRefreshed = true;
                try {
                    const refreshed = await scanCleanupReport(root);
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
            } else {
                failedCount += chunk.length;
                const text = await response.text().catch(() => '');
                console.error(`Data Maid delete failed: ${response.status} ${response.statusText}${text ? ` — ${text}` : ''}`);
            }

            state.progressDone += chunk.length;
            updateProgress(root, t`Delete in progress`, state.progressDone, state.progressTotal);
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
    const fresh = await scanChatImages(root, root);
    const map = new Map(fresh.flatMap(folder => folder.files).map(file => [file.path, file]));
    const files = paths.map(pathId => map.get(pathId)).filter(Boolean);
    if (!files.length) {
        toastr.warning(t`Scan first`);
        return;
    }
    await downloadImageFiles(files);
}

async function deleteImageGroup(root, folderData) {
    const paths = gatherImageGroupPaths(folderData);
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
            }),
            buildDataMaidList(root, [...(report.settingsBackups || [])].sort(sortByMtimeThenNameDesc).map((item, index) => ({
                ...item,
                protected: index === 0,
                protectedLabel: index === 0 ? t`Newest backup kept` : null,
            })), 'settingsBackups', t`Settings backups`, t`Settings backups keep the newest file. The newest item is protected.`, {
                deleteSelected: sectionKey => deleteSelectedFromReport(root, sectionKey),
            }),
            renderThumbnailSection(root, report, {
                deleteSelected: () => deleteSelectedThumbnails(root),
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
        scanCleanupReport(root),
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
        },
        onClosing: () => !state.busy,
    });
}

function settingsHTML() {
    return `
<div class="cleaning-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b><i class="fa-solid fa-broom"></i> ${MODULE_NAME}</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <div class="flex-container flexFlowColumn">
        <span data-i18n="Chat images are deleted permanently. There is no trash.">${t`Chat images are deleted permanently. There is no trash.`}</span>
      </div>
      <div style="margin-top:0.5em">
        <button id="cleaning-open-btn" class="menu_button menu_button_icon" title="${t`Open Cleanup`}">
          <i class="fa-solid fa-broom"></i>
          <span data-i18n="Open Cleanup">${t`Open Cleanup`}</span>
        </button>
      </div>
    </div>
  </div>
</div>`;
}

jQuery(async () => {
    const $target = $('#extensions_settings2').length
        ? $('#extensions_settings2')
        : $('#extensions_settings');
    $target.append(settingsHTML());

    $(document).on('click', '#cleaning-open-btn', function () {
        openCleanupDialog().catch(error => console.error('Cleanup dialog failed:', error));
    });
});

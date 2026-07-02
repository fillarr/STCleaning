'use strict';

/**
 * Create an element with a className, attributes, and children.
 * Special attribute keys: `dataset`, `text`, `html`, `classList`.
 */
export function ce(tag, className = '', attrs = {}, children = []) {
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

/** Tag a node with a `data-i18n` key (optionally targeting the title attribute). */
export function setI18n(node, key, title = false) {
    if (!node) {
        return node;
    }
    node.dataset.i18n = title ? `[title]${key}` : key;
    return node;
}

/** Build a plain `menu_button`, optionally with a leading icon. */
export function makePlainButton(label, className, title = label, icon = null) {
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

/** Run `worker` over `items` with a bounded concurrency `limit`, preserving order. */
export function mapLimit(items, limit, worker) {
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

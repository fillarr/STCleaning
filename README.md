# 🧹 Cleaning

> A lightweight, third-party [SillyTavern](https://github.com/SillyTavern/SillyTavern) extension for granular, safe disk cleanup — no server plugin required.

Cleaning gives you a single popup where you can scan, review, and permanently remove the files that quietly pile up in a SillyTavern install: chat images, backups, and orphaned thumbnails. Everything runs client-side against SillyTavern's own APIs, so there's nothing extra to install on the server and no `config.yaml` changes to make.

## ✨ Features

- **Four cleanup sections** in one place — chat images, chat backups, settings backups, and orphan thumbnails.
- **Per-item sizes** so you can see exactly how much space each file (and each folder) is using before deleting.
- **Live selection summary** — the number of selected items and the total space to be freed update as you check boxes.
- **Bulk selection** — select all in a section, or all within a single image folder.
- **Download before deleting** — for chat images, grab a local copy first if you want to keep it.
- **Bilingual UI** — English and Russian (`en` / `ru`).

## 📦 Install

1. In SillyTavern, open **Extensions → Install Extension**.
2. Paste the Git URL (https://github.com/fillarr/ST-cleaning) of this repository.
3. Done — no server plugin, no `config.yaml` edits.

Then open **Extensions → Cleaning → Open Cleanup** and hit **Scan**.

## 🗂️ What it scans

| Section | Source | Notes |
| --- | --- | --- |
| **Chat images** | `/api/images/folders` + `/api/images/list` | Per-file sizes are resolved client-side. Folders matching `/_refs$/i` are protected. |
| **Chat backups** | Data Maid | — |
| **Settings backups** | Data Maid | The newest backup is always protected and never selectable. |
| **Orphan thumbnails** | Data Maid | Avatar, background, and persona thumbnails. Safe to delete — SillyTavern regenerates them. |

## 🛡️ Safety model

There is **no trash** — deletions are permanent by design. That's the trade-off for running with zero extra backend code.

To make permanent deletion safe in practice, Cleaning applies several guardrails:

- Referenced chat images are handled separately from Data Maid's loose-image report.
- Folders matching `/_refs$/i` are protected and cannot be selected.
- The newest settings backup is never selectable.
- Every destructive action requires an **explicit confirmation** — you must tick an "I understand this is permanent" checkbox before the delete button becomes active.
- Delete requests are **revalidated against a fresh listing/report** right before execution, so stale selections can't remove the wrong files.

For images, the **Download selected before deleting** action lets you keep a copy first.

## ❓ Why no trash?

SillyTavern's built-in APIs already expose safe delete endpoints, but a true trash/restore flow would need a server-side move/rename strategy plus persistent metadata. That requires a backend component, which is intentionally out of scope here — Cleaning stays a pure, drop-in client extension.

## 📄 License

[MIT](LICENSE)

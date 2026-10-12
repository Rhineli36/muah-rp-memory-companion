# Muah RP Memory Companion — English Edition v0.22.1

This Manifest V3 Chrome extension provides conservative, slot-isolated local chat archiving and optional model-assisted long-term memory for Muah AI Chatroom.

The full product and integration guide is available in [MANUAL_EN.md](MANUAL_EN.md).

## Quick installation

1. Extract the package to a permanent folder.
2. Open `chrome://extensions/` and enable Developer mode.
3. Choose **Load unpacked** and select this folder.
4. Open Muah AI Chatroom and the extension side panel.
5. Initialize slots 1–10 once, select the number currently open in Muah, and confirm capture.

Before upgrading or moving the extension folder, export each important slot as JSON. Chrome assigns unpacked extensions an ID based partly on their path; changing the path may create a separate local database. JSON import and manual binding restore the archive safely.

## Safety guarantees

- Every archive has an extension-generated UUID.
- Web and PWA slots are separate namespaces.
- Ambiguous or conflicting slot evidence pauses reads and writes.
- Imports always create a new UUID and never silently overwrite an archive.
- v0.22.1 repairs the v0.22.0 partial-window overwrite bug and can recover affected JSON imports from intact snapshots.
- Muah's SYSTEM SUMMARY is comparison material only; it is never treated as authoritative raw story history.

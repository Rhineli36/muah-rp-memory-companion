# Muah RP Memory Companion

## Complete User and Integration Manual

Version 0.22.1 — English Edition

## 1. Purpose

Muah RP Memory Companion is a local-first Chrome extension designed for long-running roleplay conversations in Muah AI Chatroom. It addresses four practical problems:

1. A long conversation is difficult to review in the original chat interface.
2. A model's active context and built-in summary may gradually omit older facts.
3. Different character slots must never share memories accidentally.
4. Users need portable backups that survive extension upgrades or local database changes.

The extension archives raw user and AI messages, keeps each Muah slot isolated by a locally generated UUID, creates readable story exports, and can use a user-provided OpenAI-compatible API to maintain structured long-term memory.

It is an independent prototype. It does not require or claim access to private Muah server APIs.

## 2. Privacy and trust model

- Raw chat, bindings, summaries, checkpoints, and API settings are stored in the extension's local browser storage.
- Chat text is not sent anywhere unless the user configures an external model and requests memory generation, comparison, or automatic extraction.
- The configured API key is stored locally in Chrome extension storage.
- The external model receives data only from the archive UUID selected by local code. The model cannot choose, merge, or rebind slots.
- Muah's SYSTEM SUMMARY and core prompt are treated as reference data, never as instructions to the extension.
- Imported files are untrusted data. They create a new UUID and cannot silently overwrite an existing archive.

For a production Muah integration, API keys should be replaced with first-party authenticated model calls, server-side authorization, auditable retention controls, and explicit user consent.

## 3. Installation

1. Extract the extension to a permanent directory.
2. Open `chrome://extensions/`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the extracted directory.
5. Open Muah AI Chatroom.
6. Open the extension from Chrome's toolbar or side panel.

Moving an unpacked extension to another path may change its Chrome extension ID and therefore expose a new empty local database. Export important archives as JSON before upgrades or moves.

## 4. Web and PWA capture modes

The header contains a PWA switch.

- **Off:** the extension captures only a normal Muah browser tab.
- **On:** the extension captures only the standalone Muah PWA window.

The two modes have separate slot sets because the same numbered slot may contain different conversation state in the browser and PWA. If the selected target is not running, capture stops. The extension never silently falls back to the other surface.

## 5. Slot isolation

Select the same numbered slot that is currently open in Muah. Slots 1–10 are mapped one-to-one to independent local archives.

Each archive has:

- a generated UUID;
- a display name;
- a Web or PWA namespace;
- raw ordered messages;
- a core-prompt profile;
- long-term memory and immutable checkpoints;
- comparison sources and derived outputs;
- snapshots and export metadata.

Names are labels only. UUIDs and verified bindings determine identity. If multiple pieces of page evidence point to different archives, the extension reports a conflict and pauses all reads and writes.

### Initial setup

1. Open the Muah slot selector.
2. Click **Initialize slots 1–10** once.
3. Select the number currently open in Muah.
4. Click **Confirm and capture**.

Manual binding is available for restored or independently created archives. One archive cannot be manually bound to two slots.

## 6. Raw chat capture

The extension extracts visible user and assistant messages, removes message-menu controls and token counters, preserves paragraph breaks, and ignores Muah's SYSTEM SUMMARY. It also ignores memory blocks marked by the companion, preventing copied memory from being archived recursively as new story events.

### Automatic mode

Automatic capture batches changed message identities. It is designed to work with virtualized chat windows where the number of visible messages may remain constant while older elements leave the DOM and new elements appear.

### Manual mode

Manual mode never writes chat automatically. Use **Capture now** to scan and save the current page.

### Regeneration handling

Stable message IDs update their matching record. An implicit replacement is allowed only for the final stored response, where regeneration is plausible. A partial chat window is never allowed to overwrite older historical rows.

## 7. Raw archive and story reader

The **Raw chat archive** tab shows locally saved messages. **Read all** opens a dedicated reader with:

- chronological local ordering;
- search;
- adjustable font size and reading width;
- light and dark themes;
- printing and PDF support;
- standalone HTML export.

The reader never asks AI to rewrite the story. Exported HTML embeds a portable machine-readable copy of every message, role, timestamp, and order, allowing the extension to restore the story later.

## 8. Backups and restoration

### JSON export

JSON is the complete backup format. It includes the archive, raw messages, snapshots, memory document, memory checkpoints, core prompt, Muah comparison source, derived outputs, and comparison history.

### JSON import

Import always creates a new UUID. A prominent pending-import card remains visible until the user binds or dismisses it.

Version 0.22.1 can detect a specific corruption pattern produced by version 0.22.0: duplicate sequence numbers or a mismatch between the declared count and actual rows. If an intact snapshot is present, import reconstructs the historical base and appends only genuinely new later messages.

### HTML restoration

A **Read all** HTML export restores ordered raw story messages, but not the complete long-term memory and settings. Prefer JSON for full fidelity.

## 9. External model configuration

The extension supports OpenAI-compatible chat-completions APIs. OpenRouter can be used with:

- Base URL: `https://openrouter.ai/api/v1`
- API key: the user's OpenRouter key
- Model: selected from the fetched model list
- Temperature and maximum output tokens: user configurable

**Fetch model list** calls the provider's models endpoint and fills the model selector. **Test connection** performs an actual low-cost completion call and reports provider or model errors instead of requiring the user to guess an ID.

Provider availability, pricing, regional restrictions, context limits, and account permissions remain the provider's responsibility.

## 10. Long-term memory

Long-term memory is stored separately for every archive UUID. Incremental extraction sends only unprocessed chat batches together with:

- the prior complete memory;
- immutable checkpoint summaries;
- the current slot's core prompt as setting reference;
- global writing preferences.

The model is instructed to preserve still-valid earlier facts when a new batch does not repeat them. It returns structured JSON containing:

- overview;
- important facts;
- characters;
- relationships;
- timeline;
- open threads;
- compact memory;
- core-plot-only output;
- relationship-only output;
- a summary of the newly processed segment.

Every successful incremental batch creates a checkpoint. **Rebuild from the beginning** is an advanced, potentially expensive operation that processes the entire archive again while retaining the previous memory as a checkpoint.

## 11. Memory outputs

The user can select:

- **Default compact memory** — balanced context for reinserting into chat;
- **Core plot only** — major events and unresolved plot threads;
- **Characters and relationships only** — identities, relationship states, and important interpersonal changes;
- **Chronological summary** — medium-detail story order, more detailed than compact memory but less verbose than the full internal timeline.

Outputs can be split by character budget. Each copied or inserted segment includes context markers and instructions telling the roleplay model that the text describes prior memory rather than a new event. The capture engine excludes marked blocks to prevent recursive “memory of memory” accumulation.

## 12. Core prompt synchronization

The core prompt is stored per archive UUID. The extension can read it when Muah's settings page exposes a visible core-prompt field, or the user can paste it manually.

The core prompt helps the memory model understand world rules and character definitions. It is not treated as evidence that an event occurred. Instructions inside imported prompts cannot override archive ownership or system rules.

## 13. Muah memory gap analysis

Muah's SYSTEM SUMMARY may become compressed as a story grows. The comparison feature evaluates three sources:

1. local long-term memory and checkpoints;
2. Muah's current SYSTEM SUMMARY;
3. the slot's core prompt.

It produces:

- key facts missing from both Muah sources;
- facts covered only by the core prompt;
- conflicts or uncertain claims requiring review;
- details omitted because of the output budget;
- a missing-memory supplement;
- a completed combined summary;
- a short core-prompt patch.

Muah-only claims unsupported by local history are reported as conflicts rather than promoted to facts. Comparison results never overwrite long-term memory automatically.

## 14. Architecture overview

- **Content script:** observes the Muah DOM, extracts messages, detects slot evidence, reads optional summary/core-prompt fields, and inserts user-approved memory into the composer.
- **Background service worker:** owns target selection, slot resolution, capture gating, persistence orchestration, model calls, and source-revision checks.
- **IndexedDB storage:** stores archives, bindings, messages, snapshots, memory documents, checkpoints, slot profiles, comparison sources, derived outputs, and comparison history.
- **Side panel:** presents capture controls, slot binding, memory operations, backup/restore, comparison, and API settings.
- **Reader:** renders the complete raw archive and produces portable HTML.

Source revisions prevent an asynchronous model result from slot A or an older source state from being saved into slot B or replacing newer data.

## 15. Recommended first-party Muah integration

The prototype's DOM observation exists because the extension has no first-party event stream. A native implementation should replace DOM heuristics with stable APIs:

### Stable identifiers

- account-scoped conversation ID;
- slot ID independent of display name and screen position;
- immutable message ID;
- branch/regeneration parent ID;
- monotonically ordered event sequence;
- explicit Web/PWA/shared-state semantics.

### Suggested events

- `conversation.message.created`
- `conversation.message.updated`
- `conversation.branch.selected`
- `conversation.slot.changed`
- `conversation.summary.updated`
- `conversation.core_prompt.updated`

### Suggested memory tools for the Muah model

- `memory.get_compact(slot_id)`
- `memory.search(slot_id, query, limit)`
- `memory.get_timeline(slot_id, range)`
- `memory.get_relationships(slot_id)`
- `memory.get_open_threads(slot_id)`
- `memory.get_volume(slot_id, volume_id)`

Tools should be read-only during ordinary generation. Memory updates should pass through a controlled reducer with provenance, revision checks, and user-visible audit history.

### Recommended context strategy

Use compact memory by default. Retrieve full documents only when the model has a specific question that compact memory cannot answer. Show a warning before user-triggered full-history processing because it can consume substantially more tokens.

## 16. Proposed 100,000-character volume system

A future first-party design should roll an active story into a sealed volume near 100,000 characters. Each sealed volume should contain:

- a human-readable HTML story;
- a machine-readable ordered transcript;
- a chronological volume summary;
- relationship and character deltas;
- open threads carried into the next volume;
- provenance hashes and source message ranges.

New chat would continue in a fresh active volume. Normal model generation would read compact long-term memory plus recent volume summaries. A deliberate **Read full history** operation could load all volumes with a clear high-token-cost warning.

This volume feature is documented as a design target and is not implemented in v0.22.1.

## 17. Known limitations

- Muah DOM changes can break selectors until the extension is updated.
- Core-prompt and SYSTEM SUMMARY reading depends on visible page structure.
- Automatic slot detection is intentionally conservative and may require manual confirmation.
- External model quality and JSON compliance vary by provider and model.
- The extension cannot make Muah's own model call local memory directly; it can copy or insert selected memory into the composer.
- The current extension is a prototype, not a substitute for first-party server-side persistence, authorization, synchronization, or moderation controls.

## 18. Troubleshooting

### Capture is paused

Confirm the Web/PWA mode, open the correct Muah slot, select the same number in the panel, and click **Confirm and capture**.

### New messages do not appear

Use **Capture now**, then refresh the raw archive. Confirm that the archive UUID and slot number are the intended ones.

### An imported archive appears empty

Import creates an independent archive. Select the destination slot and use the pending-import card to bind it.

### Model returns no usable text

Increase maximum output tokens, select a model that supports normal final text rather than reasoning-only output, and run **Test connection**.

### Before any destructive action

Export the slot as JSON. Clearing a slot creates a local snapshot, but an external JSON backup is the safest recovery path.

# MOCHI

**My Offline Conversation Hub & Intelligence** — a local-first desktop notetaker for meetings and lectures.

MOCHI keeps notes, recordings, transcripts, and its SQLite library on your computer. It has no account, analytics, cloud sync, or required API key.

**[Website and Mac download](https://mochi-notes-website.vercel.app/)** · Apple silicon · macOS 15+

The download is an ad-hoc signed test build, not notarized by Apple; macOS may warn before opening it. Building from source lets you inspect the code, but does not itself verify the prebuilt download or remove permission prompts.

## Quick start: build and install from source

The supported target is an Apple-silicon Mac running macOS 15 or later. Install Git, Node.js and npm, Rust and Cargo, CMake, and Apple's Command Line Tools and a recent macOS SDK. If needed, install Apple's tools with `xcode-select --install`.

Clone the repository and build the app:

```bash
git clone https://github.com/himnishpersonal/mochi.git
cd mochi
npm ci
npm run tauri:build:system-audio
open src-tauri/target/release/bundle/macos/
```

Drag `MOCHI.app` from the opened folder into Applications, then open it. The first build downloads dependencies and can take time. If macOS blocks opening it, approve the app in Privacy & Security. Do not replace an existing copy until you are ready: ad-hoc builds can cause recording permission prompts to reappear. This command includes the native system-audio feature; a generic Tauri build may not.

In MOCHI, open Settings to install Whisper and Qwen. Create a note, choose Meeting for Mac audio plus microphone or Room for microphone only, grant the requested permissions, and record. Review the transcript and enhanced notes: model outputs and transcriptions can be wrong. Respect participants' consent and applicable recording laws.

Meeting-mode live transcription currently covers Mac audio; choose **Refine full recording** if you also need the microphone transcribed. Refinement is optional. Models are downloaded when you choose to install them; normal transcription and local model processing happen on your Mac.

## MCP with Claude Desktop or Codex

In Settings, select notes or folders to share, choose whether to include personal notes or transcripts, and start the MCP server. Copy the configuration for your client from MOCHI and merge it into the client's existing configuration. Keep MOCHI running and restart the client as needed. Sharing is read-only and off by default; stop it or revoke access in Settings. The local credential is stored in macOS Keychain.

A connected client can send retrieved content to its model provider, so a local MCP connection does not guarantee the client processes that content on-device. The optional ChatGPT tunnel has separate requirements: see [MCP setup and test status](docs/MCP-CHATGPT.md).

No license has been selected yet; source availability alone does not grant permission to modify or redistribute the code.

## What works in 0.7

- Work in a single notepad with one collapsible sidebar for folders and recent notes; no second note rail or tab maze.
- Keep the top-right Record/Stop control ready while writing. Pick meeting/system-audio or microphone-only Room mode under Recording options, or import media.
- Start with an empty, editable note. Format bullets, numbered lists, section headings, and checklists without inserting template text into the note.
- Toggle checklist items directly with their boxes or keyboard Space; completion is saved in the original note. The transcript has an explicit “Back to notes” control.
- Add a plain-language “What should MOCHI look for?” instruction and select an enhancement recipe before generating.
- Generate a separate, editable Enhanced notes version by merging transcript evidence with your latest written notes and focus. Personal corrections and additional facts can be included even when absent from audio. Transcript citations jump to source times; personal evidence is labeled “Your notes” with a saved source excerpt, never a fabricated timestamp. Your original notes are never replaced.
- Ask a question about the current meeting from its notepad, or search/ask across the local library.
- Keep the transcript, recording playback, language/refinement controls, speakers, and Moments behind a compact Transcript disclosure.
- Organize notes with folders and Archive; legacy tags/people remain stored for compatibility but are not part of the everyday notepad flow.
- Run the local Qwen-powered Librarian to propose a title and folder from note evidence; review the proposal before any change is applied.
- Run versioned local workflows for filing and source-supported follow-ups, with editable saved previews, explicit approval, cancellation, bounded retries, restart recovery, and per-note activity receipts.
- Apply local workflow changes and receipts in one SQLite transaction, with source/revision checks and protection against repeated or concurrent approval. See [the harness delivery status](docs/AGENT-HARNESS-DELIVERABLE.md) for the implemented scope and remaining integration work.
- Write portable notes with friendly section text, bullets, numbered lists, and checklists without exposing Markdown heading syntax.
- Mark structured Decision, Action, and Bookmark Moments during recording, label them afterward, and jump back to their exact audio timestamp.
- Open a local command palette with `Cmd+K` to navigate, search notes, start recording, or reach common actions.
- Record microphone audio locally with recoverable chunked writes.
- Use Shadow MOCHI during a meeting: a movable `368 × 72` always-on-top recording bar that expands to a `520 × 388` live panel.
- See audio levels and provisional, chunked Whisper transcription while recording. Full-recording refinement is optional.
- Ask local Qwen questions from the conversation so far and mark timestamped decisions, actions, and bookmarks.
- Hide or restore the meeting overlay from anywhere with `Cmd+\` on macOS (`Ctrl+\` on Windows/Linux).
- Import WAV, MP3, M4A, MP4, MOV, WebM, OGG, FLAC, and AAC.
- Install Whisper Small once (488 MB, SHA-256 verified) and transcribe locally.
- Review timestamped transcript segments, rename speakers, and run offline acoustic speaker clustering with low-confidence overlap flags.
- Install Qwen3 4B and its pinned llama.cpp runtime from Settings, then generate citation-backed meeting briefs without a separate server.
- Process long meetings in resumable chunks and consolidate the chunk briefs without losing original citations.
- Search the full local library and ask Qwen evidence-grounded questions with note and timestamp sources.
- Track structured action items with status, assignee, due date, source note, and citations.
- Export Markdown, JSON, SRT, transcript, evidence metadata, and original audio.
- Back up and restore the complete SQLite-and-audio library with an automatic pre-restore recovery copy.
- Use a calm paper-and-ink interface, including a warm light Shadow MOCHI overlay, with reduced-motion support and plain product copy.

## Optional MCP sharing

MOCHI now provides a read-only MCP server with scoped `search` and `fetch` tools. In Settings, choose notes/folders, separately grant transcript or personal-note access, and start the local server. Credentials are kept in macOS Keychain. Stop or revoke access at any time.

Claude Desktop and Codex can connect locally through the included stdio bridge. ChatGPT can also reach it through an authorized OpenAI Secure MCP Tunnel. Content returned to a cloud-connected client can leave the Mac; ordinary local notebook and AI processing remain on the Mac. See [MCP setup and test status](docs/MCP-CHATGPT.md).

## Run it

```bash
npm install
npm run tauri:system-audio
```

For the web UI alone:

```bash
npm run dev
```

The web preview uses browser local storage and intentionally cannot access desktop-only functions such as importing media, audio persistence, export, or model installation.

## Verify it

```bash
npm test -- --run
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

See [the final manual test guide](docs/FINAL-HANDOFF-TEST.md) for the exact hands-on acceptance path.

Build a debug macOS application bundle:

```bash
npm run tauri build -- --debug --bundles app
```

The app bundle is emitted under `src-tauri/target/debug/bundle/macos/MOCHI.app`.

## Local models

The UI installs the Whisper.cpp model after an explicit click. Audio never leaves MOCHI during transcription.

For note generation, Settings installs the official Qwen3 4B Q4_K_M model and a pinned macOS ARM64 llama.cpp runtime (b10728, whose optional RDMA dependency is weak-linked for macOS compatibility). Both downloads are SHA-256 verified. MOCHI starts and stops the loopback server itself; a separate terminal process is not required. Advanced users may still choose another unauthenticated loopback endpoint (`localhost`, `127.0.0.1`, or `::1`).

## macOS system audio

ScreenCaptureKit system + microphone capture is MOCHI's primary remote-meeting mode and is compiled into the system-audio build:

```bash
npm run tauri:system-audio
```

Create the production app with:

```bash
npm run tauri:build:system-audio
```

The resulting macOS `.app` bundle is under `src-tauri/target/release/bundle/macos/`.

It requires macOS 15+ and Apple's Command Line Tools. MOCHI always uses visible macOS recording permission prompts; it does not support covert capture. The normal `Meeting` mode never silently falls back to microphone-only; use `Room` when you intentionally want microphone-only capture.

The local test bundle is ad-hoc signed, not Developer ID signed or notarized. If Gatekeeper blocks first launch, Control-click `MOCHI.app` and choose **Open**. Distribution outside this Mac requires Developer ID signing and notarization.

Ad-hoc updates change the app's code-signing requirement, so macOS can show an enabled recording toggle for an older build while denying the current one. MOCHI rechecks access on window focus and offers **Check access again**; Record does not automatically request permission. If access remains unavailable, fully quit and reopen `/Applications/MOCHI.app`. If needed, remove only MOCHI from Screen & System Audio Recording and add the current installed copy again. Do not reset other applications' permissions. Stable permissions across releases require a consistent signing identity.

## Data location

Tauri stores application data in the platform application-data location. On macOS this is normally:

`~/Library/Application Support/app.mochi.desktop/`

It contains `mochi.sqlite3`, the `audio/` directory, and downloaded models in `models/`.

## Local agent harness

MOCHI's first agent recipe is the Librarian (v2). A recipe gathers only bounded local context, sends it to the packaged loopback Qwen runtime with a strict JSON contract, sanitizes and validates the response, and stores it as a proposal. The UI requires explicit acceptance. Applying a reviewed proposal executes a registered local tool (`organize_note` or `add_action_items`) with source/revision checks, and commits its receipt with the changes. The Librarian only proposes a title and folder; it leaves legacy tags and people untouched. MCP exposes a separate read-only adapter (`search` and `fetch`) with explicit sharing grants; it cannot invoke those write tools. See the harness and MCP delivery documents for current limits.

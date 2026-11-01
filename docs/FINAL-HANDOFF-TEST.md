# MOCHI final handoff test

This checklist validates the user-facing notepad flow plus the existing local recording, workflow harness, and optional MCP features. It does not ask you to delete or reset your current library.

## 1. Open and prepare

1. Open `MOCHI.app` from `src-tauri/target/release/bundle/macos/`.
2. Confirm the app opens to the single notepad workspace: one collapsible sidebar, folders/recent notes, and Record in the top-right corner.
3. In Settings, enable Whisper and local Qwen if they are not already installed. Downloads happen only after you choose them. Wait until both show Ready.

## 2. Note and enhancement flow

1. Choose **New note**. Confirm the note starts blank and is saved locally.
2. Type ordinary notes with bullets/checklists. Add a useful title.
3. In **What should MOCHI look for?**, enter a request such as “Find the decisions, owners, and anything due next week.”
4. Pick an enhancement recipe. Confirm this does not replace or prefill your notes.
5. Click **Record**. Use Meeting to capture system audio + microphone, or choose Room when you only want the microphone. Try a short conversation with spoken decisions, owners, and dates.
6. Stop. Confirm audio is saved and that provisional transcript text is available while recording (with Whisper installed).
7. Open **Transcript**. Review the text and play the local recording. Check that source citations jump to the relevant transcript time.
8. Click **Enhance notes**. Confirm the enhanced version is separate, cites its evidence, and reflects the focus request. Edit a generated paragraph, click elsewhere, then leave and reopen the note; the edit should remain.
9. Confirm your handwritten notes are unchanged. Ask a question in **Ask this meeting**; try both a fact in the recording and a fact that was never mentioned.

## 3. Organization and safety

1. Create a folder from the sidebar. Assign a note using its Folder picker and select the folder to browse its notes.
2. Collapse and re-open the sidebar; confirm the choice persists after restarting MOCHI.
3. Use **More → Archive** or the note’s menu to archive, restore, and delete a disposable test note.
4. Open **Actions and recipes**. Run a local recipe and confirm it presents a preview; edits should require explicit approval before they affect the library.
5. Optionally open Settings → MCP. Start with one test note/folder and keep transcript/personal-note grants off unless you intend to share them. Verify search/fetch from an authorized client, then stop or revoke the server.

## 4. Capture polish

1. With a test recording, show the floating Shadow MOCHI bar and collapse/expand it.
2. Try `⌘\\` to hide/show the overlay.
3. Try a short Meeting capture while wearing headphones. Confirm both system audio and microphone are present in playback. This step needs Screen & System Audio Recording and Microphone permissions.

## Expected boundaries

- The app and models run locally; optional MCP deliberately shares only the notes and fields you grant. Anything retrieved by ChatGPT is then processed by ChatGPT.
- A ChatGPT connection additionally needs the authorized Secure MCP Tunnel and a compatible ChatGPT workspace/account; the local MCP server can be tested independently.
- First-time model downloads need an internet connection. Normal note-taking and local Qwen/Whisper processing do not.
- If macOS asks for capture permission, grant both recording and microphone access, then fully quit and reopen MOCHI.

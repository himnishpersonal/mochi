# MOCHI MCP and ChatGPT testing

Implemented October 20, 2026. This is the read-only MOCHI server milestone. ChatGPT account/tunnel setup and a successful tool call in ChatGPT are separate acceptance steps; they have not yet been completed.

## What is implemented

- Official Rust MCP SDK `rmcp` 3.6.0 with Streamable HTTP on `127.0.0.1` only. Supported protocol revisions: 2025-03-26, 2025-06-18, and 2025-11-25. The server negotiates initialization and returns JSON responses without persistent transport sessions.
- Exactly two read-only tools: `search(query)` and `fetch(id)`. Results are returned as structured content and matching JSON text for compatibility.
- Explicit note and/or project grants; no default library-wide access. Project grants include future unarchived project members. Archived notes are always excluded.
- Shared notes expose titles, generated briefs, and actions. Transcripts and personal-note text require independent opt-in. Briefs/actions may themselves contain information derived from the underlying meeting and personal notes; review them before sharing.
- Search permissions are enforced inside the SQLite FTS query, including which columns may match. A private field cannot create a search hit when its permission is off.
- Fetch enforces the same current note/project membership and archive policy, including direct-ID requests. Missing and unshared notes return the same message.
- Search returns at most 20 results. Fetch returns up to 24,000 characters with an explicit truncation marker/metadata. Broad enumeration, audio retrieval, shell execution, and write tools are not exposed.
- Settings UI for scope selection, Start/Stop, revocation, port selection, bridge-command copying, and access history.
- Credential generated per sharing session and saved only in macOS Keychain. The database stores sharing configuration and sessions, not bearer secrets. HTTP request authentication uses constant-time comparison of token hashes.
- Stopping invalidates the active session and credential. Revocation additionally clears the saved sharing selection. The server does not automatically restart when MOCHI relaunches.
- Host/Origin validation, a 16 KiB request limit, 180 requests/minute per server, eight concurrent requests, and a five-second HTTP handler deadline.
- Bounded access history: latest 1,000 events retained; latest 50 displayed. Tool name, outcome, result count, and time are logged; query text, credentials, and returned content are not.

## The private connection path

```text
ChatGPT → OpenAI Secure MCP Tunnel → tunnel-client → MOCHI stdio bridge
                                                     ↓
                                   authenticated loopback MCP server
                                                     ↓
                                      explicitly shared SQLite notes
```

The stdio bridge is a mode of the same MOCHI executable (`--mcp-stdio`). It starts without the desktop windows. The copied command contains an endpoint and session ID, but no secret. The bridge reads its credential from Keychain once at startup and checks both endpoint and session ID. An old bridge command cannot obtain a new sharing session's credential after revocation or restart.

A tunnel client sends MCP JSON over stdin/stdout; the bridge authenticates its local HTTP requests. The MOCHI bearer credential stays on the Mac. The OpenAI tunnel runtime uses a separate OpenAI runtime key for its control plane. Neither key belongs in chat, command arguments, screenshots, or committed files.

This implementation is a private/local integration. It is not an OAuth-enabled public MCP service or a published ChatGPT plugin. ChatGPT receives the note content returned by tools; the optional connected workflow uses cloud processing.

## Start the server

1. Open the updated desktop app and go to **Settings → Use MOCHI in ChatGPT**.
2. Choose a synthetic test note or test project first. Transcripts and personal notes are off by default.
3. Click **Start MCP server**. macOS may ask you to allow Keychain access.
4. Expand **Connect to ChatGPT** and copy the **Desktop bridge command**.
5. Leave MOCHI running. After restarting the server, copy the new command and update/restart the bridge.

A running server is not yet proof of a ChatGPT connection. Local references use `mochi://notes/<id>`; they identify notes but are not publicly reachable HTTPS citation pages. Automatic clickable citations/open-in-MOCHI behavior remains a client compatibility check.

## Install the official tunnel client

The development installer downloads the latest official macOS release from `openai/tunnel-client` and verifies its published SHA-256 checksum:

```bash
python3 scripts/install_mcp_tunnel.py
.tools/tunnel-client help quickstart
```

The local install used for this milestone is v0.0.16. `.tools/` is ignored. The installer does not start a tunnel, create a remote resource, or transmit meeting content.

## Authorize and connect ChatGPT

Use the current [OpenAI tunnel instructions](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) and [custom MCP server setup](https://developers.openai.com/api/docs/guides/custom-mcp-server).

1. In [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels), create or reuse a tunnel associated with the intended ChatGPT workspace. Creating/managing a tunnel needs Tunnels Read + Manage. The runtime and app operator need Tunnels Read + Use. Account/workspace custom-MCP permissions also apply.
2. Provide the runtime key locally through a secure environment/secret reference named `CONTROL_PLANE_API_KEY`; do not paste it into this chat or place it in a profile as literal text. A Platform admin key is not the runtime key.
3. Create a profile using the actual tunnel ID and copied bridge command. The template below contains placeholders, not working credentials:

```bash
.tools/tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile mochi \
  --tunnel-id YOUR_TUNNEL_ID \
  --mcp-command "PASTE_THE_COPIED_DESKTOP_BRIDGE_COMMAND" \
  --health-listen-addr 127.0.0.1:0

.tools/tunnel-client doctor --profile mochi --explain
.tools/tunnel-client run --profile mochi
```

Use an ephemeral health port (`:0`): the default tunnel health port is 8080, which MOCHI's Qwen server already uses. The profile stores the command and an environment secret reference, not the credential itself.

4. Keep the client running for discovery and subsequent tool calls. For a managed runtime, inspect `tunnel-client runtimes connect --help` and confirm health/readiness with `runtimes status` before reporting success.
5. In ChatGPT's custom MCP setup, select **Tunnel** and the associated tunnel. The app's MCP authentication can be configured as none for this stdio path: workspace/tunnel permissions authenticate the remote route, and the bridge adds MOCHI's local bearer authentication. This does not make MOCHI a public unauthenticated HTTP endpoint.
6. Confirm discovery finds exactly `search` and `fetch`. Then make an actual search/fetch call from ChatGPT.

No tunnel profile existed on this Mac when inspected. No OpenAI tunnel/account authorization was created or reused during implementation.

## Acceptance test

Use two synthetic meetings, share one, and keep the other outside the grant.

- Ask ChatGPT: “Use MOCHI to find the launch review. What day is the launch? Quote the evidence.” It should search, fetch the shared note, and answer the known fact.
- Ask about the unshared meeting and attempt direct-ID fetch. Its content must not be returned.
- With transcript/personal-note permissions off, searches for words present only in those fields must return no hits. Explicitly grant each field and repeat.
- Stop the server, then request fresh data from ChatGPT. The call must fail. Previously returned text can remain in the conversation; revocation cannot recall it.
- Restart with a different scope. The old bridge command must fail; use the new session-bound command to reconnect.
- Revoke access. Verify server stopped, selection cleared, and subsequent calls denied.
- Reopen MOCHI. The server should remain stopped.

## Verification performed

- Nine MCP-focused Rust tests pass, including real HTTP requests and an official SDK client handshake/search/fetch.
- A stdio-to-HTTP round trip passes using an isolated SQLite library and synthetic data; stdout contains only protocol responses and no credentials.
- Tests cover scope/field isolation, direct-ID denial, live project membership, archive exclusion, bounded fetch, query injection attempts, invalid bearer tokens, Host/Origin rejection, request-size limits, rate/concurrency limits, restart revocation, and endpoint/session credential binding.
- Five MCP UI tests cover opt-in defaults, explicit start, save without starting, revocation, start errors, and desktop-only controls.
- Full suite: 45 Rust tests and 30 frontend tests pass. The separate live-Qwen smoke test remains opt-in and was not needed for MCP reads.
- TypeScript/production frontend build and the debug macOS system-audio app bundle build pass.
- Native UI automation could not attach to MOCHI’s running window; the new settings were covered by component tests, but a packaged click-through remains to be checked after restarting MOCHI.
- Actual ChatGPT tool discovery/calling requires the account and tunnel authorization above and remains unverified until completed in ChatGPT.

## Current scope and limitations

One active sharing grant/server at a time. All clients authorized through that session see the same scope. Per-client profiles, OAuth, public hosting, external write tools, a MOCHI MCP host/client for Linear/Notion/Slack, transcript pagination, public citation pages, and persistent managed tunnel supervision are future work. Core notebook functions and MCP reads do not require an OpenAI API key; the optional OpenAI tunnel connection requires its own account permissions and runtime authorization.

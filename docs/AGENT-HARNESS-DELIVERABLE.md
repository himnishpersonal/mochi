# Agent harness H1: delivery contract

Status: local harness core implemented October 20, 2026. The broader H1 contract below remains partially complete; The read-only MCP server and scoped sharing are now implemented; external providers, per-client connection profiles, local undo, and model scheduling remain later work. See [MCP status](MCP-CHATGPT.md).

## Implemented local core

`src-tauri/src/harness.rs` provides the versioned recipe/tool definitions, execution state machine, bounded evidence snapshots, typed proposal validation, cancellation, interrupted-run recovery, approval, and transaction receipts. The notebook exposes progress, editable previews, save/dismiss/approve, resume/cancel, and per-note activity history in `src/HarnessPanel.tsx`.

Two recipes run through the same lifecycle:

- **Suggest filing (v2):** title and folder only. An empty folder suggestion leaves the current folder unchanged; applying it never rewrites legacy tags or people. Existing archive status is preserved.
- **Find follow-ups:** up to eight editable descriptions with exact source quotes; approving adds local action items, preserves existing actions, skips matching descriptions, and updates export data. It does not infer owners or deadlines.

### Execution and storage

`start_agent_run` persists a queued run, source digest, bounded model context, recipe version, and completed read step before inference begins. `execute_agent_run` claims the run exclusively, records the model/attempt, and invokes the existing loopback-only inference adapter. The model gets at most 18,000 transcript characters and 6,000 personal-note characters, plus the current title and existing project names. A successful output becomes a persisted preview requiring review.

Each run allows three user-triggered generation attempts, with one automatic retry per attempt for connection failures, timeouts, HTTP 429, and selected 5xx responses. Schema errors and writes are not automatically retried. Filing uses a 384-token/35-second model request budget; follow-ups use 1,536 tokens/120 seconds. Backoff is 600 ms and cancellation includes backoff. Actual generation duration is recorded locally in milliseconds; token usage is not yet measured.

`agent_runs` is extended through additive migrations. `agent_steps` stores checkpoints and local tool input/results; `agent_events` stores the ordered lifecycle log. Existing Librarian history remains readable. Legacy pending previews must be dismissed and regenerated because they lack source/version bindings.

A relaunch marks unfinished generation as interrupted. Resume uses the saved evidence and original model; ready previews remain ready. Interrupted model requests are rerun, because partial model generation cannot be checkpointed by this inference adapter. Completed local writes are never replayed.

### Approval and tools

`save_agent_proposal` checks the preview revision and saves edits without applying them. `approve_agent_run` checks the recipe version, preview revision, and current source digest, then validates the final submitted payload. The approved manifest includes the exact normalized proposal, source digest, recipe/tool versions, and approval time. Its SHA-256 digest is recorded with the review and execution steps.

Approval, local tool writes, result receipts, and the terminal state commit in one immediate SQLite transaction. Failure rolls all of them back. Repeated or concurrent approval can commit only once. Filing receipts contain previous title/organization and resulting values; follow-up receipts contain created IDs and duplicate counts. Cancelling a run persists cancellation before aborting inference, and late model output cannot revive it.

The recipe allowlist selects one registered local write tool. Model output contains data only; it cannot choose arbitrary tools, run shell commands, expand the evidence scope, or execute an external request. Follow-up evidence must be an exact substring of the saved meeting context. Invalid previews preserve the original note.

### Try it

In the desktop app, open a saved note with transcript or personal notes and start Qwen in Settings. Choose **Suggest filing** or **Find follow-ups**. For filing, edit the title or folder; a blank folder keeps the note where it is. Edit and save the preview, then approve or dismiss it. Expand **Activity** and **Run details** for receipts. To check recovery, close during generation, reopen the note, and choose **Resume**. Older v1 filing previews are dismiss-only and should be regenerated. Approval is disabled while recording or saving; a changed source requires a fresh preview.

Automated coverage includes revision conflicts, source changes, rollback after an injected tool failure, late responses after cancellation, restart recovery with a real SQLite file, concurrent approvals, evidence validation, duplicate follow-ups, legacy migration, and review controls.

### Verification results

- Final frontend verification: 31 tests pass. Final Rust verification: 48 pass and one optional live-model smoke test is ignored unless a local Qwen endpoint is running.
- The live Qwen smoke test was also run against synthetic evidence: filing generated and applied in 3.1 seconds; follow-ups in 2.4 seconds. This checks the local request/validation path, not model quality or general latency.
- `npm run build` passes. `npm run tauri:build:system-audio` produces the 24 MB macOS app with system-audio capture included.
- The built app passes strict ad-hoc code-signature verification and launches into the packaged notepad. This local build is not Developer ID signed or notarized; macOS may require Control-click → Open on first launch.
- The optional live-model test still requires a running local Qwen model. The checklist in [the final handoff test](FINAL-HANDOFF-TEST.md) covers the remaining manual capture, transcription, and model-quality checks.

Run the optional local-model smoke test with Qwen already started:

```bash
MOCHI_TEST_AI_ENDPOINT=http://127.0.0.1:8080/v1 cargo test --manifest-path src-tauri/Cargo.toml --features native-system-audio local_model_recipes_smoke -- --ignored --nocapture
```

### Remaining H1 work

MCP host/client connections to external apps, OAuth, provider write reconciliation, per-client connection profiles, source-linked note enhancement, field-by-field operation selection, compensating undo, backend model scheduling, trace export, a held-out quality corpus, and reference-Mac model benchmarks are not part of this local core. The following sections retain the full target contract.

## Outcome

A user can run a named recipe on a visible evidence scope, review an editable artifact, approve exact changes, and see durable results after app restart. The same local evidence and tool policy support MOCHI's notebook UI and read-only MCP server.

## Required components

| Component | Required behavior |
| --- | --- |
| Recipe registry | Versioned input/output schemas, prompt version, evidence requirements, allowed tools, model policy, budgets, review rules, and compensation support. |
| Evidence service | Search and bounded fetch over transcripts and personal notes, source IDs/revisions/timestamps, scope filters, and readable provenance. |
| Tool registry | Typed local tools and provider adapters with independent policy checks. Narrow capabilities by recipe and connection grant. |
| Connection manager | OAuth/discovery/refresh, Keychain secret references, multiple workspace profiles, process lifecycle, health, capability changes, and revocation. |
| Durable runner | Persist before execution; checkpoint steps; cancel by run; recover after interruption; enforce token/time/tool-call limits. |
| Model scheduler | Capture and live transcription priority, interactive requests before background recipes, one primary model resident initially. |
| Review/apply service | Editable artifact, exact operation manifest, source revision check, explicit destination, selected operations, and integrity-bound approval. |
| Receipt service | Store tool arguments with appropriate redaction, prior/new local values, provider IDs/links, errors, retry/reconciliation state, and compensation outcomes. |
| Product UI | Run progress, review, edit, dismiss, apply, activity, retry/check-result, and supported undo. |
| Evaluation suite | Quality, mutation-policy, cancellation, recovery, and external-result ambiguity scenarios. |

## Starting recipes

1. **Organize meeting:** improved Librarian, selected-field acceptance, current-version checks, transaction receipts, and local undo.
2. **Enhance notes:** personal notes plus transcript evidence; preserve originals and user edits; source-linked output and resumable steps.
3. **Create Linear issues:** extracted commitments, duplicate candidates, editable drafts, selected project/team, reviewed creation, and provider receipts.

Notion export and Slack summary reuse the same run/review/receipt machinery in the following delivery milestone.

## Persisted model

- `agent_runs`: run/recipe/version, trigger, scope, model/profile, evidence snapshot/revisions, state, budgets, timestamps, and terminal reason.
- `agent_steps`: step type, attempt, input/output references, status, timings, token usage, checkpoint, and error.
- `agent_proposals`: artifact version, proposed operations, source revisions, destination identity, and approved manifest digest.
- `tool_receipts`: tool/version, connection, operation key, redacted arguments, before/after local values, provider ID/link, completion certainty, and compensation data.
- `connection_profiles`: provider/transport/workspace, granted capabilities, secret references, health, and last successful use.

Persist secret values only in the OS credential store. Sensitive evidence copies and logs need a defined retention policy; prefer references to immutable source versions over unbounded duplicate transcripts.

## State and execution rules

Run lifecycle: **queued → gathering evidence → running → validating → awaiting review → applying → completed**.

Additional states: **cancelled, failed, dismissed, stale, needs authentication, needs reconciliation**. The UI can use simpler labels while preserving the exact backend state.

Start with deterministic recipe steps. Allow a bounded read-tool loop where needed, initially capped at three model turns and six tool calls, with at most one schema-repair attempt. Treat these as tunable defaults. Use structured tool arguments; the model never constructs executable shell commands for normal recipes.

Approval binds to the exact operations, content, target, and relevant source revision. Editing the draft changes the manifest and requires the final review state to refresh. A note edited after proposal generation must trigger recomputation or an explicit rebase, not silent overwrite.

Read-only MCP requests enforce the grant independently of the model. Tool annotations from third-party MCP servers are hints; they are insufficient to authorize a write. [MCP annotations guidance](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/).

For external writes, persist a prepared receipt before the request. Use provider idempotency support where available. If the response is lost after a possible server-side commit, record an unknown outcome and reconcile against the provider before retrying. A multi-app workflow is a sequence with possible partial completion, not a distributed SQLite transaction.

Local organization changes support a compensating transaction with version checks. Remote actions expose undo only where the provider and permissions actually support it. Completed actions remain visible if later steps fail or are cancelled.

## Acceptance scenarios

1. Start a recipe, quit/reopen MOCHI, and resume from a completed checkpoint without duplicating an applied action.
2. Edit the source note while an organization proposal is awaiting review; applying it cannot silently replace the newer edit.
3. Cancel a model request and a queued tool request independently; other work and capture continue.
4. Receive malformed JSON or a nonexistent citation; retain the previous accepted note and show a recoverable failure.
5. Retry a local save; preserve IDs and user corrections.
6. Lose the HTTP response after a provider commits an issue; reconcile or ask the user to check the result before another creation attempt.
7. Complete two of three external operations, then fail; show two success receipts and one pending/error item.
8. Revoke a connection or expire its credentials; stop new operations and recover with a clear reconnect flow.
9. Receive instructions embedded in a transcript or tool result; they cannot expand the recipe's allowed tools, scope, or destinations.
10. Call the MOCHI MCP server from a client granted one project; other notes, transcripts, and personal notes stay inaccessible unless granted.
11. Restart after approval but before sending an external request; recover the exact approved manifest and revalidate its conditions.
12. Accept a local filing change, inspect its receipt, and undo it without overwriting unrelated later edits.

## Definition of done

- Production Rust modules with shared model/tool/evidence interfaces.
- Backward-compatible SQLite migrations and failure recovery.
- Main-window review/activity UI and MCP connection controls.
- Unit/integration tests for the acceptance scenarios, plus a small held-out recipe-quality corpus.
- Recorded results for latency, schema validity, source support, and task completion on the M3/16 GB reference Mac.
- Setup instructions, supported provider/client matrix, architecture notes, and an end-to-end demonstration using a test workspace.
- The demonstration runs with a packaged local model; connection authorization is explicit and external calls occur only through configured adapters.

The harness is considered delivered when this behavior works in the packaged desktop app. A prompt collection, JSON parser, or architecture document alone does not satisfy H1.

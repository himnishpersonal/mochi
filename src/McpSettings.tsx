import { useEffect, useState } from "react";
import { Check, Copy, Plug, ShieldCheck } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import "./McpSettings.css";

type Sharing = { noteIds: string[]; projectIds: string[]; includeTranscript: boolean; includePersonalNotes: boolean; port: number };
type Access = { id: number; operation: string; outcome: string; resultCount: number; createdAt: number };
export type McpStatus = { running: boolean; endpoint: string | null; sharing: Sharing; sessionId: string | null; startedAt: number | null; access: Access[]; bridgeCommand: string | null; executablePath?: string };
type Request = <T>(name: string, args?: Record<string, unknown>) => Promise<T>;
export const emptyMcpStatus: McpStatus = { running: false, endpoint: null, sharing: { noteIds: [], projectIds: [], includeTranscript: false, includePersonalNotes: false, port: 17863 }, sessionId: null, startedAt: null, access: [], bridgeCommand: null };

export function McpSettings({ request, desktop }: { request: Request; desktop: boolean }) {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [draft, setDraft] = useState<Sharing>(emptyMcpStatus.sharing);
  const [notes, setNotes] = useState<{ id: string; title: string }[]>([]);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [filter, setFilter] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    void Promise.all([request<McpStatus>("mcp_status"), request<{ id: string; title: string }[]>("list_notes", { query: null }), request<{ id: string; name: string }[]>("list_projects")]).then(([value, noteRows, projectRows]) => {
      if (disposed) return;
      setStatus(value); setDraft(value.sharing); setNotes(noteRows); setProjects(projectRows); setLoaded(true);
    }).catch(cause => { if (!disposed) setError(String(cause)); });
    const timer = window.setInterval(() => {
      void request<McpStatus>("mcp_status").then(value => { if (!disposed) { setStatus(value); if (value.running) setDraft(value.sharing); } }).catch(cause => { if (!disposed) setError(String(cause)); });
    }, 3000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [desktop, request]);

  const running = !!status?.running;
  const changed = !!status && JSON.stringify(draft) !== JSON.stringify(status.sharing);
  function toggle(field: "noteIds" | "projectIds", id: string) {
    setDraft(current => ({ ...current, [field]: current[field].includes(id) ? current[field].filter(value => value !== id) : [...current[field], id] }));
  }
  async function act(action: "start" | "stop" | "revoke" | "save") {
    setBusy(true); setError(""); setMessage("");
    try {
      let next: McpStatus;
      if (action === "start" || action === "save") {
        next = await request<McpStatus>("mcp_save_sharing", { sharing: draft });
        if (action === "start") next = await request<McpStatus>("mcp_start");
      } else next = await request<McpStatus>("mcp_stop", { revoke: action === "revoke" });
      setStatus(next); setDraft(next.sharing);
      setMessage(action === "start" ? "Server started. Connect the bridge to ChatGPT to test it." : action === "save" ? "Sharing selection saved. The server is still stopped." : action === "revoke" ? "Access revoked and sharing selection cleared." : "Server stopped. Its connection credential is invalid.");
    } catch (cause) {
      setError(String(cause));
      // A stop can succeed even if Keychain cleanup fails. Refresh visible state.
      try { setStatus(await request<McpStatus>("mcp_status")); } catch { /* original error remains visible */ }
    } finally { setBusy(false); }
  }
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setMessage("Copied."); }
    catch { setError("Clipboard access failed. Select the connection text and copy it manually."); }
  }
  const shownNotes = notes.filter(note => note.title.toLowerCase().includes(filter.toLowerCase()));
  return <section className="mcp-settings" aria-labelledby="mcp-title">
    <header><div><h3 id="mcp-title"><Plug size={16} /> Connect MOCHI</h3><p>Share selected meeting evidence through a read-only MCP connection.</p></div><span className={running ? "mcp-status ready" : "mcp-status"}>{running ? "Server running" : "Server stopped"}</span></header>
    {!desktop ? <p>Open the desktop app to configure MCP sharing.</p> : <>
      <p className="mcp-disclosure"><ShieldCheck size={15} /><span>The connection stays local, but content retrieved by an AI client may be sent to its model provider. Briefs and actions are included in shared notes; you control access to transcripts and personal notes below.</span></p>
      <fieldset disabled={running || busy || !loaded}>
        <legend>Choose what to share</legend>
        {projects.length > 0 && <div className="mcp-projects" aria-label="Folders to share">{projects.map(project => <label key={project.id}><input type="checkbox" checked={draft.projectIds.includes(project.id)} onChange={() => toggle("projectIds", project.id)} /><span>{project.name}<small>Includes current and future unarchived notes in this folder</small></span></label>)}</div>}
        <label className="mcp-note-filter">Find notes<input type="search" value={filter} onChange={event => setFilter(event.target.value)} placeholder="Filter by title" /></label>
        <div className="mcp-note-list" aria-label="Notes to share">{shownNotes.length ? shownNotes.map(note => <label key={note.id}><input type="checkbox" checked={draft.noteIds.includes(note.id)} onChange={() => toggle("noteIds", note.id)} /><span>{note.title || "Untitled note"}</span></label>) : <p>{notes.length ? "No matching notes." : "Create a note before sharing."}</p>}</div>
        <p className="mcp-selection">{draft.noteIds.length} notes · {draft.projectIds.length} folders selected. Archived notes are excluded.</p>
        <label className="mcp-permission"><input type="checkbox" checked={draft.includeTranscript} onChange={event => setDraft(current => ({ ...current, includeTranscript: event.target.checked }))} /><span>Include transcripts<small>Allows searching and retrieving the recorded conversation as text.</small></span></label>
        <label className="mcp-permission"><input type="checkbox" checked={draft.includePersonalNotes} onChange={event => setDraft(current => ({ ...current, includePersonalNotes: event.target.checked }))} /><span>Include personal notes<small>Allows searching and retrieving text you wrote in the notebook.</small></span></label>
      </fieldset>
      {running && <p className="mcp-selection">Stop the server to change the sharing scope. After restarting sharing, restart the connected client or its bridge.</p>}
      <div className="mcp-buttons">{running ? <><button onClick={() => void act("stop")} disabled={busy}>Stop server</button><button className="mcp-revoke" onClick={() => void act("revoke")} disabled={busy}>Revoke access</button></> : <><button onClick={() => void act("start")} disabled={busy || !loaded || (!draft.noteIds.length && !draft.projectIds.length)}>{busy ? "Starting…" : "Start MCP server"}</button><button className="secondary" onClick={() => void act("save")} disabled={busy || !loaded || !changed}>Save selection</button>{(status?.sharing.noteIds.length || status?.sharing.projectIds.length || 0) > 0 && <button className="secondary" disabled={busy} onClick={() => void act("revoke")}>Clear sharing</button>}</>}</div>
      {message && <p className="mcp-message" role="status"><Check size={13} />{message}</p>}
      {error && <p className="mcp-error" role="alert">{error}</p>}
      {status?.executablePath && <details className="mcp-connection"><summary>Connect to Claude or Codex locally</summary><p>Keep MOCHI open and sharing on. Paste the matching configuration into your client once; restart the client after starting a new sharing session. The bridge reads its credential from Keychain.</p><label>Claude Desktop configuration<div className="mcp-copy"><textarea aria-label="Claude Desktop configuration" readOnly rows={5} value={JSON.stringify({ mcpServers: { mochi: { command: status.executablePath, args: ["--mcp-stdio"] } } }, null, 2)} /><button aria-label="Copy Claude configuration" onClick={() => void copy(JSON.stringify({ mcpServers: { mochi: { command: status.executablePath, args: ["--mcp-stdio"] } } }, null, 2))}><Copy size={14}/></button></div></label><label>Codex configuration<div className="mcp-copy"><textarea aria-label="Codex configuration" readOnly rows={3} value={`[mcp_servers.mochi]\ncommand = ${JSON.stringify(status.executablePath)}\nargs = ["--mcp-stdio"]`} /><button aria-label="Copy Codex configuration" onClick={() => void copy(`[mcp_servers.mochi]\ncommand = ${JSON.stringify(status.executablePath)}\nargs = ["--mcp-stdio"]`)}><Copy size={14}/></button></div></label><p>Merge the Claude entry with existing servers; do not replace your other configuration.</p></details>}
      <details className="mcp-connection"><summary>Connect to ChatGPT</summary><ol><li>Start MOCHI’s MCP server with the notes you want to share.</li><li>Configure OpenAI Secure MCP Tunnel with the desktop bridge command below. The bridge reads the credential from macOS Keychain.</li><li>In ChatGPT, add a custom MCP server, choose the tunnel, and test a meeting search.</li></ol><p>A running local server is one part of the connection. ChatGPT requires an available tunnel and the appropriate account/workspace permissions.</p>
        {status?.bridgeCommand && <label>Desktop bridge command<div className="mcp-copy"><textarea aria-label="Desktop bridge command" readOnly value={status.bridgeCommand} rows={3} /><button aria-label="Copy desktop bridge command" onClick={() => void copy(status.bridgeCommand!)}><Copy size={14} /></button></div></label>}
        <p><a href="https://developers.openai.com/api/docs/guides/secure-mcp-tunnels" target="_blank" rel="noreferrer" onClick={event => { if (desktop) { event.preventDefault(); void openUrl("https://developers.openai.com/api/docs/guides/secure-mcp-tunnels").catch(cause => setError(String(cause))); } }}>OpenAI Secure MCP Tunnel setup</a></p><p>MOCHI exposes search and fetch only. Returned mochi:// references identify local notes; they are not public web links.</p>
      </details>
      <details className="mcp-connection"><summary>Connection details</summary>{status?.endpoint && <label>Local endpoint<div className="mcp-copy"><input aria-label="MCP endpoint" value={status.endpoint} readOnly /><button aria-label="Copy MCP endpoint" onClick={() => void copy(status.endpoint!)}><Copy size={14} /></button></div></label>}<label>Local port<input type="number" min={0} max={65535} disabled={running || busy} value={draft.port} onChange={event => setDraft(current => ({ ...current, port: Math.max(0, Math.min(65535, Math.trunc(Number(event.target.value) || 0))) }))} /></label><p>Use 0 for an available port. The server binds only to 127.0.0.1 and uses a new credential for each sharing session.</p></details>
      <details className="mcp-connection"><summary>Access history · {status?.access.length || 0}</summary>{status?.access.length ? <ul className="mcp-access">{status.access.map(event => <li key={event.id}><span>{event.operation} · {event.outcome.replace(/_/g, " ")}{event.operation !== "server" && ` · ${event.resultCount} results`}</span><time>{new Date(event.createdAt * 1000).toLocaleString()}</time></li>)}</ul> : <p>Access events will appear here. Query text and returned meeting content are not stored in this log.</p>}</details>
    </>}
  </section>;
}

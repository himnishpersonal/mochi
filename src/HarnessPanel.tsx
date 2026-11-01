import { useState } from "react";
import { Check, ChevronDown, WandSparkles } from "lucide-react";
import "./HarnessPanel.css";

export type FilingProposal = { title: string; folderName: string; rationale: string; confidence: number };
export type FollowUpProposal = { actions: { description: string; evidence: string }[] };
export type Proposal = FilingProposal | FollowUpProposal;
export type AgentRun = {
  id: string; noteId: string; recipe: string; recipeVersion: number;
  status: "queued" | "running" | "proposed" | "applied" | "failed" | "interrupted" | "cancelled" | "rejected";
  proposal: Proposal; appliedTools: string[]; error?: string | null; createdAt: number; updatedAt: number;
  revision: number; attempts: number; model: string; sourceHash: string;
  approval?: { approvedAt: number; sourceHash: string; proposal: Proposal } | null;
  steps: { id: string; name: string; status: string; attempt: number; detail: Record<string, unknown>; createdAt: number; updatedAt: number }[];
  events: { sequence: number; kind: string; detail: Record<string, unknown>; createdAt: number }[];
};
export type AgentRecipe = { id: string; name: string; description: string; version: number; tools: { name: string; requiresApproval: boolean; inputSchema: unknown }[]; outputSchema: unknown };
export const localRecipes: AgentRecipe[] = [
  { id: "librarian", name: "Suggest filing", description: "Review a title and folder.", version: 2, tools: [], outputSchema: {} },
  { id: "follow_ups", name: "Find follow-ups", description: "Review supported follow-ups before adding local actions.", version: 1, tools: [], outputSchema: {} },
];
const labels: Record<string, string> = { queued: "Ready to start", running: "Preparing preview", proposed: "Ready for review", applied: "Completed", failed: "Could not finish", interrupted: "Interrupted · progress saved", cancelled: "Cancelled", rejected: "Dismissed" };
export type ReviewAction = "save" | "approve" | "reject" | "cancel" | "resume";

export function HarnessPanel({ runs, busy, recording, onAction }: {
  runs: AgentRun[]; busy: boolean; recording: boolean;
  onAction: (run: AgentRun, action: ReviewAction, proposal?: Proposal) => Promise<void>;
}) {
  const pending = runs.filter(run => ["queued", "running", "proposed", "interrupted", "failed"].includes(run.status));
  const history = runs.filter(run => !pending.includes(run));
  if (!runs.length) return null;
  return <div className="harness-panel" aria-label="Meeting workflows">
    {pending.map(run => <RunCard key={`${run.id}:${run.revision}`} run={run} busy={busy} recording={recording} onAction={onAction} />)}
    {history.length > 0 && <details className="harness-history"><summary>Recent activity<ChevronDown size={13} /></summary>
      <ul>{history.map(run => <HistoryRow key={run.id} run={run}/>)}</ul>
    </details>}
  </div>;
}

function HistoryRow({ run }: { run: AgentRun }) {
  const name = run.recipe === "follow_ups" ? "Follow-ups" : "Filing suggestion";
  let outcome = `${name} ${labels[run.status]?.toLowerCase() || "finished"}`;
  if (run.status === "applied") {
    if (run.recipe === "follow_ups") {
      const receipt = run.steps.find(step => step.detail.result && typeof step.detail.result === "object")?.detail.result as { created?: unknown } | undefined;
      const count = typeof receipt?.created === "number" ? receipt.created : (run.approval?.proposal as FollowUpProposal | undefined)?.actions?.length;
      outcome = count === undefined ? "Follow-ups added" : count === 0 ? "Follow-ups already saved" : `${count} follow-up${count === 1 ? "" : "s"} added`;
    } else outcome = "Title and folder updated";
  }
  return <li>{run.status === "applied" ? <Check size={13}/> : <span className="activity-dot"/>}<span>{outcome}</span><time dateTime={new Date(run.updatedAt * 1000).toISOString()}>{new Date(run.updatedAt * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time></li>;
}

function RunCard({ run, busy, recording, onAction }: { run: AgentRun; busy: boolean; recording: boolean; onAction: (run: AgentRun, action: ReviewAction, proposal?: Proposal) => Promise<void> }) {
  const [draft, setDraft] = useState<Proposal>(run.proposal);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const name = run.recipe === "follow_ups" ? "Follow-ups" : "Filing suggestion";
  const pending = run.status === "proposed";
  const currentRecipeVersion = run.recipe === "librarian" ? 2 : 1;
  const legacy = run.recipeVersion < currentRecipeVersion;
  const disabled = busy || working;
  async function act(action: ReviewAction) {
    setWorking(true); setError("");
    try { await onAction(run, action, draft); }
    catch (cause) { setError(String(cause)); }
    finally { setWorking(false); }
  }
  return <section className="harness-run" aria-label={`${name}: ${labels[run.status] || run.status}`}>
    <header><span><WandSparkles size={14} />{name}</span><strong role="status">{labels[run.status] || run.status}</strong></header>
    {run.status === "running" && <p className="harness-running">Preparing a preview on your Mac. You can keep reading or cancel.</p>}
    {run.error && <p className="harness-error">{run.error}</p>}
    {legacy && pending && <p>This preview was created by an earlier version. Dismiss it and prepare a new suggestion.</p>}
    {pending && !legacy && (run.recipe === "librarian" ? <FilingEditor draft={draft as FilingProposal} setDraft={setDraft} disabled={disabled} /> : <FollowUpEditor draft={draft as FollowUpProposal} setDraft={setDraft} disabled={disabled} />)}
    {pending && !legacy && <p className="harness-scope">{run.recipe === "librarian" ? "Approval updates this note’s title and folder." : "Approval adds the selected follow-ups to this meeting’s local action list."}</p>}
    {pending && !legacy && <div className="harness-actions"><button disabled={disabled || recording} onClick={() => void act("approve")}><Check size={13} />{run.recipe === "follow_ups" ? "Add follow-ups" : "Apply suggestion"}</button><button className="secondary" disabled={disabled} onClick={() => void act("save")}>Save for later</button><button className="secondary" disabled={disabled} onClick={() => void act("reject")}>Dismiss</button></div>}
    {pending && legacy && <button className="secondary" disabled={disabled} onClick={() => void act("reject")}>Dismiss old preview</button>}
    {["queued", "failed", "interrupted"].includes(run.status) && <div className="harness-actions"><button disabled={disabled || recording || run.attempts >= 3 || legacy} onClick={() => void act("resume")}>{run.status === "queued" ? "Start" : "Try again"}</button><button className="secondary" disabled={disabled} onClick={() => void act("cancel")}>Dismiss</button>{run.attempts >= 3 && <small>Dismiss this suggestion and prepare a new one.</small>}</div>}
    {run.status === "running" && <button className="secondary" disabled={working} onClick={() => void act("cancel")}>Cancel</button>}
    {recording && pending && <p>Finish recording before applying changes to this meeting.</p>}
    {error && <p role="alert" className="harness-error">{error}</p>}
  </section>;
}

function FilingEditor({ draft, setDraft, disabled }: { draft: FilingProposal; setDraft: (p: Proposal) => void; disabled: boolean }) {
  function patch(patch: Partial<FilingProposal>) { setDraft({ ...draft, ...patch }); }
  return <fieldset disabled={disabled} className="harness-fields"><label>Suggested title<input value={draft.title} maxLength={120} onChange={e => patch({ title: e.target.value })} /></label>
    <label>Folder<input value={draft.folderName} maxLength={64} placeholder="Leave in current folder" onChange={e => patch({ folderName: e.target.value })} /><small>Choose an existing folder or enter a new one. Leave blank to keep the current folder.</small></label>
    <p>{draft.rationale}</p></fieldset>;
}

function FollowUpEditor({ draft, setDraft, disabled }: { draft: FollowUpProposal; setDraft: (p: Proposal) => void; disabled: boolean }) {
  return <fieldset disabled={disabled} className="harness-fields harness-followups">{draft.actions.length === 0 && <p>No follow-ups selected. You can save this preview or dismiss it.</p>}{draft.actions.map((action, index) => <div key={index}>
    <label>Follow-up {index + 1}<input maxLength={240} value={action.description} onChange={e => setDraft({ actions: draft.actions.map((item, i) => i === index ? { ...item, description: e.target.value } : item) })} /></label>
    <blockquote>{action.evidence}</blockquote><button className="secondary" onClick={() => setDraft({ actions: draft.actions.filter((_, i) => i !== index) })}>Remove follow-up {index + 1}</button>
  </div>)}</fieldset>;
}

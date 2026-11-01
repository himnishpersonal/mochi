import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HarnessPanel } from "./HarnessPanel";
import type { AgentRun } from "./HarnessPanel";

function run(patch: Partial<AgentRun> = {}): AgentRun {
  return { id: "run-1", noteId: "note-1", recipe: "librarian", recipeVersion: 2, status: "proposed",
    proposal: { title: "Launch review", folderName: "Product", rationale: "Alex discussed the launch.", confidence: 0.9 },
    appliedTools: [], createdAt: 100, updatedAt: 110, revision: 1, attempts: 1, model: "local", sourceHash: "source", steps: [], events: [], ...patch };
}

describe("Harness review", () => {
  it("keeps previews from the previous recipe version dismiss-only", () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(<HarnessPanel runs={[run({ recipeVersion: 1 })]} busy={false} recording={false} onAction={onAction} />);
    expect(screen.getByText(/earlier version/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply suggestion" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss old preview" })).toBeInTheDocument();
  });

  it("sends exactly the edited title and folder preview for approval", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(<HarnessPanel runs={[run()]} busy={false} recording={false} onAction={onAction} />);
    await user.clear(screen.getByLabelText("Suggested title"));
    await user.type(screen.getByLabelText("Suggested title"), "My reviewed title");
    await user.clear(screen.getByRole("textbox", { name: /^Folder/ }));
    await user.type(screen.getByRole("textbox", { name: /^Folder/ }), "Launch");
    await user.click(screen.getByRole("button", { name: "Apply suggestion" }));
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ revision: 1 }), "approve", expect.objectContaining({ title: "My reviewed title", folderName: "Launch" }));
  });

  it("lets users remove a follow-up before saving the preview", async () => {
    const user = userEvent.setup(); const onAction = vi.fn().mockResolvedValue(undefined);
    render(<HarnessPanel runs={[run({ recipe: "follow_ups", proposal: { actions: [{ description: "Send checklist", evidence: "Alex will send it." }, { description: "Review scope", evidence: "Review scope tomorrow." }] } })]} busy={false} recording={false} onAction={onAction} />);
    await user.click(screen.getByRole("button", { name: "Remove follow-up 1" }));
    await user.click(screen.getByRole("button", { name: "Save for later" }));
    expect(onAction).toHaveBeenCalledWith(expect.anything(), "save", { actions: [{ description: "Review scope", evidence: "Review scope tomorrow." }] });
  });

  it("allows cancellation while generation is busy and shows approval errors beside the preview", async () => {
    const user = userEvent.setup(); const onAction = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<HarnessPanel runs={[run({ status: "running", revision: 0, proposal: {} as AgentRun["proposal"] })]} busy recording={false} onAction={onAction} />);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onAction).toHaveBeenCalledWith(expect.anything(), "cancel", expect.anything());
    onAction.mockRejectedValue(new Error("This meeting changed since the preview was prepared."));
    rerender(<HarnessPanel runs={[run()]} busy={false} recording={false} onAction={onAction} />);
    await user.click(screen.getByRole("button", { name: "Apply suggestion" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("meeting changed");
  });

  it("blocks approval during recording and allows an interrupted run to resume", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<HarnessPanel runs={[run()]} busy={false} recording onAction={onAction} />);
    expect(screen.getByRole("button", { name: "Apply suggestion" })).toBeDisabled();
    rerender(<HarnessPanel runs={[run({ status: "interrupted", attempts: 2 })]} busy={false} recording={false} onAction={onAction} />);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onAction).toHaveBeenCalledWith(expect.anything(), "resume", expect.anything());
    rerender(<HarnessPanel runs={[run({ status: "failed", attempts: 3 })]} busy={false} recording={false} onAction={onAction} />);
    expect(screen.getByRole("button", { name: "Try again" })).toBeDisabled();
  });

  it("shows a plain outcome in history without exposing workflow internals", () => {
    render(<HarnessPanel runs={[run({ status: "applied", approval: { approvedAt: 110, sourceHash: "source", proposal: run().proposal } })]} busy={false} recording={false} onAction={vi.fn()} />);
    expect(screen.getByText("Recent activity")).toBeInTheDocument();
    expect(screen.getByText("Title and folder updated")).toBeInTheDocument();
    expect(screen.queryByText("Run details")).not.toBeInTheDocument();
    expect(screen.queryByText("run-1")).not.toBeInTheDocument();
    expect(screen.queryByText("Approved changes")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply suggestion" })).not.toBeInTheDocument();
  });
});

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { McpSettings, emptyMcpStatus } from "./McpSettings";
import type { McpStatus } from "./McpSettings";

function api(initial: McpStatus = structuredClone(emptyMcpStatus)) {
  let status = initial;
  const invoke = vi.fn(async (name: string, args?: Record<string, unknown>): Promise<unknown> => {
    if (name === "mcp_status") return status;
    if (name === "list_notes") return [{ id: "note-a", title: "Launch review" }, { id: "note-b", title: "Hiring" }];
    if (name === "list_projects") return [{ id: "project-a", name: "Product" }];
    if (name === "mcp_save_sharing") { status = { ...status, sharing: args?.sharing as McpStatus["sharing"] }; return status; }
    if (name === "mcp_start") { status = { ...status, running: true, endpoint: "http://127.0.0.1:17863/mcp", bridgeCommand: "'/Applications/MOCHI.app/Contents/MacOS/mochi' --mcp-stdio --endpoint 'http://127.0.0.1:17863/mcp' --session-id 'test-session'", sessionId: "test-session", startedAt: 1 }; return status; }
    if (name === "mcp_stop") { status = { ...status, running: false, endpoint: null, bridgeCommand: null, sharing: args?.revoke ? structuredClone(emptyMcpStatus.sharing) : status.sharing }; return status; }
    throw new Error("Unexpected command");
  });
  async function request<T>(name: string, args?: Record<string, unknown>): Promise<T> { return await invoke(name, args) as T; }
  return { invoke, request };
}

describe("MCP sharing settings", () => {
  it("starts only an explicit scope and leaves transcript and personal notes off", async () => {
    const service = api(); const user = userEvent.setup();
    render(<McpSettings request={service.request} desktop />);
    await screen.findByLabelText("Launch review");
    expect(screen.getByRole("button", { name: "Start MCP server" })).toBeDisabled();
    expect(screen.getByLabelText(/Include transcripts/)).not.toBeChecked();
    expect(screen.getByLabelText(/Include personal notes/)).not.toBeChecked();
    await user.click(screen.getByLabelText("Launch review"));
    await user.click(screen.getByRole("button", { name: "Start MCP server" }));
    await screen.findByText("Server running");
    expect(service.invoke).toHaveBeenCalledWith("mcp_save_sharing", { sharing: { noteIds: ["note-a"], projectIds: [], includeTranscript: false, includePersonalNotes: false, port: 17863 } });
    expect(service.invoke).toHaveBeenCalledWith("mcp_start", undefined);
    expect(screen.getByLabelText("Launch review")).toBeDisabled();
    expect(screen.getByText(/content retrieved by an AI client may be sent to its model provider/)).toBeInTheDocument();
  });

  it("saves a preview of sharing without starting a server", async () => {
    const service = api(); const user = userEvent.setup(); render(<McpSettings request={service.request} desktop />);
    await user.click(await screen.findByLabelText("Launch review"));
    await user.click(screen.getByLabelText(/Include transcripts/));
    await user.click(screen.getByRole("button", { name: "Save selection" }));
    await screen.findByText("Sharing selection saved. The server is still stopped.");
    expect(service.invoke).not.toHaveBeenCalledWith("mcp_start", undefined);
    expect(service.invoke).toHaveBeenCalledWith("mcp_save_sharing", expect.objectContaining({ sharing: expect.objectContaining({ includeTranscript: true, includePersonalNotes: false }) }));
  });

  it("offers stable local configurations without a session ID or credential", async () => {
    const initial = structuredClone(emptyMcpStatus);
    initial.executablePath = "/Applications/MOCHI.app/Contents/MacOS/mochi";
    const service = api(initial); const user = userEvent.setup();
    render(<McpSettings request={service.request} desktop />);
    await user.click(await screen.findByText("Connect to Claude or Codex locally"));
    expect((screen.getByLabelText("Claude Desktop configuration") as HTMLTextAreaElement).value).toContain('"--mcp-stdio"');
    expect((screen.getByLabelText("Codex configuration") as HTMLTextAreaElement).value).toContain('[mcp_servers.mochi]');
    expect((screen.getByLabelText("Codex configuration") as HTMLTextAreaElement).value).not.toContain("session-id");
    expect(service.invoke).not.toHaveBeenCalledWith("mcp_start", undefined);
  });

  it("revokes a running connection and clears its scope", async () => {
    const initial = structuredClone(emptyMcpStatus); initial.running = true; initial.sharing.noteIds = ["note-a"];
    initial.endpoint = "http://127.0.0.1:17863/mcp"; initial.bridgeCommand = "mochi --mcp-stdio";
    const service = api(initial); const user = userEvent.setup(); render(<McpSettings request={service.request} desktop />);
    await user.click(await screen.findByRole("button", { name: "Revoke access" }));
    await screen.findByText("Access revoked and sharing selection cleared.");
    expect(service.invoke).toHaveBeenCalledWith("mcp_stop", { revoke: true });
    expect(screen.getByLabelText("Launch review")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Start MCP server" })).toBeDisabled();
  });

  it("shows a failed start and keeps the scope available to fix", async () => {
    const service = api(); const user = userEvent.setup();
    const original = service.invoke.getMockImplementation()!;
    service.invoke.mockImplementation(async (name, args) => { if (name === "mcp_start") throw new Error("Port unavailable"); return original(name, args); });
    render(<McpSettings request={service.request} desktop />);
    await user.click(await screen.findByLabelText("Launch review"));
    await user.click(screen.getByRole("button", { name: "Start MCP server" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Port unavailable");
    await waitFor(() => expect(screen.getByRole("button", { name: "Start MCP server" })).toBeEnabled());
    expect(screen.getByLabelText("Launch review")).toBeChecked();
  });

  it("does not expose desktop MCP controls in browser preview", () => {
    const service = api(); render(<McpSettings request={service.request} desktop={false} />);
    expect(screen.getByText("Open the desktop app to configure MCP sharing.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start MCP server" })).not.toBeInTheDocument();
    expect(service.invoke).not.toHaveBeenCalled();
  });
});

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  emit: vi.fn(async () => undefined),
  invoke: vi.fn(async (name: string, _args?: Record<string, unknown>): Promise<string | undefined> => name === "answer_live" ? "Friday was agreed as the deadline." : undefined),
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: tauri.emit,
  listen: vi.fn(async (name: string, callback: (event: { payload: unknown }) => void) => {
    tauri.listeners.set(name, callback);
    return () => tauri.listeners.delete(name);
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));

import ShadowApp from "./ShadowApp";

const listeningState = {
  phase: "listening", noteId: "alpha", title: "Product sync", seconds: 12,
  source: "Microphone", levels: Array(14).fill(.5), whisperInstalled: true, liveTranscriptionAvailable: true,
  localAiRunning: true, endpoint: "http://127.0.0.1:8080/v1", model: "qwen3-4b",
  transcript: [{ startMs: 5000, endMs: 9000, text: "We should ship the prototype on Friday." }],
};

describe("Shadow MOCHI", () => {
  beforeEach(() => {
    tauri.listeners.clear(); tauri.emit.mockClear(); tauri.invoke.mockClear();
    tauri.invoke.mockImplementation(async (name: string) => name === "answer_live" ? "Friday was agreed as the deadline." : undefined);
  });

  it("cancels a pending local answer using its request ID", async () => {
    let rejectAnswer: (reason: string) => void = () => undefined;
    tauri.invoke.mockImplementation((name: string) => {
      if (name === "answer_live") return new Promise<string>((_resolve, reject) => { rejectAnswer = reject; });
      if (name === "cancel_local_ai_request") rejectAnswer("Local AI request cancelled.");
      return Promise.resolve(undefined);
    });
    render(<ShadowApp />);
    await waitFor(() => expect(tauri.listeners.has("shadow-state")).toBe(true));
    act(() => tauri.listeners.get("shadow-state")?.({ payload: listeningState }));
    await userEvent.click(screen.getByRole("button", { name: "Expand meeting panel" }));
    await userEvent.click(screen.getByRole("button", { name: "Ask MOCHI" }));
    fireEvent.change(screen.getByPlaceholderText("What did I miss?"), { target: { value: "What was decided?" } });
    await userEvent.click(screen.getByRole("button", { name: "Send question" }));
    expect(screen.getByText("Reading the conversation")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Local AI request cancelled.")).toBeInTheDocument();
    const call = tauri.invoke.mock.calls.find(([name]) => name === "answer_live");
    const args = call?.[1] as { request: { requestId: string } } | undefined;
    expect(args?.request.requestId).toBeTruthy();
    expect(tauri.invoke).toHaveBeenCalledWith("cancel_local_ai_request", { requestId: args?.request.requestId });
    expect(screen.getByRole("button", { name: "Send question" })).not.toBeDisabled();
  });

  it("shows synchronized recording state and a continuous live transcript", async () => {
    render(<ShadowApp />);
    await waitFor(() => expect(tauri.emit).toHaveBeenCalledWith("shadow-ready"));
    act(() => tauri.listeners.get("shadow-state")?.({ payload: listeningState }));
    expect(screen.getByText("Recording")).toBeInTheDocument();
    expect(screen.getByText("00:12")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Expand meeting panel" }));
    expect(tauri.invoke).toHaveBeenCalledWith("set_shadow_expanded", { expanded: true });
    expect(screen.getByText("We should ship the prototype on Friday.")).toBeInTheDocument();
    expect(screen.getByText("Live transcript")).toBeInTheDocument();
  });

  it("routes stop and moment controls back to the recording owner", async () => {
    render(<ShadowApp />);
    await waitFor(() => expect(tauri.listeners.has("shadow-state")).toBe(true));
    act(() => tauri.listeners.get("shadow-state")?.({ payload: listeningState }));
    await userEvent.click(screen.getByRole("button", { name: "Stop recording" }));
    expect(tauri.emit).toHaveBeenCalledWith("shadow-stop-request");
    await userEvent.click(screen.getByRole("button", { name: "Expand meeting panel" }));
    await userEvent.click(screen.getByRole("button", { name: "Moments" }));
    await userEvent.click(screen.getByRole("button", { name: /Decision/ }));
    expect(tauri.emit).toHaveBeenCalledWith("shadow-moment-request", { kind: "Decision" });
  });

  it("answers a live question using only the current local transcript", async () => {
    render(<ShadowApp />);
    await waitFor(() => expect(tauri.listeners.has("shadow-state")).toBe(true));
    act(() => tauri.listeners.get("shadow-state")?.({ payload: listeningState }));
    await userEvent.click(screen.getByRole("button", { name: "Expand meeting panel" }));
    await userEvent.click(screen.getByRole("button", { name: "Ask MOCHI" }));
    fireEvent.change(screen.getByPlaceholderText("What did I miss?"), { target: { value: "When is the deadline?" } });
    await userEvent.click(screen.getByRole("button", { name: "Send question" }));
    expect(await screen.findByText("Friday was agreed as the deadline.")).toBeInTheDocument();
    expect(tauri.invoke).toHaveBeenCalledWith("answer_live", expect.objectContaining({ request: expect.objectContaining({ question: "When is the deadline?" }) }));
  });
});

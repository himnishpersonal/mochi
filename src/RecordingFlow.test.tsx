import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  invoke: vi.fn<(name: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  emit: vi.fn(async () => undefined),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: native.emit,
  listen: async (name: string, callback: (event: { payload: unknown }) => void) => {
    native.listeners.set(name, callback);
    return () => { if (native.listeners.get(name) === callback) native.listeners.delete(name); };
  },
}));
import App from "./App";

const note = (id: string, title: string) => ({ id, title, kind: "meeting", transcript: "", userNotes: "", focusInstruction: "", summary: "", actionItems: [], durationSecs: 0, createdAt: 1, updatedAt: 1 });
const ready = { compiled: true, supported: true, permission: "granted", screenPermission: true, active: false, durationSecs: 0, fileBytes: 0, systemAudio: true, microphone: true, message: "Ready" };
let status = { ...ready };
let start: () => Promise<unknown>;
let stop: () => Promise<unknown>;

beforeEach(() => {
  localStorage.clear(); localStorage.setItem("mochi-onboarded", "yes");
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  native.listeners.clear(); native.emit.mockClear(); native.invoke.mockReset();
  status = { ...ready };
  start = async () => { status = { ...ready, active: true }; return status; };
  stop = async () => { status = { ...ready }; return { path: "/audio/saved.mp4", durationSecs: 2, fileBytes: 4096 }; };
  native.invoke.mockImplementation(async (name, args) => {
    if (name === "list_notes") return [note("alpha", "First meeting"), note("beta", "Other note")];
    if (name === "native_capture_status") return status;
    if (name === "start_native_capture") return start();
    if (name === "stop_native_capture") return stop();
    if (name === "transcription_model_status" || name === "local_ai_status") return { installed: false, running: false };
    if (name === "get_transcription_preference") return { noteId: args?.noteId, language: "auto", translate: false };
    if (name.startsWith("list_") || name === "drain_native_audio_chunks") return [];
    return undefined;
  });
});
afterEach(() => { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });

async function openMeeting() {
  render(<App/>);
  await userEvent.click((await screen.findAllByText("First meeting"))[0]);
  await userEvent.click(screen.getByRole("button", { name: "Record meeting" }));
}

it("automatically enhances after transcription using current written notes", async () => {
  const base = native.invoke.getMockImplementation()!;
  const original = { ...note("alpha", "First meeting"), audioPath: "/audio/test.mp4", userNotes: "My context" };
  native.invoke.mockImplementation(async (name, args) => {
    if (name === "list_notes") return [original];
    if (name === "transcription_model_status") return { installed: true };
    if (name === "local_ai_status") return { installed: true, running: true };
    if (name === "list_jobs") return [{ kind: "transcribe", status: "queued" }];
    if (name === "run_transcription_job") return { ...original, transcript: "The team chose Friday." };
    if (name === "generate_cited_notes") return { blocks: [{ id: "b", noteId: "alpha", section: "Summary", text: "The team chose Friday.", citationIds: [1], ordinal: 0 }], actions: [], chunksProcessed: 1 };
    return base(name, args);
  });
  render(<App/>);
  await waitFor(() => expect(native.invoke).toHaveBeenCalledWith("run_transcription_job", { noteId: "alpha" }));
  await waitFor(() => expect(native.invoke).toHaveBeenCalledWith("generate_cited_notes", expect.objectContaining({ request: expect.objectContaining({ noteId: "alpha", userNotes: "My context" }) })));
  expect(await screen.findByText(/Enhanced notes ready/)).toBeInTheDocument();
});

it("keeps previously enhanced notes when transcription finishes", async () => {
  const base = native.invoke.getMockImplementation()!;
  const original = { ...note("alpha", "First meeting"), audioPath: "/audio/test.mp4", summary: "My edited enhanced notes" };
  native.invoke.mockImplementation(async (name, args) => {
    if (name === "list_notes") return [original];
    if (name === "transcription_model_status") return { installed: true };
    if (name === "local_ai_status") return { installed: true, running: true };
    if (name === "list_jobs") return [{ kind: "transcribe", status: "queued" }];
    if (name === "run_transcription_job") return { ...original, transcript: "Updated transcript" };
    return base(name, args);
  });
  render(<App/>);
  expect(await screen.findByText(/existing enhanced notes were kept/)).toBeInTheDocument();
  expect(native.invoke.mock.calls.some(([name]) => name === "generate_cited_notes")).toBe(false);
});

it("recovers saved live chunks including a silent chunk and automatically enhances the transcript", async () => {
  const base = native.invoke.getMockImplementation()!;
  const recorded = { ...note("alpha", "Recovered meeting"), audioPath: "/audio/saved.mp4", userNotes: "My context" };
  const segment = { id: 17, noteId: "alpha", startMs: 6000, endMs: 9000, text: "The team chose Friday.", speaker: "Speaker 1", status: "draft", language: "en", source: "live", userEdited: false };
  let drained = false;
  native.invoke.mockImplementation(async (name, args) => {
    if (name === "list_notes") return [recorded];
    if (name === "transcription_model_status") return { installed: true };
    if (name === "local_ai_status") return { installed: true, running: true };
    if (name === "list_pending_native_audio_notes") return ["alpha"];
    if (name === "drain_native_audio_chunks") { if (drained) return []; drained = true; return [{ id: "audio-system-0.caf", offsetMs: 0, mimeType: "audio/x-caf", bytes: [0] }, { id: "audio-system-6000.caf", offsetMs: 6000, mimeType: "audio/x-caf", bytes: [1] }]; }
    if (name === "transcribe_live_chunk") return args?.offsetMs === 0 ? [] : [{ startMs: 6000, endMs: 9000, text: segment.text, language: "en" }];
    if (name === "save_live_segments") return (args?.segments as unknown[]).length ? [segment] : [];
    if (name === "list_transcript_segments") return [segment];
    if (name === "generate_cited_notes") return { blocks: [{ id: "b", noteId: "alpha", section: "Summary", text: segment.text, citationIds: [17], ordinal: 0 }], actions: [], chunksProcessed: 1 };
    return base(name, args);
  });
  render(<App/>);
  await waitFor(() => expect(native.invoke).toHaveBeenCalledWith("acknowledge_native_audio_chunk", { noteId: "alpha", chunkId: "audio-system-0.caf" }));
  await waitFor(() => expect(native.invoke).toHaveBeenCalledWith("acknowledge_native_audio_chunk", { noteId: "alpha", chunkId: "audio-system-6000.caf" }));
  await waitFor(() => expect(native.invoke).toHaveBeenCalledWith("generate_cited_notes", expect.objectContaining({ request: expect.objectContaining({ noteId: "alpha", userNotes: "My context" }) })));
  expect(native.invoke.mock.calls.some(([name]) => name === "run_transcription_job")).toBe(false);
});

it("does not trigger a permission request on Record and rechecks the enabled grant", async () => {
  status = { ...ready, permission: "required", screenPermission: false };
  await openMeeting();
  expect(await screen.findByLabelText("Meeting capture setup")).toBeInTheDocument();
  expect(native.invoke.mock.calls.some(([name]) => name === "request_native_capture_permission")).toBe(false);
  status = { ...ready };
  fireEvent.focus(window);
  await waitFor(() => expect(native.invoke.mock.calls.filter(([name]) => name === "native_capture_status").length).toBeGreaterThan(2));
  await userEvent.click(screen.getByRole("button", { name: "Check access again" }));
  await waitFor(() => expect(screen.queryByLabelText("Meeting capture setup")).not.toBeInTheDocument());
  expect(screen.getByRole("button", { name: "Record meeting" })).toBeEnabled();
  expect(native.invoke.mock.calls.some(([name]) => name === "request_native_capture_permission")).toBe(false);
});

it("enhances with the current editor snapshot before debounced autosave", async () => {
  const base = native.invoke.getMockImplementation()!;
  native.invoke.mockImplementation(async (name, args) => {
    if (name === "list_notes") return [{ ...note("alpha", "First meeting"), transcript: "A transcript fact.", userNotes: "Saved old wording" }];
    if (name === "local_ai_status") return { installed: true, running: true };
    if (name === "generate_cited_notes") return { blocks: [], actions: [], chunksProcessed: 1 };
    if (name === "update_note") return args?.note;
    return base(name, args);
  });
  render(<App/>);
  await userEvent.click((await screen.findAllByText("First meeting"))[0]);
  fireEvent.change(screen.getByLabelText("Personal notes"), { target: { value: "Newest correction: Himnish. Favorite color blue." } });
  fireEvent.click(screen.getByRole("button", { name: "Enhance" }));
  await waitFor(() => expect(native.invoke).toHaveBeenCalledWith("generate_cited_notes", expect.objectContaining({ request: expect.objectContaining({ noteId: "alpha", userNotes: "Newest correction: Himnish. Favorite color blue.", focusInstruction: "" }) })));
});

it("keeps newer typing when an earlier autosave finishes", async () => {
  const base = native.invoke.getMockImplementation()!;
  let finishFirst: ((value: unknown) => void) | undefined;
  let saves = 0;
  native.invoke.mockImplementation(async (name, args) => {
    if (name === "update_note") {
      saves += 1;
      if (saves === 1) return new Promise(resolve => { finishFirst = resolve; });
      return args?.note;
    }
    return base(name, args);
  });
  render(<App/>);
  await userEvent.click((await screen.findAllByText("First meeting"))[0]);
  const editor = screen.getByLabelText("Personal notes");
  fireEvent.change(editor, { target: { value: "First draft" } });
  await waitFor(() => expect(finishFirst).toBeDefined());
  fireEvent.change(editor, { target: { value: "Newer draft" } });
  await act(async () => { finishFirst?.(note("alpha", "First meeting")); });
  expect(editor).toHaveValue("Newer draft");
  await waitFor(() => expect(saves).toBe(2));
  expect(native.invoke).toHaveBeenCalledWith("update_note", expect.objectContaining({ editedFields: ["userNotes"], note: expect.objectContaining({ userNotes: "Newer draft" }) }));
});

it("keeps the timer stopped until native recording confirms startup and serializes Stop", async () => {
  let confirm: (value: unknown) => void = () => undefined;
  start = () => new Promise(resolve => { confirm = resolve; });
  await openMeeting();
  expect(screen.getByRole("button", { name: "Starting…" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Stop recording" })).not.toBeInTheDocument();
  expect(native.emit).not.toHaveBeenCalledWith("shadow-state", expect.objectContaining({ phase: "listening" }));
  await act(async () => { status = { ...ready, active: true }; confirm(status); });
  const stopButton = await screen.findByRole("button", { name: "Stop recording" });
  let finish: (value: unknown) => void = () => undefined;
  stop = () => new Promise(resolve => { finish = resolve; });
  fireEvent.click(stopButton); fireEvent.click(stopButton);
  expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
  expect(native.invoke.mock.calls.filter(([name]) => name === "stop_native_capture")).toHaveLength(1);
  await act(async () => { status = { ...ready }; finish({ path: "/audio/saved.mp4", durationSecs: 2, fileBytes: 4096 }); });
  expect(await screen.findByRole("button", { name: "Record meeting" })).toBeEnabled();
});

it("keeps refinement optional and reports a missing microphone after saving", async () => {
  const base = native.invoke.getMockImplementation()!;
  native.invoke.mockImplementation(async (name, args) => {
    if (name === "transcription_model_status") return { installed: true };
    if (name === "stop_native_capture") return { path: "/audio/saved.mp4", durationSecs: 2, fileBytes: 4096, warning: "Mac audio was saved, but the microphone delivered no audio." };
    return base(name, args);
  });
  await openMeeting();
  await userEvent.click(await screen.findByRole("button", { name: "Stop recording" }));
  expect(await screen.findByText("Recording saved with an audio source missing")).toBeInTheDocument();
  expect(native.invoke.mock.calls.some(([name]) => name === "run_transcription_job")).toBe(false);
});

it("reports startup failures without claiming a recording exists", async () => {
  start = async () => { throw new Error("macOS did not start writing the recording"); };
  await openMeeting();
  expect(await screen.findByRole("alert")).toHaveTextContent("Recording did not start");
  expect(screen.queryByRole("button", { name: "Stop recording" })).not.toBeInTheDocument();
  expect(native.emit).not.toHaveBeenCalledWith("shadow-state", expect.objectContaining({ phase: "listening" }));
  expect(screen.getByText("View details").closest("details")).not.toHaveAttribute("open");
});

it("detects an interrupted stream, stops the timer, and permits a new recording", async () => {
  await openMeeting();
  await screen.findByRole("button", { name: "Stop recording" });
  status = { ...ready, message: "Stream ended unexpectedly" };
  stop = async () => { throw new Error("No recording file was saved"); };
  expect(await screen.findByRole("alert", {}, { timeout: 2500 })).toHaveTextContent("Recording could not be saved");
  expect(await screen.findByRole("button", { name: "Record meeting" })).toBeEnabled();
  expect(native.emit).toHaveBeenCalledWith("shadow-state", expect.objectContaining({ phase: "error" }));
});

it("stops the original recording after navigating to a different note", async () => {
  await openMeeting();
  await screen.findByRole("button", { name: "Stop recording" });
  await userEvent.click((await screen.findAllByText("Other note"))[0]);
  await act(async () => { native.listeners.get("shadow-stop-request")?.({ payload: null }); });
  await waitFor(() => expect(native.invoke).toHaveBeenCalledWith("stop_native_capture", { noteId: "alpha" }));
  expect(native.emit).not.toHaveBeenCalledWith("shadow-state", expect.objectContaining({ noteId: "beta" }));
});

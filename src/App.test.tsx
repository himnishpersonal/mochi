import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import App from "./App";

describe("MOCHI local notebook", () => {
  beforeEach(() => { localStorage.clear(); localStorage.setItem("mochi-onboarded", "yes"); });

  it("keeps the notepad compact and leaves saved audio in the transcript disclosure", async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    localStorage.setItem("mochi-notes", JSON.stringify([
      { id: "recorded", title: "Saved meeting", kind: "meeting", transcript: "A saved conversation.", userNotes: "My notes", summary: "", actionItems: [], audioPath: "/local/meeting.mp4", durationSecs: 32, createdAt: timestamp, updatedAt: timestamp },
    ]));
    const user = userEvent.setup(); render(<App />);
    await user.click((await screen.findAllByText("Saved meeting"))[0]);
    expect(screen.queryByLabelText("Meeting recording")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Recording source" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Personal notes")).toHaveValue("My notes");
    expect(screen.getByRole("button", { name: "Record meeting" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Transcript/ }));
    expect(screen.getByLabelText("Meeting recording")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Recording options" }));
    expect(screen.getByRole("group", { name: "Recording source" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Recording options" }));
    expect(screen.queryByRole("group", { name: "Recording source" })).not.toBeInTheDocument();
    fireEvent.error(screen.getByLabelText("Meeting recording"));
    expect(screen.getByRole("alert")).toHaveTextContent("Could not play this recording");
    expect(screen.getByRole("button", { name: "Retry playback" })).toBeInTheDocument();
  });

  it("creates and autosaves a private meeting note", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText("Start your first conversation");
    await user.click(screen.getAllByRole("button", { name: "New note" })[0]);
    const title = screen.getByLabelText("Note title");
    const personalNotes = screen.getByLabelText("Personal notes");
    await user.click(screen.getByText("Enhancement options"));
    const focusInstruction = screen.getByLabelText("What should MOCHI look for?");

    await user.clear(title);
    await user.type(title, "Weekly product sync");
    await user.type(personalNotes, "Ship the private beta on Friday.");
    await user.type(focusInstruction, "Find the beta timeline");

    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem("mochi-notes") || "[]");
      expect(stored[0].title).toBe("Weekly product sync");
      expect(stored[0].userNotes).toContain("private beta");
      expect(stored[0].focusInstruction).toBe("Find the beta timeline");
    }, { timeout: 2000 });
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("toggles checklist tasks and persists them without changing nearby notes", async () => {
    localStorage.setItem("mochi-notes", JSON.stringify([
      { id: "tasks", title: "Checklist test", kind: "meeting", transcript: "", userNotes: "Context\n☐ Send checklist\n☑ Review notes", summary: "", actionItems: [], durationSecs: 0, createdAt: 1, updatedAt: 1 },
    ]));
    const user = userEvent.setup(); render(<App/>);
    await user.click((await screen.findAllByText("Checklist test"))[0]);
    const task = screen.getByRole("checkbox", { name: "Send checklist, line 2" });
    expect(task).not.toBeChecked();
    await user.click(task);
    expect(task).toBeChecked();
    expect(screen.getByLabelText("Personal notes")).toHaveValue("Context\n☑ Send checklist\n☑ Review notes");
    await waitFor(() => expect(JSON.parse(localStorage.getItem("mochi-notes") || "[]")[0].userNotes).toContain("☑ Send checklist"));
    task.focus(); await user.keyboard(" ");
    expect(task).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Review notes, line 3" })).toBeChecked();
  });

  it("offers an explicit way back from transcript to the unchanged notepad", async () => {
    localStorage.setItem("mochi-notes", JSON.stringify([
      { id: "close", title: "Transcript close test", kind: "meeting", transcript: "Conversation", userNotes: "Keep these notes", summary: "", actionItems: [], durationSecs: 0, createdAt: 1, updatedAt: 1 },
    ]));
    const user = userEvent.setup(); render(<App/>);
    await user.click((await screen.findAllByText("Transcript close test"))[0]);
    await user.click(screen.getByRole("button", { name: "Transcript · ready to review" }));
    await user.click(screen.getByRole("button", { name: "Close transcript" }));
    expect(screen.getByLabelText("Personal notes")).toHaveValue("Keep these notes");
  });

  it("opens a truly blank notepad and does not create an empty checklist marker", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("Start your first conversation");
    await user.click(screen.getAllByRole("button", { name: "New note" })[0]);

    const editor = screen.getByLabelText<HTMLTextAreaElement>("Personal notes");
    expect(editor).toHaveValue("");
    expect(screen.queryByText(/Notes\s+Decisions\s+Follow-ups/)).not.toBeInTheDocument();
    expect(screen.queryByText(/select one or more lines/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Checklist" }));
    expect(editor).toHaveValue("");
  });

  it("switches between personal and enhanced notes without moving or replacing the personal text", async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    localStorage.setItem("mochi-notes", JSON.stringify([
      { id: "alpha", title: "Planning", kind: "meeting", transcript: "We agreed to ship Friday.", userNotes: "My handwritten notes", summary: "", actionItems: [], durationSecs: 0, createdAt: timestamp, updatedAt: timestamp },
    ]));
    const user = userEvent.setup();
    render(<App />);
    await user.click((await screen.findAllByText("Planning"))[0]);

    expect(screen.getByLabelText("Personal notes")).toHaveValue("My handwritten notes");
    await user.click(screen.getByRole("button", { name: "Enhanced" }));
    expect(screen.queryByLabelText("Personal notes")).not.toBeInTheDocument();
    expect(screen.getByText("Enhance this conversation to see MOCHI’s notes here.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "My notes" }));
    expect(screen.getByLabelText("Personal notes")).toHaveValue("My handwritten notes");
  });

  it("searches transcript content without a server", async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    localStorage.setItem("mochi-notes", JSON.stringify([
      { id: "alpha", title: "Design review", kind: "meeting", transcript: "The launch date is October 4.", userNotes: "", summary: "", actionItems: [], durationSecs: 0, createdAt: timestamp, updatedAt: timestamp },
      { id: "beta", title: "Hiring", kind: "meeting", transcript: "Discussed interviews.", userNotes: "", summary: "", actionItems: [], durationSecs: 0, createdAt: timestamp, updatedAt: timestamp },
    ]));
    render(<App />);
    await screen.findAllByText("Design review");

    fireEvent.change(screen.getByLabelText("Search notes"), { target: { value: "October 4" } });
    await waitFor(() => expect(screen.queryByText("Hiring")).not.toBeInTheDocument());
    expect(screen.getAllByText("Design review").length).toBeGreaterThan(0);
  });

  it("opens settings with a localhost-only default", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("Start your first conversation");
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByDisplayValue("http://127.0.0.1:8080/v1")).toBeInTheDocument();
    expect(screen.getByText(/rejects model endpoints that are not on the loopback interface/)).toBeInTheDocument();
  });

  it("shows timestamped transcript segments and speaker controls", async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    localStorage.setItem("mochi-notes", JSON.stringify([
      { id: "alpha", title: "Planning", kind: "meeting", transcript: "Alex owns the checklist. It is due Friday.", userNotes: "", summary: "", actionItems: [], durationSecs: 0, createdAt: timestamp, updatedAt: timestamp },
    ]));
    const user = userEvent.setup();
    render(<App />);
    await user.click((await screen.findAllByText("Planning"))[0]);
    await user.click(screen.getByRole("button", { name: /^Transcript/ }));
    expect(await screen.findByText("Alex owns the checklist")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Speaker 1" }).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "00:00" })).toBeInTheDocument();
  });

  it("offers reusable templates and a functional action item view", async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    localStorage.setItem("mochi-notes", JSON.stringify([
      { id: "alpha", title: "Planning", kind: "meeting", transcript: "", userNotes: "", summary: "", actionItems: ["Send the checklist"], durationSecs: 0, createdAt: timestamp, updatedAt: timestamp },
    ]));
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText("Planning");
    await user.click(screen.getByText("More"));
    await user.click(screen.getByRole("button", { name: /Action items/ }));
    expect(await screen.findByDisplayValue("Send the checklist")).toBeInTheDocument();
    await user.click(screen.getByText("More"));
    await user.click(screen.getByRole("button", { name: "Recipes" }));
    expect(await screen.findByText("General meeting")).toBeInTheDocument();
    expect(screen.getByText("Sales call")).toBeInTheDocument();
  });

  it("uses plain product copy without decorative AI-template language", async () => {
    render(<App />);
    await screen.findByText("Start your first conversation");
    expect(screen.queryByText(/Turn conversation into clarity/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/remembered locally/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Private mode/i)).not.toBeInTheDocument();
  });

  it("keeps organization lightweight and preserves archive controls", async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    localStorage.setItem("mochi-notes", JSON.stringify([
      { id: "alpha", title: "Planning", kind: "meeting", transcript: "Alex reviewed launch timing.", userNotes: "", summary: "", actionItems: [], durationSecs: 0, createdAt: timestamp, updatedAt: timestamp },
    ]));
    const user = userEvent.setup();
    render(<App />);
    await user.click((await screen.findAllByText("Planning"))[0]);
    expect(screen.queryByLabelText("Tags")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("People")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "More note actions" }));
    await user.click(screen.getByRole("button", { name: "Archive note" }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem("mochi-organization") || "[]")[0].archived).toBe(true));
  });

  it("formats friendly notes without exposing markdown headings", async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    localStorage.setItem("mochi-notes", JSON.stringify([
      { id: "alpha", title: "Planning", kind: "meeting", transcript: "", userNotes: "## Notes\nFirst point", summary: "", actionItems: [], durationSecs: 0, createdAt: timestamp, updatedAt: timestamp },
    ]));
    const user = userEvent.setup(); render(<App />);
    await user.click((await screen.findAllByText("Planning"))[0]);
    const editor = await screen.findByLabelText<HTMLTextAreaElement>("Personal notes");
    expect(editor).toHaveValue("Notes\nFirst point");
    editor.setSelectionRange(6, 17);
    await user.click(screen.getByRole("button", { name: "Bulleted list" }));
    expect(editor).toHaveValue("Notes\n• First point");
  });

  it("opens the command palette and shows local notes", async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    localStorage.setItem("mochi-notes", JSON.stringify([
      { id: "alpha", title: "Product planning", kind: "meeting", transcript: "", userNotes: "", summary: "", actionItems: [], durationSecs: 0, createdAt: timestamp, updatedAt: timestamp },
    ]));
    render(<App />);
    await screen.findAllByText("Product planning");
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(await screen.findByLabelText("Search commands and notes")).toBeInTheDocument();
    expect(screen.getAllByText("Product planning").length).toBeGreaterThan(1);
  });

  it("shows structured moments beside the transcript", async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    localStorage.setItem("mochi-notes", JSON.stringify([
      { id: "alpha", title: "Launch review", kind: "meeting", transcript: "We decided to ship Friday.", userNotes: "", summary: "", actionItems: [], durationSecs: 10, createdAt: timestamp, updatedAt: timestamp },
    ]));
    localStorage.setItem("mochi-moments", JSON.stringify([
      { id: "moment-1", noteId: "alpha", kind: "Decision", label: "Ship Friday", timestampMs: 3000, createdAt: timestamp },
    ]));
    const user = userEvent.setup(); render(<App />);
    await user.click((await screen.findAllByText("Launch review"))[0]);
    await user.click(screen.getByRole("button", { name: /^Transcript/ }));
    expect(await screen.findByDisplayValue("Ship Friday")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "00:03" })).toBeInTheDocument();
  });

  it("creates a folder through the visible sidebar flow", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("Start your first conversation");

    await user.click(screen.getByRole("button", { name: "New folder" }));
    expect(screen.getByText("Give related notes a home")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Folder name"), "Product launch");
    await user.click(screen.getByRole("button", { name: "Create folder" }));

    await waitFor(() => {
      const projects = JSON.parse(localStorage.getItem("mochi-projects") || "[]");
      expect(projects).toHaveLength(1);
      expect(projects[0].name).toBe("Product launch");
    });
    expect(screen.getAllByText("Product launch").length).toBeGreaterThan(0);
    expect(screen.queryByText("Give related notes a home")).not.toBeInTheDocument();
  });

  it("keeps a draft transcript usable while refinement is running", async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    localStorage.setItem("mochi-notes", JSON.stringify([{ id: "alpha", title: "Live meeting", kind: "meeting", transcript: "[00:00] Draft words are already here.", userNotes: "", summary: "", actionItems: [], audioPath: "/local/alpha.webm", durationSecs: 48, createdAt: timestamp, updatedAt: timestamp }]));
    localStorage.setItem("mochi-jobs", JSON.stringify([{ id: "job-1", noteId: "alpha", kind: "transcribe", status: "running", error: null, progress: 46, stage: "Refining transcript", cancelRequested: false, createdAt: timestamp, updatedAt: timestamp }]));
    const user = userEvent.setup(); render(<App />);
    await user.click((await screen.findAllByText("Live meeting"))[0]);
    await user.click(screen.getByRole("button", { name: /^Transcript/ }));
    expect(await screen.findByText("Refining transcript")).toBeInTheDocument();
    expect(screen.getByText(/draft is saved and usable · 46%/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Draft words are already here/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("never silently falls back from remote meeting capture to the room microphone", async () => {
    const user = userEvent.setup(); render(<App />);
    await screen.findByText("Start your first conversation");
    await user.click(screen.getAllByRole("button", { name: "New note" })[0]);
    await user.click(screen.getByRole("button", { name: "Recording options" }));

    expect(screen.getByRole("button", { name: "Meeting — Mac audio and microphone" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("System-audio capture is not included in this build")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Record meeting" })[0]);
    expect(await screen.findByRole("heading", { name: "Hear both sides of the call" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "System build required" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Close meeting capture setup" }));
    await user.click(screen.getByRole("button", { name: "Room — microphone only" }));
    expect(screen.getAllByRole("button", { name: "Record room" })[0]).toBeInTheDocument();
    expect(screen.getByText(/Microphone only · Live transcript available/)).toBeInTheDocument();
  });

  it("collapses and restores the notes sidebar", async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    localStorage.setItem("mochi-notes", JSON.stringify([
      { id: "alpha", title: "Planning", kind: "meeting", transcript: "", userNotes: "", summary: "", actionItems: [], durationSecs: 0, createdAt: timestamp, updatedAt: timestamp },
    ]));
    const user = userEvent.setup(); render(<App />);
    await user.click((await screen.findAllByText("Planning"))[0]);

    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
    expect(localStorage.getItem("mochi-sidebar-collapsed")).toBe("yes");

    await user.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeInTheDocument();
  });
});

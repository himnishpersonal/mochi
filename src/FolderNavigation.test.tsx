import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it } from "vitest";
import App from "./App";

beforeEach(() => {
  localStorage.clear(); localStorage.setItem("mochi-onboarded", "yes");
  localStorage.setItem("mochi-projects", JSON.stringify([
    { id: "study", name: "Study", color: "#657A69", createdAt: 1 },
    { id: "work", name: "Work", color: "#B96B4E", createdAt: 1 },
  ]));
  localStorage.setItem("mochi-notes", JSON.stringify([
    { id: "biology", title: "Biology lecture", kind: "lecture", transcript: "", userNotes: "Cell division", summary: "", actionItems: [], durationSecs: 0, createdAt: 1, updatedAt: 1 },
    { id: "unfiled", title: "Unfiled conversation", kind: "meeting", transcript: "", userNotes: "", summary: "", actionItems: [], durationSecs: 0, createdAt: 1, updatedAt: 1 },
  ]));
  localStorage.setItem("mochi-organization", JSON.stringify([
    { noteId: "biology", projectId: "study", tags: [], people: [], archived: false, reviewed: true },
  ]));
});

it("shows the folder's notes in the main view and opens them", async () => {
  const user = userEvent.setup(); render(<App/>);
  await user.click(await screen.findByTitle("Study"));
  const main = within(screen.getByRole("main"));
  expect(main.getByRole("button", { name: /Biology lecture/ })).toBeInTheDocument();
  expect(main.queryByRole("button", { name: /Unfiled conversation/ })).not.toBeInTheDocument();
  await user.click(main.getByRole("button", { name: /Biology lecture/ }));
  expect(screen.getByLabelText("Personal notes")).toHaveValue("Cell division");
});

it("creates a note in the open folder and keeps it filed after reopening the app", async () => {
  const user = userEvent.setup(); render(<App/>);
  await user.click(await screen.findByTitle("Work"));
  expect(screen.getByText("No notes in Work yet")).toBeInTheDocument();
  await user.click(within(screen.getByRole("main")).getAllByRole("button", { name: "New note" })[0]);
  fireEvent.change(await screen.findByLabelText("Note title"), { target: { value: "Project review" } });
  await waitFor(() => {
    const notes = JSON.parse(localStorage.getItem("mochi-notes") || "[]");
    const created = notes.find((note: { title: string }) => note.title === "Project review");
    expect(created).toBeTruthy();
    const organization = JSON.parse(localStorage.getItem("mochi-organization") || "[]");
    expect(organization).toContainEqual(expect.objectContaining({ noteId: created.id, projectId: "work" }));
  });
  expect(screen.getByRole("button", { name: "Folder" })).toHaveTextContent("Work");
  cleanup(); render(<App/>);
  await user.click(await screen.findByTitle("Work"));
  expect(within(screen.getByRole("main")).getByRole("button", { name: /Project review/ })).toBeInTheDocument();
});

it("uses the current folder for ⌘N and stops inheriting it after returning to All notes", async () => {
  const user = userEvent.setup(); render(<App/>);
  await user.click(await screen.findByTitle("Study"));
  fireEvent.keyDown(window, { key: "n", metaKey: true });
  await screen.findByLabelText("Note title");
  const filed = JSON.parse(localStorage.getItem("mochi-notes") || "[]")[0];
  expect(JSON.parse(localStorage.getItem("mochi-organization") || "[]")).toContainEqual(expect.objectContaining({ noteId: filed.id, projectId: "study" }));
  await user.click(screen.getByTitle("All notes"));
  fireEvent.keyDown(window, { key: "n", metaKey: true });
  await screen.findByLabelText("Note title");
  const unfiled = JSON.parse(localStorage.getItem("mochi-notes") || "[]")[0];
  expect(unfiled.id).not.toBe(filed.id);
  expect(JSON.parse(localStorage.getItem("mochi-organization") || "[]")).toContainEqual(expect.objectContaining({ noteId: unfiled.id, projectId: null }));
});

it("clears a previous search when opening a folder", async () => {
  const user = userEvent.setup(); render(<App/>);
  await screen.findByTitle("Study");
  fireEvent.change(screen.getByLabelText("Search notes"), { target: { value: "Unfiled" } });
  await waitFor(() => expect(screen.queryByRole("button", { name: /Biology lecture/ })).not.toBeInTheDocument());
  await user.click(screen.getByTitle("Study"));
  expect(screen.getByLabelText("Search notes")).toHaveValue("");
  expect(await within(screen.getByRole("main")).findByRole("button", { name: /Biology lecture/ })).toBeInTheDocument();
});

import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import EnhancedNotes from "./EnhancedNotes";

const blocks = [
  { id: "a", noteId: "note", section: "Summary", text: "- Ship the beta Friday.", citationIds: [1], ordinal: 0 },
  { id: "b", noteId: "note", section: "Decisions", text: "## Keep the free tier.", citationIds: [2], ordinal: 1 },
  { id: "c", noteId: "note", section: "Summary", text: "Alex owns testing.", citationIds: [2], ordinal: 2 },
];
const segments = [{ id: 1, startMs: 0 }, { id: 2, startMs: 20_000 }];

it("labels handwritten evidence without inventing an audio timestamp and preserves it on edit", () => {
  const edit = vi.fn();
  const block = { ...blocks[0], text: "Favorite color is blue.", citationIds: [], noteSources: ["His favorite color is blue."] };
  render(<EnhancedNotes blocks={[block]} segments={segments} onCitation={vi.fn()} onEdit={edit}/>);
  expect(screen.getByText("Your notes")).toHaveAttribute("title", "His favorite color is blue.");
  expect(screen.queryByRole("button", { name: /Open transcript/ })).not.toBeInTheDocument();
  const text = screen.getByRole("textbox");
  text.textContent = "His favorite color: blue.";
  fireEvent.blur(text);
  expect(edit).toHaveBeenCalledWith({ ...block, text: "His favorite color: blue." });
});

it("groups real bullets under plain headings and keeps transcript sources reachable", async () => {
  const cite = vi.fn();
  const { container } = render(<EnhancedNotes blocks={blocks} segments={segments} onCitation={cite} onEdit={vi.fn()}/>);
  expect(screen.getAllByRole("heading", { name: "Summary" })).toHaveLength(1);
  expect(within(screen.getByRole("region", { name: "Summary" })).getAllByRole("listitem")).toHaveLength(2);
  expect(screen.getByText("Ship the beta Friday.")).toBeInTheDocument();
  expect(screen.getByText("Keep the free tier.")).toBeInTheDocument();
  expect(container.querySelector("textarea")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Open transcript at 00:00" }));
  expect(cite).toHaveBeenCalledWith(1);
});

it("saves edited bullets with their citations and restores empty or cancelled edits", () => {
  const edit = vi.fn();
  render(<EnhancedNotes blocks={blocks} segments={segments} onCitation={vi.fn()} onEdit={edit}/>);
  const text = screen.getByRole("textbox", { name: "Edit summary note 1" });
  text.textContent = "Ship the beta Monday.";
  fireEvent.blur(text);
  expect(edit).toHaveBeenCalledWith({ ...blocks[0], text: "Ship the beta Monday." });
  edit.mockClear();
  text.textContent = "";
  fireEvent.blur(text);
  expect(text).toHaveTextContent("Ship the beta Friday.");
  expect(edit).not.toHaveBeenCalled();
  text.textContent = "Uncommitted change";
  fireEvent.keyDown(text, { key: "Escape" });
  expect(text).toHaveTextContent("Ship the beta Friday.");
});

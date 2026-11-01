import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { RecordingControls, RecordingError } from "./RecordingControls";

it("identifies the selected source before recording and blocks duplicate transitions", async () => {
  const toggle = vi.fn();
  const { rerender } = render(<RecordingControls mode="meeting" recording={false} busy={null} seconds={0} toggle={toggle}/>);
  expect(screen.getByText("Mac + mic")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Record meeting" }));
  expect(toggle).toHaveBeenCalledTimes(1);
  rerender(<RecordingControls mode="meeting" recording={false} busy="starting" seconds={0} toggle={toggle}/>);
  await userEvent.click(screen.getByRole("button", { name: "Starting…" }));
  expect(toggle).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  rerender(<RecordingControls mode="meeting" recording busy={null} seconds={48} toggle={toggle}/>);
  expect(screen.getByRole("button", { name: "Stop recording" })).toHaveTextContent("Stop");
  expect(screen.getByRole("status")).toHaveAttribute("aria-label", "Recording 00:48");
  rerender(<RecordingControls mode="meeting" recording busy="stopping" seconds={48} toggle={toggle}/>);
  expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
  rerender(<RecordingControls mode="room" recording={false} busy={null} seconds={0} toggle={toggle}/>);
  expect(screen.getByText("Mic only")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Record room" })).toBeEnabled();
});

it("keeps technical paths and errors inside a collapsed disclosure", async () => {
  render(<RecordingError title="Recording could not be saved" detail="No recording file was saved. /local/audio/capture.partial.mp4"/>);
  expect(screen.getByRole("alert")).toHaveTextContent("Recording could not be saved");
  const disclosure = screen.getByText("View details").closest("details");
  expect(disclosure).not.toHaveAttribute("open");
  await userEvent.click(screen.getByText("View details"));
  expect(disclosure).toHaveAttribute("open");
});

import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import AudioPlayer from "./AudioPlayer";

afterEach(() => vi.restoreAllMocks());

it("plays, pauses, seeks, skips, and changes speed through compact controls", async () => {
  const audioRef = createRef<HTMLAudioElement>();
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async function(this: HTMLMediaElement) { fireEvent.play(this); });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function(this: HTMLMediaElement) { fireEvent.pause(this); });
  const ready = vi.fn();
  render(<AudioPlayer src="/local/meeting.m4a" durationSecs={38} audioRef={audioRef} onReady={ready} onError={vi.fn()}/>);
  const audio = audioRef.current!;
  expect(audio).not.toHaveAttribute("controls");
  Object.defineProperty(audio, "duration", { value: 36, configurable: true });
  fireEvent.loadedMetadata(audio);
  expect(ready).toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Play recording" }));
  expect(screen.getByRole("button", { name: "Pause recording" })).toBeInTheDocument();
  Object.defineProperty(audio, "paused", { value: false, configurable: true });
  await userEvent.click(screen.getByRole("button", { name: "Pause recording" }));
  expect(screen.getByRole("button", { name: "Play recording" })).toBeInTheDocument();
  fireEvent.change(screen.getByRole("slider"), { target: { value: "30" } });
  expect(audio.currentTime).toBe(30);
  await userEvent.click(screen.getByRole("button", { name: "Forward 15 seconds" }));
  expect(audio.currentTime).toBe(36);
  await userEvent.click(screen.getByRole("button", { name: "Back 15 seconds" }));
  expect(audio.currentTime).toBe(21);
  audio.currentTime = 4;
  fireEvent.timeUpdate(audio);
  expect(screen.getByRole("slider")).toHaveValue("4");
  await userEvent.click(screen.getByRole("button", { name: "Playback speed, 1×" }));
  expect(audio.playbackRate).toBe(1.25);
});

it("reports playback failures and keeps invalid media duration out of the controls", async () => {
  const error = vi.fn(); const audioRef = createRef<HTMLAudioElement>();
  vi.spyOn(HTMLMediaElement.prototype, "play").mockRejectedValue(new Error("Cannot decode"));
  render(<AudioPlayer src="/local/meeting.m4a" durationSecs={38} audioRef={audioRef} onReady={vi.fn()} onError={error}/>);
  Object.defineProperty(audioRef.current, "duration", { value: Infinity });
  fireEvent.loadedMetadata(audioRef.current!);
  expect(screen.getByRole("slider")).toHaveAttribute("max", "38");
  await userEvent.click(screen.getByRole("button", { name: "Play recording" }));
  expect(error).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Play recording" })).toBeInTheDocument();
});

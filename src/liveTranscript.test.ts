import { describe, expect, it, vi } from "vitest";
import { persistLiveChunk, type LiveSegment } from "./liveTranscript";

describe("live transcript persistence", () => {
  it("retries earlier evidence after a failed write without sending the entire meeting again", async () => {
    const pending: LiveSegment[] = [];
    const first = { startMs: 0, endMs: 5000, text: "Opening decision" };
    const second = { startMs: 6000, endMs: 11000, text: "Next commitment" };
    const save = vi.fn<(batch: LiveSegment[]) => Promise<string>>()
      .mockRejectedValueOnce(new Error("Temporary database failure"))
      .mockResolvedValue("saved");
    await expect(persistLiveChunk(pending, [first], save)).rejects.toThrow("Temporary database failure");
    expect(pending).toEqual([first]);
    await expect(persistLiveChunk(pending, [second], save)).resolves.toBe("saved");
    expect(save.mock.calls[1][0]).toEqual([first, second]);
    expect(pending).toEqual([]);
    await persistLiveChunk(pending, [second], save);
    expect(save.mock.calls[2][0]).toEqual([second]);
  });
});

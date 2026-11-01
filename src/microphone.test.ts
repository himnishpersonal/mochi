import { afterEach, expect, it, vi } from "vitest";
import { openMicrophone } from "./microphone";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("ends a stalled microphone request and releases a late stream", async () => {
  vi.useFakeTimers();
  let grant: (stream: MediaStream) => void = () => undefined;
  const getUserMedia = vi.fn(() => new Promise<MediaStream>(resolve => { grant = resolve; }));
  const original = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  try {
    const request = openMicrophone(100);
    const rejected = expect(request).rejects.toThrow("Microphone access was not confirmed");
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    const stop = vi.fn();
    grant({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await Promise.resolve();
    expect(stop).toHaveBeenCalledTimes(1);
  } finally {
    if (original) Object.defineProperty(navigator, "mediaDevices", original);
    else Reflect.deleteProperty(navigator, "mediaDevices");
  }
});

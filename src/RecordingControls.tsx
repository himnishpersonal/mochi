import { CircleStop, Mic, Volume2 } from "lucide-react";

type Props = {
  mode: "meeting" | "room";
  recording: boolean;
  busy: "starting" | "stopping" | null;
  seconds: number;
  toggle: () => void;
  showOverlay?: () => void;
};

export function RecordingControls({ mode, recording, busy, seconds, toggle, showOverlay }: Props) {
  const source = mode === "meeting" ? "Mac + mic" : "Mic only";
  const modeLabel = mode === "meeting" ? "Meeting" : "Room";
  const duration = `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
  const label = busy === "starting" ? "Starting…" : busy === "stopping" ? "Saving…" : recording ? "Stop" : `Record ${modeLabel.toLowerCase()}`;
  return <div className="recording-controls" aria-label="Recording controls">
    <span className="recording-source" title={`${modeLabel} recording: ${source}`}>{source}</span>
    <button className={`record-button top-record-button ${recording && !busy ? "recording" : ""}`}
      disabled={busy !== null} aria-label={busy ? label : recording ? "Stop recording" : label} onClick={toggle}>
      {recording ? <CircleStop size={15}/> : mode === "meeting" ? <Volume2 size={15}/> : <Mic size={15}/>}
      <span>{label}</span>
    </button>
    {recording && <span className="record-timer" role="status" aria-label={`${busy ? "Saving recording" : "Recording"} ${duration}`}><i/>{duration}</span>}
    {(recording || busy) && showOverlay && <button className="overlay-button" title="Show MOCHI overlay · ⌘\\" onClick={showOverlay}>Overlay</button>}
  </div>;
}

export function RecordingError({ title, detail }: { title: string; detail: string }) {
  return <div className="recording-error" role="alert">
    <strong>{title}</strong>
    <details><summary>View details</summary><p>{detail}</p></details>
  </div>;
}

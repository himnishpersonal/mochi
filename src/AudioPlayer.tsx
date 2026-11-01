import { useRef, useState } from "react";
import type { RefObject } from "react";
import { Pause, Play, RotateCcw, RotateCw } from "lucide-react";

function clock(seconds: number) {
  const safe = Math.max(0, Number.isFinite(seconds) ? Math.floor(seconds) : 0);
  return `${Math.floor(safe / 60).toString().padStart(2, "0")}:${(safe % 60).toString().padStart(2, "0")}`;
}

export default function AudioPlayer({ src, durationSecs, audioRef, onReady, onError }: {
  src?: string; durationSecs: number; audioRef: RefObject<HTMLAudioElement | null>; onReady: () => void; onError: () => void;
}) {
  const media = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(durationSecs);
  const [rate, setRate] = useState(1);
  const end = Number.isFinite(duration) && duration > 0 ? duration : Math.max(0, durationSecs);
  const updateDuration = () => {
    const value = media.current?.duration;
    if (value && Number.isFinite(value)) setDuration(value);
  };
  async function toggle() {
    if (!media.current) return;
    if (!media.current.paused) { media.current.pause(); return; }
    try { await media.current.play(); }
    catch { setPlaying(false); onError(); }
  }
  function seek(seconds: number) {
    if (!media.current) return;
    const next = Math.min(end, Math.max(0, seconds));
    try { media.current.currentTime = next; setPosition(next); }
    catch { onError(); }
  }
  function changeRate() {
    const speeds = [1, 1.25, 1.5, 2];
    const next = speeds[(speeds.indexOf(rate) + 1) % speeds.length];
    if (media.current) media.current.playbackRate = next;
    setRate(next);
  }
  return <div className="mochi-audio" role="group" aria-label="Recording playback">
    <audio ref={element => { media.current = element; audioRef.current = element; }} aria-label="Meeting recording" preload="metadata" src={src}
      onLoadedMetadata={() => { updateDuration(); onReady(); }} onDurationChange={updateDuration}
      onTimeUpdate={() => setPosition(media.current?.currentTime || 0)} onSeeked={() => setPosition(media.current?.currentTime || 0)}
      onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
      onError={() => { setPlaying(false); onError(); }}/>
    <button type="button" className="audio-play" onClick={() => void toggle()} aria-label={playing ? "Pause recording" : "Play recording"}>{playing ? <Pause size={15}/> : <Play size={15}/>}</button>
    <button type="button" className="audio-skip" onClick={() => seek(position - 15)} aria-label="Back 15 seconds"><RotateCcw size={14}/></button>
    <time>{clock(position)}</time>
    <input type="range" aria-label="Playback position" aria-valuetext={`${clock(position)} of ${clock(end)}`} min={0} max={end || 1} step={0.1} value={Math.min(position, end)} disabled={!end} onChange={event => seek(Number(event.target.value))}/>
    <time>{clock(end)}</time>
    <button type="button" className="audio-skip" onClick={() => seek(position + 15)} aria-label="Forward 15 seconds"><RotateCw size={14}/></button>
    <button type="button" className="audio-speed" onClick={changeRate} aria-label={`Playback speed, ${rate}×`} title="Change playback speed">{rate}×</button>
  </div>;
}

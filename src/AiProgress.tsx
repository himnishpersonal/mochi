import { useEffect, useState } from "react";
import "./AiProgress.css";

export default function AiProgress({ label, stage, completed, total, cancel }: {
  label: string; stage?: string; completed?: number; total?: number; cancel: () => void | Promise<void>;
}) {
  const [seconds, setSeconds] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  useEffect(() => {
    const started = Date.now();
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <div className="ai-task-progress">
    <div><strong role="status">{cancelling ? "Cancelling…" : stage || label}</strong><span aria-live="off">{seconds}s elapsed · Processing on this Mac</span></div>
    <button type="button" disabled={cancelling} onClick={async () => { setCancelling(true); try { await cancel(); } finally { setCancelling(false); } }}>Cancel</button>
    {total != null && total > 0 && <progress aria-label={label} max={total} value={completed || 0}/>}
  </div>;
}

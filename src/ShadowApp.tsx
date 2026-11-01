import { FormEvent, PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import AiProgress from "./AiProgress";
import {
  Bookmark, Check, ChevronDown, ChevronUp, CircleStop, ExternalLink,
  Flag, ListTodo, MessageCircle, Mic2, Send, Sparkles, X
} from "lucide-react";
import "./ShadowApp.css";

type LiveSegment = { startMs: number; endMs: number; text: string; noSpeechProbability?: number };
type ShadowPhase = "idle" | "starting" | "listening" | "finalizing" | "ready" | "error";
type ShadowState = {
  phase: ShadowPhase;
  noteId: string | null;
  title: string;
  seconds: number;
  source: string;
  levels: number[];
  transcript: LiveSegment[];
  whisperInstalled: boolean;
  liveTranscriptionAvailable: boolean;
  localAiRunning: boolean;
  endpoint: string;
  model: string;
  message?: string | null;
};

const initialState: ShadowState = {
  phase: "idle", noteId: null, title: "Meeting", seconds: 0, source: "Microphone",
  levels: Array(14).fill(0.06), transcript: [], whisperInstalled: false, liveTranscriptionAvailable: false,
  localAiRunning: false, endpoint: "http://127.0.0.1:8080/v1", model: "qwen3-4b",
};

async function windowCommand(name: string, args?: Record<string, unknown>) {
  try { await invoke(name, args); } catch { /* Browser preview has no native window. */ }
}

function formatDuration(seconds: number) {
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

function formatTime(milliseconds: number) {
  return formatDuration(Math.max(0, Math.floor(milliseconds / 1000)));
}

export default function ShadowApp() {
  const [session, setSession] = useState<ShadowState>(initialState);
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<"transcript" | "ask" | "moments">("transcript");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [asking, setAsking] = useState(false);
  const activeRequest = useRef<string | null>(null);
  const cancelledRequests = useRef(new Set<string>());
  const transcriptEnd = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    const applyAppearance = (appearance: string) => {
      document.documentElement.dataset.theme = appearance;
      document.documentElement.style.colorScheme = appearance === "system" ? "light dark" : appearance;
    };
    applyAppearance(localStorage.getItem("mochi-appearance") || "system");
    let appearanceUnlisten: (() => void) | undefined;
    void listen<{ appearance: string }>("appearance-changed", event => applyAppearance(event.payload.appearance)).then(stop => { if (disposed) stop(); else appearanceUnlisten = stop; });
    void listen<ShadowState>("shadow-state", event => setSession(event.payload)).then(stop => {
      if (disposed) { stop(); return; }
      unlisten = stop;
      void emit("shadow-ready");
    });
    return () => { disposed = true; unlisten?.(); appearanceUnlisten?.(); };
  }, []);

  useEffect(() => {
    if (tab === "transcript") transcriptEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [session.transcript, tab]);

  useEffect(() => {
    if (session.phase !== "listening" || session.seconds > 1 || !expanded) return;
    setExpanded(false); setTab("transcript"); setAnswer(""); setQuestion("");
    void windowCommand("set_shadow_expanded", { expanded: false });
  }, [session.phase, session.seconds, expanded]);

  const phaseLabel = useMemo(() => {
    if (session.phase === "starting") return "Starting…";
    if (session.phase === "listening") return "Recording";
    if (session.phase === "finalizing") return "Saving…";
    if (session.phase === "ready") return "Saved";
    if (session.phase === "error") return "Recording error";
    return "Ready";
  }, [session.phase]);

  async function toggleExpanded() {
    const next = !expanded;
    await windowCommand("set_shadow_expanded", { expanded: next });
    setExpanded(next);
  }

  function beginDrag(event: PointerEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest("button,input,form")) return;
    void windowCommand("start_shadow_drag");
  }

  async function closeOverlay() {
    setExpanded(false);
    await windowCommand("set_shadow_expanded", { expanded: false });
    await emit("shadow-close-request");
  }

  async function ask(event: FormEvent) {
    event.preventDefault();
    if (!question.trim() || !session.transcript.length || !session.localAiRunning || activeRequest.current) return;
    const requestId = crypto.randomUUID(); activeRequest.current = requestId;
    setAsking(true); setAnswer("");
    try {
      const transcript = session.transcript.map(item => `[${formatTime(item.startMs)}] ${item.text}`).join("\n");
      const response = await invoke<string>("answer_live", { request: { requestId, endpoint: session.endpoint, model: session.model, transcript, question } });
      if (!cancelledRequests.current.has(requestId)) setAnswer(response);
    } catch (error) { setAnswer(String(error)); }
    finally { cancelledRequests.current.delete(requestId); activeRequest.current = null; setAsking(false); }
  }

  async function cancelAnswer() {
    const requestId = activeRequest.current; if (!requestId) return;
    cancelledRequests.current.add(requestId);
    try { await invoke("cancel_local_ai_request", { requestId }); }
    catch (error) { setAnswer(`Could not cancel: ${error}`); }
  }

  return <div className={`shadow-stage ${expanded ? "expanded" : "compact"}`}>
    <section className={`shadow-card phase-${session.phase}`} aria-label="Shadow MOCHI meeting controls">
      <header className="shadow-bar" onPointerDown={beginDrag}>
        <div className="shadow-status">
          <span className="shadow-mochi"><i /></span>
          <span className="status-copy" role="status"><strong>{phaseLabel}</strong><small title={session.title}>{session.source === "Mac + microphone" ? "Mac + mic" : "Mic only"}</small></span>
        </div>
        <div className="shadow-wave" aria-label="Live audio level">
          {(session.levels.length ? session.levels : initialState.levels).slice(0, 14).map((level, index) =>
            <i key={index} style={{ height: `${Math.max(3, Math.min(22, 3 + level * 21))}px` }} />)}
        </div>
        <time>{formatDuration(session.seconds)}</time>
        {session.phase === "listening" || session.phase === "finalizing" || session.phase === "starting" ?
          <button className="stop-session" disabled={session.phase !== "listening"} onClick={() => emit("shadow-stop-request")} aria-label="Stop recording"><CircleStop size={16}/></button> :
          <button className="open-note" onClick={() => emit("shadow-open-main-request")} aria-label="Open note"><ExternalLink size={15}/></button>}
        <button className="expand-session" onClick={toggleExpanded} aria-label={expanded ? "Collapse meeting panel" : "Expand meeting panel"}>{expanded ? <ChevronUp size={16}/> : <ChevronDown size={16}/>}</button>
        <button className="close-shadow" onClick={closeOverlay} aria-label="Hide meeting overlay"><X size={15}/></button>
      </header>

      {expanded && <div className="shadow-panel">
        <div className="session-meta"><span><Mic2 size={12}/>{session.source}</span><span>Private on this Mac</span></div>
        <nav className="shadow-tabs" aria-label="Meeting tools">
          <button className={tab === "transcript" ? "active" : ""} onClick={() => setTab("transcript")}>Transcript</button>
          <button className={tab === "ask" ? "active" : ""} onClick={() => setTab("ask")}>Ask MOCHI</button>
          <button className={tab === "moments" ? "active" : ""} onClick={() => setTab("moments")}>Moments</button>
        </nav>

        {tab === "transcript" && <div className="live-transcript">
          <div className="panel-caption"><span>{session.phase === "listening" ? "Live transcript" : session.phase === "finalizing" ? "Refining uncertain moments" : "Meeting transcript"}</span>{session.phase === "listening" && <i>Live</i>}</div>
          {session.transcript.length ? session.transcript.slice(-80).map((segment, index) => <article key={`${segment.startMs}-${index}`}>
            <time>{formatTime(segment.startMs)}</time><p>{segment.text}</p>
          </article>) : <div className="shadow-empty">
            <MessageCircle size={18}/><strong>{session.liveTranscriptionAvailable ? "Listening for speech" : session.whisperInstalled ? "Transcript follows after Stop" : "Live transcript is off"}</strong>
            <p>{session.message || (session.liveTranscriptionAvailable ? "Words will appear after each short speech chunk." : session.whisperInstalled ? "Live transcription is unavailable for this session." : "Install Whisper in MOCHI Settings to transcribe locally.")}</p>
          </div>}
          <div ref={transcriptEnd}/>
        </div>}

        {tab === "ask" && <div className="shadow-ask">
          <div className="panel-caption"><span>Conversation assistant</span><i>Local Qwen</i></div>
          {asking ? <AiProgress label="Reading the conversation" cancel={cancelAnswer}/> : answer ? <div className="live-answer"><Sparkles size={14}/><p>{answer}</p></div> : <div className="shadow-empty compact-empty"><strong>Ask about what has been said</strong><p>MOCHI answers only from the provisional transcript.</p></div>}
          <form onSubmit={ask}>
            <input value={question} onChange={event => setQuestion(event.target.value)} placeholder={session.localAiRunning ? "What did I miss?" : "Start Qwen from Settings"} disabled={!session.localAiRunning}/>
            <button disabled={asking || !question.trim() || !session.transcript.length || !session.localAiRunning} aria-label="Send question"><Send size={14}/></button>
          </form>
        </div>}

        {tab === "moments" && <div className="shadow-moments">
          <div className="panel-caption"><span>Mark this moment</span><i>{formatDuration(session.seconds)}</i></div>
          <p>Place a timestamped marker without interrupting the conversation.</p>
          <div>
            <button title="Mark a decision at this timestamp" onClick={() => emit("shadow-moment-request", { kind: "Decision" })}><Flag size={15}/><span><strong>Decision</strong><small>A choice was made</small></span></button>
            <button title="Mark an action at this timestamp" onClick={() => emit("shadow-moment-request", { kind: "Action" })}><ListTodo size={15}/><span><strong>Action</strong><small>Something to follow up</small></span></button>
            <button title="Bookmark this timestamp" onClick={() => emit("shadow-moment-request", { kind: "Bookmark" })}><Bookmark size={15}/><span><strong>Bookmark</strong><small>Return here later</small></span></button>
          </div>
        </div>}

        {session.message && <div className="shadow-message"><Check size={13}/>{session.message}</div>}
      </div>}
    </section>
  </div>;
}

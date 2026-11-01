import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Archive as ArchiveIcon, ArchiveRestore, Bookmark, Check, ChevronDown, Flag,
  Download, FileText, Folder, Heading2, Home, Inbox, List, ListOrdered, MonitorUp,
  ListTodo, MessageCircle, Mic, MoreHorizontal, Pencil, Plus, Search, Settings, SquareCheckBig,
  PanelLeftClose, PanelLeftOpen, Trash2, Upload, WandSparkles, X
} from "lucide-react";
import "./App.css";
import { McpSettings } from "./McpSettings";
import { HarnessPanel, localRecipes } from "./HarnessPanel";
import type { AgentRun, AgentRecipe, Proposal, ReviewAction } from "./HarnessPanel";
import AiProgress from "./AiProgress";
import { RecordingControls, RecordingError } from "./RecordingControls";
import { openMicrophone } from "./microphone";
import AudioPlayer from "./AudioPlayer";
import EnhancedNotes from "./EnhancedNotes";
import { persistLiveChunk, type LiveSegment } from "./liveTranscript";

type Note = {
  id: string; title: string; kind: string; transcript: string; userNotes: string; focusInstruction: string;
  summary: string; actionItems: string[]; audioPath?: string | null; durationSecs: number;
  createdAt: number; updatedAt: number;
};
type Segment = { id: number; noteId: string; startMs: number; endMs: number; text: string; speaker: string; overlap: boolean; speakerConfidence: number; status?: "draft" | "refining" | "final"; confidence?: number; language?: string; source?: string; userEdited?: boolean };
type Block = { id: string; noteId: string; section: string; text: string; citationIds: number[]; noteSources?: string[]; ordinal: number };
type ActionItem = { id: string; noteId: string; noteTitle: string; description: string; assignee?: string | null; dueDate?: string | null; status: string; citationIds: number[]; confidence: number; userEdited: boolean };
type Template = { id: string; name: string; noteStructure: string; summaryPrompt: string; isDefault: boolean };
type SearchHit = { noteId: string; noteTitle: string; segmentId?: number | null; startMs?: number | null; speaker?: string | null; excerpt: string; kind: string };
type ChatAnswer = { answer: string; sources: SearchHit[] };
type GeneratedNotes = { blocks: Block[]; actions: ActionItem[]; chunksProcessed: number };
type ModelStatus = { installed: boolean; path: string; sizeBytes: number; displayName: string };
type ModelDownloadProgress = { downloadedBytes: number; totalBytes: number; percent: number };
type GenerationProgress = { completed: number; total: number; stage: string };
type LocalAiStatus = { installed: boolean; running: boolean; modelPath: string; runtimePath: string; modelSizeBytes: number; displayName: string };
type AiDownloadProgress = { component: string; downloadedBytes: number; totalBytes: number; percent: number };
type TranscriptionJob = { id: string; noteId: string; kind: string; status: string; error?: string | null; progress: number; stage: string; cancelRequested: boolean; createdAt: number; updatedAt: number };
type TranscriptionProgress = { noteId: string; progress: number; stage: string; status: string };
type TranscriptionPreference = { noteId: string; language: string; translate: boolean };
type CaptureMode = "meeting" | "room";
type NativeCaptureStatus = { compiled: boolean; supported: boolean; permission: "granted" | "required" | "microphone_required" | "unavailable" | string; screenPermission: boolean; active: boolean; noteId?: string | null; durationSecs: number; fileBytes: number; systemAudio: boolean; systemAudioLevel?: number; microphone: boolean; message: string };
type NativeAudioChunk = { id: string; offsetMs: number; source: string; mimeType: string; bytes: number[] };
type InterruptedCapture = { id: string; noteId: string; noteTitle: string; path: string; startedAt: number; fileBytes: number; error?: string | null };
type ShadowPhase = "idle" | "starting" | "listening" | "finalizing" | "ready" | "error";
type Project = { id: string; name: string; color: string; createdAt: number };
type NoteOrganization = { noteId: string; projectId?: string | null; tags: string[]; people: string[]; archived: boolean; reviewed: boolean };
type Moment = { id: string; noteId: string; kind: "Decision" | "Action" | "Bookmark"; label: string; timestampMs: number; createdAt: number };
type AiTask = { requestId: string; kind: "brief" | "filing" | "answer"; noteId?: string };
type View = "library" | "inbox" | "meetings" | "actions" | "people" | "tags" | "archive" | "project" | "ask" | "templates";

const builtInTemplates: Template[] = [
  { id: "meeting", name: "General meeting", noteStructure: "Notes\n\nDecisions\n\nFollow-ups\n\n☐ ", summaryPrompt: "Summarize key points, decisions, and explicit commitments.", isDefault: true },
  { id: "oneOnOne", name: "1:1", noteStructure: "Check-in\n\nWins\n\nChallenges\n\nCommitments\n\n☐ ", summaryPrompt: "Focus on feedback, support, and mutual commitments.", isDefault: true },
  { id: "standup", name: "Stand-up", noteStructure: "Done\n\nNext\n\nBlockers", summaryPrompt: "Focus on progress, next work, and blockers.", isDefault: true },
  { id: "interview", name: "Interview", noteStructure: "Evidence\n\nStrengths\n\nConcerns\n\nNext step", summaryPrompt: "Summarize evidence without making a hiring decision.", isDefault: true },
  { id: "lecture", name: "Lecture", noteStructure: "Main ideas\n\nDefinitions\n\nQuestions", summaryPrompt: "Explain concepts, definitions, and examples.", isDefault: true },
  { id: "customer", name: "Sales call", noteStructure: "Context\n\nNeeds\n\nObjections\n\nFollow-up\n\n☐ ", summaryPrompt: "Focus on customer needs, objections, and commitments.", isDefault: true },
];

const friendlyNoteText = (value: string) => value.replace(/^\s*#{1,6}\s+/gm, "").replace(/^Summary\|Key points\|Decisions$/gm, "Summary").replace(/^- \[ \]\s?/gm, "☐ ").replace(/^- \[x\]\s?/gim, "☑ ").replace(/^[-*]\s+/gm, "• ");

const isTauri = () => "__TAURI_INTERNALS__" in window;
const now = () => Math.floor(Date.now() / 1000);
const browserStore = {
  read(): Note[] { return JSON.parse(localStorage.getItem("mochi-notes") || "[]"); },
  write(notes: Note[]) { localStorage.setItem("mochi-notes", JSON.stringify(notes)); },
};
const browserJson = {
  read<T>(key: string, fallback: T): T { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); },
  write(key: string, value: unknown) { localStorage.setItem(key, JSON.stringify(value)); },
};

function browserSegments(note: Note): Segment[] {
  let cursor = 0;
  return note.transcript.split(/[.!?\n]+/).map(part => part.trim()).filter(Boolean).map((text, index) => {
    const duration = Math.max(1500, text.split(/\s+/).length * 360);
    const segment = { id: index + 1, noteId: note.id, startMs: cursor, endMs: cursor + duration, text, speaker: "Speaker 1", overlap: false, speakerConfidence: 0, status: "final" as const, confidence: 1, language: "auto", source: "legacy", userEdited: false };
    cursor += duration; return segment;
  });
}

async function command<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  if (isTauri()) return invoke<T>(name, args);
  const notes = browserStore.read();
  if (name === "list_notes") {
    const query = String(args.query || "").toLowerCase();
    return notes.map(note => ({ ...note, focusInstruction: note.focusInstruction || "" })).filter(note => [note.title, note.transcript, note.userNotes, note.focusInstruction, note.summary].join(" ").toLowerCase().includes(query)) as T;
  }
  if (name === "create_note") {
    const projectId = typeof args.projectId === "string" ? args.projectId : null;
    if (projectId && !browserJson.read<Project[]>("mochi-projects", []).some(project => project.id === projectId)) throw new Error("That folder no longer exists.");
    const timestamp = now();
    const note: Note = { id: crypto.randomUUID(), title: "Untitled note", kind: String(args.kind || "meeting"), transcript: "", userNotes: "", focusInstruction: "", summary: "", actionItems: [], durationSecs: 0, createdAt: timestamp, updatedAt: timestamp };
    browserStore.write([note, ...notes]);
    const organizations = browserJson.read<NoteOrganization[]>("mochi-organization", []);
    browserJson.write("mochi-organization", [{ noteId: note.id, projectId, tags: [], people: [], archived: false, reviewed: projectId !== null }, ...organizations]);
    return note as T;
  }
  if (name === "update_note") {
    const note = { ...(args.note as Note), updatedAt: now() };
    browserStore.write(notes.map(item => item.id === note.id ? note : item)); return note as T;
  }
  if (name === "delete_note") {
    browserStore.write(notes.filter(note => note.id !== args.id));
    browserJson.write("mochi-organization", browserJson.read<NoteOrganization[]>("mochi-organization", []).filter(item => item.noteId !== args.id));
    browserJson.write("mochi-moments", browserJson.read<Moment[]>("mochi-moments", []).filter(item => item.noteId !== args.id));
    return undefined as T;
  }
  if (name === "native_capture_available") return false as T;
  if (name === "native_capture_status" || name === "request_native_capture_permission") return { compiled: false, supported: false, permission: "unavailable", screenPermission: false, active: false, noteId: null, durationSecs: 0, fileBytes: 0, systemAudio: false, microphone: true, message: "System audio is available in the macOS desktop build." } as T;
  if (name === "drain_native_audio_chunks") return [] as T;
  if (name === "acknowledge_native_audio_chunk") return undefined as T;
  if (name === "open_capture_settings" || name === "open_microphone_settings") return undefined as T;
  if (name === "list_interrupted_captures") return [] as T;
  if (name === "reveal_interrupted_capture" || name === "dismiss_interrupted_capture") return undefined as T;
  if (name === "list_projects") return browserJson.read<Project[]>("mochi-projects", []) as T;
  if (name === "save_project") {
    const project = args.project as Project;
    const projects = browserJson.read<Project[]>("mochi-projects", []);
    browserJson.write("mochi-projects", [...projects.filter(item => item.id !== project.id), project]); return project as T;
  }
  if (name === "list_note_organizations") {
    const saved = browserJson.read<NoteOrganization[]>("mochi-organization", []);
    const complete = notes.map(note => saved.find(item => item.noteId === note.id) || { noteId: note.id, projectId: null, tags: [], people: [], archived: false, reviewed: false });
    return complete as T;
  }
  if (name === "save_note_organization") {
    const requested = args.organization as NoteOrganization;
    const normalize = (values: string[], limit: number) => [...new Map(values.map(value => value.trim().replace(/^#/, "")).filter(Boolean).map(value => [value.toLowerCase(), value])).values()].slice(0, limit);
    const organization = { ...requested, tags: normalize(requested.tags, 8), people: normalize(requested.people, 12) };
    const saved = browserJson.read<NoteOrganization[]>("mochi-organization", []);
    browserJson.write("mochi-organization", [...saved.filter(item => item.noteId !== organization.noteId), organization]); return organization as T;
  }
  if (name === "list_agent_runs") return [] as T;
  if (name === "list_agent_recipes") return localRecipes as T;
  if (name === "list_moments") return browserJson.read<Moment[]>("mochi-moments", []).filter(moment => moment.noteId === args.noteId) as T;
  if (name === "save_moment") {
    const requested = args.moment as Moment;
    const moment = { ...requested, id: requested.id || crypto.randomUUID(), createdAt: requested.createdAt || now() };
    const moments = browserJson.read<Moment[]>("mochi-moments", []);
    browserJson.write("mochi-moments", [...moments.filter(item => item.id !== moment.id), moment]); return moment as T;
  }
  if (name === "delete_moment") { browserJson.write("mochi-moments", browserJson.read<Moment[]>("mochi-moments", []).filter(moment => moment.id !== args.id)); return undefined as T; }
  if (name === "transcription_model_status") return { installed: false, path: "", sizeBytes: 0, displayName: "Whisper Small Multilingual" } as T;
  if (name === "local_ai_status") return { installed: false, running: false, modelPath: "", runtimePath: "", modelSizeBytes: 0, displayName: "Qwen3 4B · Q4_K_M" } as T;
  if (name === "list_templates") return builtInTemplates as T;
  if (name === "list_transcript_segments") return browserSegments(notes.find(note => note.id === args.noteId)!) as T;
  if (name === "list_jobs") return browserJson.read<TranscriptionJob[]>("mochi-jobs", []).filter(job => job.noteId === args.noteId) as T;
  if (name === "get_transcription_preference") return (browserJson.read<TranscriptionPreference[]>("mochi-transcription-preferences", []).find(item => item.noteId === args.noteId) || { noteId: args.noteId, language: "auto", translate: false }) as T;
  if (name === "set_transcription_preference") {
    const preference = args.preference as TranscriptionPreference; const saved = browserJson.read<TranscriptionPreference[]>("mochi-transcription-preferences", []);
    browserJson.write("mochi-transcription-preferences", [...saved.filter(item => item.noteId !== preference.noteId), preference]); return preference as T;
  }
  if (name === "save_live_segments") {
    const live = args.segments as LiveSegment[]; const note = notes.find(item => item.id === args.noteId)!;
    const transcript = live.map(segment => `[${formatTime(segment.startMs)}] ${segment.text}`).join("\n");
    browserStore.write(notes.map(item => item.id === note.id ? { ...item, transcript, updatedAt: now() } : item));
    return live.map((segment, index) => ({ ...segment, id: index + 1, noteId: note.id, speaker: "Speaker 1", overlap: false, speakerConfidence: 0, status: "draft", confidence: 1 - (segment.noSpeechProbability || 0), language: String(args.language || "auto"), source: "live", userEdited: false })) as T;
  }
  if (name === "cancel_transcription") return undefined as T;
  if (name === "list_generated_blocks") return [] as T;
  if (name === "list_action_items") return notes.flatMap(note => note.actionItems.map((description, index) => ({ id: `${note.id}-${index}`, noteId: note.id, noteTitle: note.title, description, status: "open", citationIds: [], confidence: 0, userEdited: false }))) as T;
  if (name === "search_library") {
    const query = String(args.query).toLowerCase();
    return notes.flatMap(note => browserSegments(note).filter(segment => `${note.title} ${segment.text}`.toLowerCase().includes(query)).map(segment => ({ noteId: note.id, noteTitle: note.title, segmentId: segment.id, startMs: segment.startMs, speaker: segment.speaker, excerpt: segment.text, kind: "transcript" }))) as T;
  }
  throw new Error("This feature requires the desktop app.");
}

function formatDay(timestamp: number) {
  const date = new Date(timestamp * 1000);
  return date.toDateString() === new Date().toDateString() ? "Today" : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function formatTime(milliseconds: number) {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}
function formatDuration(seconds: number) { return formatTime(seconds * 1000); }
const transcriptionLanguages = [{ value: "auto", label: "Auto-detect" }, { value: "en", label: "English" }, { value: "hi", label: "Hindi" }, { value: "es", label: "Spanish" }, { value: "fr", label: "French" }, { value: "de", label: "German" }, { value: "ar", label: "Arabic" }, { value: "th", label: "Thai" }, { value: "ja", label: "Japanese" }, { value: "ko", label: "Korean" }, { value: "zh", label: "Chinese" }, { value: "pt", label: "Portuguese" }, { value: "it", label: "Italian" }];
function languageName(code: string) { return transcriptionLanguages.find(language => language.value === code)?.label || code; }

export default function App() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<View>("library");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(true);
  const [panel, setPanel] = useState<"notes" | "transcript" | "brief">("notes");
  const [enhancedView, setEnhancedView] = useState(false);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [actions, setActions] = useState<ActionItem[]>([]);
  const [templates, setTemplates] = useState<Template[]>(builtInTemplates);
  const [projects, setProjects] = useState<Project[]>([]);
  const [organizations, setOrganizations] = useState<NoteOrganization[]>([]);
  const [agentRuns, setAgentRuns] = useState<AgentRun[]>([]);
  const [agentRecipes, setAgentRecipes] = useState<AgentRecipe[]>(localRecipes);
  const [moments, setMoments] = useState<Moment[]>([]);
  const [agentBusy, setAgentBusy] = useState(false);
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [activeFacet, setActiveFacet] = useState<string | null>(null);
  const [highlightedSegment, setHighlightedSegment] = useState<number | null>(null);
  const [rawTranscript, setRawTranscript] = useState(false);
  const [recording, setRecording] = useState(false);
  const [captureBusy, setCaptureBusy] = useState<"starting" | "stopping" | null>(null);
  const captureTransition = useRef(false);
  const roomCompletion = useRef<Promise<void> | null>(null);
  const [captureError, setCaptureError] = useState<{ noteId: string; title: string; detail: string } | null>(null);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [audioLevels, setAudioLevels] = useState<number[]>(Array(14).fill(0.06));
  const [liveSegments, setLiveSegments] = useState<LiveSegment[]>([]);
  const [liveTranscriptionMessage, setLiveTranscriptionMessage] = useState<string | null>(null);
  const [noteQuestion, setNoteQuestion] = useState("");
  const [noteAnswer, setNoteAnswer] = useState<string | null>(null);
  const [transcriptionJob, setTranscriptionJob] = useState<TranscriptionJob | null>(null);
  const [transcriptionProgress, setTranscriptionProgress] = useState<TranscriptionProgress | null>(null);
  const [transcriptionPreference, setTranscriptionPreference] = useState<TranscriptionPreference | null>(null);
  const [shadowPhase, setShadowPhase] = useState<ShadowPhase>("idle");
  const [shadowMessage, setShadowMessage] = useState<string | null>(null);
  const [shadowSyncTick, setShadowSyncTick] = useState(0);
  const [processing, setProcessing] = useState<"generate" | "transcribe" | "diarize" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [appearance, setAppearance] = useState<"system" | "light" | "dark">(() => {
    const saved = localStorage.getItem("mochi-appearance");
    return saved === "light" || saved === "dark" ? saved : "system";
  });
  const [onboarding, setOnboarding] = useState(() => localStorage.getItem("mochi-onboarded") !== "yes");
  const [captureMode, setCaptureModeState] = useState<CaptureMode>(() => localStorage.getItem("mochi-capture-mode") === "room" ? "room" : "meeting");
  const [captureStatus, setCaptureStatus] = useState<NativeCaptureStatus | null>(null);
  const [interruptedCapture, setInterruptedCapture] = useState<InterruptedCapture | null>(null);
  const [captureHelpOpen, setCaptureHelpOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("mochi-sidebar-collapsed") === "yes");
  const [modelStatus, setModelStatus] = useState<ModelStatus | null>(null);
  const [modelDownload, setModelDownload] = useState<ModelDownloadProgress | null>(null);
  const [generationProgress, setGenerationProgress] = useState<GenerationProgress | null>(null);
  const [localAi, setLocalAi] = useState<LocalAiStatus | null>(null);
  const [aiDownload, setAiDownload] = useState<AiDownloadProgress | null>(null);
  const [installingAi, setInstallingAi] = useState(false);
  const [downloadingModel, setDownloadingModel] = useState(false);
  const [modelEndpoint, setModelEndpoint] = useState(localStorage.getItem("mochi-endpoint") || "http://127.0.0.1:8080/v1");
  const [modelName, setModelName] = useState(localStorage.getItem("mochi-model") || "qwen3-4b");
  const [chatQuery, setChatQuery] = useState("");
  const [chatAnswer, setChatAnswer] = useState<ChatAnswer | null>(null);
  const previousChatQuery = useRef("");
  const [chatBusy, setChatBusy] = useState(false);
  const [aiTask, setAiTask] = useState<AiTask | null>(null);
  const [pendingEnhancements, setPendingEnhancements] = useState<string[]>(() => {
    try { const value: unknown = JSON.parse(localStorage.getItem("mochi-pending-enhancements") || "[]"); return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []; }
    catch { return []; }
  });
  const activeAiTask = useRef<AiTask | null>(null);
  const cancelledAiTasks = useRef(new Set<string>());
  const [captureExpanded, setCaptureExpanded] = useState(false);
  const [audioError, setAudioError] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [projectCreatorOpen, setProjectCreatorOpen] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const meetingMicStream = useRef<MediaStream | null>(null);
  const liveRecorder = useRef<MediaRecorder | null>(null);
  const liveChunkTimer = useRef<number | null>(null);
  const liveChunkActive = useRef(false);
  const liveTranscriptionQueue = useRef<Promise<void>>(Promise.resolve());
  const nativeAudioDrainQueue = useRef<Promise<void>>(Promise.resolve());
  const nativeRecoveryRunning = useRef(false);
  const nativeRecoveryAttempted = useRef(new Set<string>());
  const liveSegmentsRef = useRef<LiveSegment[]>([]);
  const pendingLiveSegments = useRef<LiveSegment[]>([]);
  const liveOwnerNoteId = useRef<string | null>(null);
  const sessionLanguageRef = useRef("auto");
  const liveStopPending = useRef<Promise<void> | null>(null);
  const meterContext = useRef<AudioContext | null>(null);
  const meterFrame = useRef<number | null>(null);
  const meterLastPaint = useRef(0);
  const shadowSession = useRef(false);
  const activeCaptureMode = useRef<CaptureMode | null>(null);
  const toggleRecordingRef = useRef<() => Promise<void>>(async () => undefined);
  const recordSecondsRef = useRef(0);
  const recordingWrites = useRef<Promise<void>>(Promise.resolve());
  const startedAt = useRef(0);
  const searchInput = useRef<HTMLInputElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const searchMounted = useRef(false);
  const refreshSequence = useRef(0);
  const editedFields = useRef(new Map<string, Set<keyof Note>>());
  const editVersions = useRef(new Map<string, number>());
  const noteSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const automaticTranscriptions = useRef(new Set<string>());
  const autoEnhancementInFlight = useRef<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const creationFolderId = useRef<string | null>(null);
  creationFolderId.current = view === "project" ? activeProject : null;

  const selected = useMemo(() => notes.find(note => note.id === selectedId) || null, [notes, selectedId]);
  selectedIdRef.current = selectedId;
  const openActionCount = actions.filter(action => action.status === "open").length;
  const organizationFor = (noteId: string) => organizations.find(item => item.noteId === noteId) || { noteId, projectId: null, tags: [], people: [], archived: false, reviewed: false };
  const selectedOrganization = selected ? organizationFor(selected.id) : null;
  const inboxCount = notes.filter(note => { const organization = organizationFor(note.id); return !organization.archived && (!organization.reviewed || note.title.startsWith("Untitled")); }).length;
  const allPeople = useMemo(() => [...new Set(organizations.flatMap(item => item.people))].sort(), [organizations]);
  const allTags = useMemo(() => [...new Set(organizations.flatMap(item => item.tags))].sort(), [organizations]);
  const visibleNotes = useMemo(() => notes.filter(note => {
    const organization = organizationFor(note.id);
    if (view === "archive") return organization.archived;
    if (organization.archived) return false;
    if (view === "inbox") return !organization.reviewed || note.title.startsWith("Untitled");
    if (view === "project") return organization.projectId === activeProject;
    if (view === "people") return !activeFacet || organization.people.includes(activeFacet);
    if (view === "tags") return !activeFacet || organization.tags.includes(activeFacet);
    return true;
  }), [notes, organizations, view, activeProject, activeFacet]);
  const systemCaptureAvailable = !!captureStatus?.compiled && captureStatus.supported;
  const meetingCaptureReady = systemCaptureAvailable && ["granted", "audio_permission_unknown"].includes(captureStatus?.permission || "");
  const activeTranscription = transcriptionProgress?.noteId === selected?.id ? transcriptionProgress : transcriptionJob ? { noteId: transcriptionJob.noteId, progress: transcriptionJob.progress, stage: transcriptionJob.stage, status: transcriptionJob.status } : null;
  const isRefining = activeTranscription?.status === "running" || activeTranscription?.status === "queued";
  const libraryTitle = view === "inbox" ? "Inbox" : view === "meetings" ? "Meetings" : view === "archive" ? "Archive" : view === "people" ? "People" : view === "tags" ? "Tags" : view === "project" ? projects.find(project => project.id === activeProject)?.name || "Project" : "Home";
  const libraryDescription = view === "inbox" ? "Unreviewed recordings and notes that still need a home." : view === "archive" ? "Meetings kept out of your active workspace." : view === "people" ? "Every conversation connected to a person." : view === "tags" ? "Topics that cut across projects." : view === "project" ? "Meetings, decisions, and actions for this project." : "Your recent conversations, ready when you need them.";

  async function refresh(search = query) {
    const request = ++refreshSequence.current;
    const [rows, actionRows, templateRows, projectRows, organizationRows] = await Promise.all([
      command<Note[]>("list_notes", { query: search || null }),
      command<ActionItem[]>("list_action_items", { noteId: null }),
      command<Template[]>("list_templates"),
      command<Project[]>("list_projects"),
      command<NoteOrganization[]>("list_note_organizations"),
    ]);
    if (request !== refreshSequence.current) return;
    setNotes(current => rows.map(row => {
      const note = { ...row, focusInstruction: row.focusInstruction || "" };
      const local = current.find(item => item.id === note.id);
      for (const field of editedFields.current.get(note.id) || []) {
        if (local) Object.assign(note, { [field]: local[field] });
      }
      return note;
    })); setActions(actionRows); setTemplates(templateRows); setProjects(projectRows); setOrganizations(organizationRows); setLoading(false);
  }

  async function loadNoteData(noteId: string) {
    const [segmentRows, blockRows, runRows, momentRows, jobRows, preference] = await Promise.all([
      command<Segment[]>("list_transcript_segments", { noteId }),
      command<Block[]>("list_generated_blocks", { noteId }),
      command<AgentRun[]>("list_agent_runs", { noteId }),
      command<Moment[]>("list_moments", { noteId }),
      command<TranscriptionJob[]>("list_jobs", { noteId }),
      command<TranscriptionPreference>("get_transcription_preference", { noteId }),
    ]);
    if (selectedIdRef.current !== noteId) return segmentRows;
    setSegments(segmentRows); setBlocks(blockRows); setAgentRuns(runRows); setMoments(momentRows); setTranscriptionJob(jobRows.find(job => job.kind === "transcribe") || null); setTranscriptionPreference(preference); return segmentRows;
  }

  useEffect(() => {
    document.body.classList.toggle("tauri-main", isTauri());
    return () => document.body.classList.remove("tauri-main");
  }, []);
  useEffect(() => {
    localStorage.setItem("mochi-appearance", appearance);
    document.documentElement.dataset.theme = appearance;
    document.documentElement.style.colorScheme = appearance === "system" ? "light dark" : appearance;
    if (isTauri()) void emit("appearance-changed", { appearance });
  }, [appearance]);
  useEffect(() => {
    refresh().catch(error => setNotice(String(error)));
    command<NativeCaptureStatus>("native_capture_status").then(setCaptureStatus).catch(error => setCaptureStatus({ compiled: false, supported: false, permission: "unavailable", screenPermission: false, active: false, noteId: null, durationSecs: 0, fileBytes: 0, systemAudio: false, microphone: true, message: String(error) }));
    command<InterruptedCapture[]>("list_interrupted_captures").then(rows => setInterruptedCapture(rows[0] || null)).catch(() => undefined);
    command<ModelStatus>("transcription_model_status").then(setModelStatus).catch(() => setModelStatus(null));
    command<LocalAiStatus>("local_ai_status").then(status => {
      setLocalAi(status);
      if (status.installed && !status.running) void command<LocalAiStatus>("start_local_ai").then(setLocalAi).catch(error => setNotice(`Could not start Qwen: ${error}`));
    }).catch(() => setLocalAi(null));
  }, []);

  useEffect(() => {
    const recheck = () => { void command<NativeCaptureStatus>("native_capture_status").then(setCaptureStatus).catch(() => undefined); };
    window.addEventListener("focus", recheck);
    return () => window.removeEventListener("focus", recheck);
  }, []);

  useEffect(() => {
    void command<AgentRecipe[]>("list_agent_recipes").then(setAgentRecipes).catch(error => setNotice(String(error)));
    if (!isTauri()) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen<AgentRun>("agent-run-changed", event => {
      const run = event.payload;
      if (run.noteId === selectedIdRef.current) mergeAgentRun(run);
    }).then(unlisten => { if (disposed) unlisten(); else stop = unlisten; }).catch(error => setNotice(String(error)));
    return () => { disposed = true; stop?.(); };
  }, []);

  function setCaptureMode(mode: CaptureMode) {
    if (recording || captureTransition.current) return;
    localStorage.setItem("mochi-capture-mode", mode);
    setCaptureModeState(mode);
  }
  function toggleSidebar() {
    setSidebarCollapsed(value => {
      localStorage.setItem("mochi-sidebar-collapsed", value ? "no" : "yes");
      return !value;
    });
  }
  useEffect(() => { if (selectedId) loadNoteData(selectedId).catch(error => setNotice(String(error))); else { setSegments([]); setBlocks([]); setMoments([]); setTranscriptionJob(null); setTranscriptionPreference(null); } }, [selectedId]);
  useEffect(() => {
    if (!isTauri()) return;
    let stopDownload: (() => void) | undefined; let stopGeneration: (() => void) | undefined; let stopAiDownload: (() => void) | undefined; let stopTranscription: (() => void) | undefined;
    void listen<ModelDownloadProgress>("model-download-progress", event => setModelDownload(event.payload)).then(unlisten => { stopDownload = unlisten; });
    void listen<GenerationProgress>("generation-progress", event => setGenerationProgress(event.payload)).then(unlisten => { stopGeneration = unlisten; });
    void listen<AiDownloadProgress>("ai-download-progress", event => setAiDownload(event.payload)).then(unlisten => { stopAiDownload = unlisten; });
    void listen<TranscriptionProgress>("transcription-progress", event => { setTranscriptionProgress(event.payload); if (event.payload.noteId === selectedIdRef.current) setTranscriptionJob(current => ({ id: current?.id || "active", noteId: event.payload.noteId, kind: "transcribe", status: event.payload.status, error: current?.error, progress: event.payload.progress, stage: event.payload.stage, cancelRequested: false, createdAt: current?.createdAt || now(), updatedAt: now() })); }).then(unlisten => { stopTranscription = unlisten; });
    return () => { stopDownload?.(); stopGeneration?.(); stopAiDownload?.(); stopTranscription?.(); };
  }, []);
  useEffect(() => {
    if (!isTauri()) return;
    const stops: Array<() => void> = [];
    let disposed = false;
    const subscribe = <T,>(name: string, callback: (event: { payload: T }) => void) => {
      void listen<T>(name, callback).then(stop => { if (disposed) stop(); else stops.push(stop); })
        .catch(error => setNotice(`Overlay controls could not connect: ${error}`));
    };
    subscribe("shadow-ready", () => setShadowSyncTick(value => value + 1));
    subscribe("shadow-stop-request", () => { void toggleRecordingRef.current(); });
    subscribe("shadow-open-main-request", () => {
      if (liveOwnerNoteId.current) openNote(liveOwnerNoteId.current);
      void command("show_main");
    });
    subscribe("shadow-close-request", () => {
      shadowSession.current = false;
      void command("hide_shadow");
    });
    subscribe<{ kind: Moment["kind"] }>("shadow-moment-request", event => {
      const noteId = liveOwnerNoteId.current;
      if (!noteId) return;
      const draft: Moment = { id: "", noteId, kind: event.payload.kind, label: "", timestampMs: recordSecondsRef.current * 1000, createdAt: 0 };
      void command<Moment>("save_moment", { moment: draft }).then(moment => { if (selectedIdRef.current === noteId) setMoments(current => [...current, moment].sort((left, right) => left.timestampMs - right.timestampMs)); }).catch(error => setNotice(`Could not mark moment: ${error}`));
      setShadowMessage(`${event.payload.kind} marked at ${formatDuration(recordSecondsRef.current)}`);
      window.setTimeout(() => setShadowMessage(null), 1800);
    });
    return () => { disposed = true; stops.forEach(stop => stop()); };
  }, []);
  useEffect(() => {
    recordSecondsRef.current = recordSeconds;
    const sessionNote = notes.find(note => note.id === liveOwnerNoteId.current) || selected;
    if (!isTauri() || !shadowSession.current || !sessionNote) return;
    void emit("shadow-state", {
      phase: shadowPhase,
      noteId: sessionNote.id,
      title: sessionNote.title || "Untitled note",
      seconds: recordSeconds,
      source: (activeCaptureMode.current || captureMode) === "meeting" ? "Mac + microphone" : "Microphone",
      levels: audioLevels,
      transcript: liveSegments,
      whisperInstalled: !!modelStatus?.installed,
      liveTranscriptionAvailable: !!modelStatus?.installed,
      localAiRunning: !!localAi?.running,
      endpoint: modelEndpoint,
      model: modelName,
      message: shadowMessage || (recording ? liveTranscriptionMessage : null),
    });
  }, [shadowPhase, selected, notes, recordSeconds, captureMode, audioLevels, liveSegments, modelStatus?.installed, localAi?.running, modelEndpoint, modelName, shadowMessage, liveTranscriptionMessage, recording, shadowSyncTick]);
  useEffect(() => {
    if (!recording || activeCaptureMode.current !== "meeting" || !isTauri()) return;
    let disposed = false;
    let polling = false;
    const timer = window.setInterval(async () => {
      if (polling || captureTransition.current) return;
      polling = true;
      try {
        const status = await command<NativeCaptureStatus>("native_capture_status");
        if (disposed || captureTransition.current) return;
        setCaptureStatus(status);
        if (!status.active) {
          setCaptureError({ noteId: liveOwnerNoteId.current || "", title: "Recording stopped unexpectedly", detail: status.message });
          // Finalize any real output and release the failed native session.
          void toggleRecordingRef.current();
        }
      } catch (error) {
        if (!disposed) setCaptureError({ noteId: liveOwnerNoteId.current || "", title: "Could not check recording status", detail: String(error) });
      } finally { polling = false; }
    }, 1000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [recording]);
  useEffect(() => {
    if (!recording || activeCaptureMode.current !== "meeting" || !isTauri()) return;
    let draining = false;
    const timer = window.setInterval(() => {
      if (draining) return;
      draining = true;
      void drainNativeAudioChunks(liveOwnerNoteId.current).catch(() => undefined).finally(() => { draining = false; });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [recording, modelStatus?.installed]);
  useEffect(() => { setNoteAnswer(null); setNoteQuestion(""); }, [selectedId]);
  useEffect(() => {
    if (highlightedSegment == null || !segments.some(segment => segment.id === highlightedSegment)) return;
    const timer = window.setTimeout(() => {
      document.getElementById(`segment-${highlightedSegment}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      const segment = segments.find(item => item.id === highlightedSegment);
      if (segment && audioRef.current) { audioRef.current.currentTime = segment.startMs / 1000; void audioRef.current.play().catch(() => undefined); }
    }, 80);
    return () => clearTimeout(timer);
  }, [highlightedSegment, segments, panel]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === "n") { event.preventDefault(); void addNote(); }
      if (event.key.toLowerCase() === "k") { event.preventDefault(); setCommandOpen(true); }
    };
    window.addEventListener("keydown", shortcut); return () => window.removeEventListener("keydown", shortcut);
  }, [templates]);
  useEffect(() => {
    if (!searchMounted.current) { searchMounted.current = true; return; }
    const timer = window.setTimeout(() => refresh(query).catch(error => setNotice(String(error))), 180);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    if (!selected || saved) return;
    const timer = window.setTimeout(async () => {
      try {
        const version = editVersions.current.get(selected.id) || 0;
        const fields = [...(editedFields.current.get(selected.id) || [])];
        const save = noteSaveQueue.current.then(async () => { await command<Note>("update_note", { note: selected, editedFields: fields }); });
        noteSaveQueue.current = save.catch(() => undefined);
        await save;
        if (editVersions.current.get(selected.id) === version) {
          editedFields.current.delete(selected.id);
          if (selectedIdRef.current === selected.id) setSaved(true);
        }
      } catch (error) { setNotice(`Could not save: ${error}`); }
    }, 500);
    return () => clearTimeout(timer);
  }, [selected, saved]);
  useEffect(() => {
    if (!recording || captureBusy) return;
    const timer = window.setInterval(() => setRecordSeconds(Math.floor((Date.now() - startedAt.current) / 1000)), 250);
    return () => clearInterval(timer);
  }, [recording, captureBusy]);
  useEffect(() => {
    if (!isTauri() || !modelStatus?.installed || processing) return;
    const candidates = notes.filter(note => note.audioPath && !automaticTranscriptions.current.has(note.id));
    void Promise.all(candidates.map(async note => ({ note, jobs: await command<TranscriptionJob[]>("list_jobs", { noteId: note.id }) }))).then(rows => {
      const pending = rows.find(({ note, jobs }) => !note.transcript.trim() && jobs.some(job => job.status === "queued"));
      if (!pending || processing) return;
      automaticTranscriptions.current.add(pending.note.id); void transcribeNote(pending.note.id, true);
    }).catch(() => undefined);
  }, [modelStatus?.installed, notes, processing]);

  useEffect(() => {
    if (!isTauri() || !modelStatus?.installed || recording || processing || nativeRecoveryRunning.current || !notes.length) return;
    nativeRecoveryRunning.current = true;
    void (async () => {
      const pending = await command<string[]>("list_pending_native_audio_notes");
      for (const id of pending) {
        if (nativeRecoveryAttempted.current.has(id) || !notes.some(note => note.id === id)) continue;
        nativeRecoveryAttempted.current.add(id);
        setNotice("Finishing saved live transcript locally…");
        await drainNativeAudioChunks(id, true);
        const saved = await command<Segment[]>("list_transcript_segments", { noteId: id });
        const transcript = saved.map(segment => `[${formatTime(segment.startMs)}] ${segment.text}`).join("\n");
        setNotes(current => current.map(note => note.id === id ? { ...note, transcript } : note));
        if (selectedIdRef.current === id) setSegments(saved);
        if (transcript.trim()) {
          setPendingEnhancements(current => current.includes(id) ? current : [...current, id]);
          setNotice("Saved live transcript ready · preparing enhanced notes.");
        } else setNotice("Recording saved, but no speech was detected in its live audio.");
      }
    })().catch(error => setNotice(`Saved audio is safe; live transcript catch-up needs attention: ${String(error)}`))
      .finally(() => { nativeRecoveryRunning.current = false; });
  }, [modelStatus?.installed, notes, recording, processing]);

  useEffect(() => { localStorage.setItem("mochi-pending-enhancements", JSON.stringify(pendingEnhancements)); }, [pendingEnhancements]);
  useEffect(() => {
    if (!localAi?.running || processing || aiTask || autoEnhancementInFlight.current) return;
    const note = pendingEnhancements.map(id => notes.find(item => item.id === id)).find(item => item?.transcript.trim());
    if (!note) return;
    if (note.summary.trim()) {
      setPendingEnhancements(current => current.filter(id => id !== note.id));
      setNotice("Transcript ready. Your existing enhanced notes were kept; choose Refresh to update them.");
      return;
    }
    autoEnhancementInFlight.current = note.id;
    void generateNotes(note, true);
  }, [pendingEnhancements, notes, localAi?.running, processing, aiTask]);

  function patchSelected(patch: Partial<Note>) {
    if (!selectedId) return;
    const fields = editedFields.current.get(selectedId) || new Set<keyof Note>();
    for (const field of Object.keys(patch) as (keyof Note)[]) fields.add(field);
    editedFields.current.set(selectedId, fields);
    editVersions.current.set(selectedId, (editVersions.current.get(selectedId) || 0) + 1);
    setNotes(current => current.map(note => note.id === selectedId ? { ...note, ...patch } : note)); setSaved(false);
  }
  function openNote(id: string) { setCaptureExpanded(false); setAudioError(false); setEnhancedView(false); setSegments([]); setBlocks([]); setAgentRuns([]); setMoments([]); setSelectedId(id); setHighlightedSegment(null); setRawTranscript(false); }

  function openFolder(id: string) {
    setQuery(""); setActiveProject(id); setSelectedId(null); setView("project");
  }

  async function addNote(kind = "meeting") {
    const projectId = creationFolderId.current;
    try {
      const note = await command<Note>("create_note", { kind, projectId });
      const prepared = { ...note, focusInstruction: note.focusInstruction || "" };
      setOrganizations(current => [{ noteId: note.id, projectId, tags: [], people: [], archived: false, reviewed: projectId !== null }, ...current.filter(item => item.noteId !== note.id)]);
      setCaptureExpanded(false); setAudioError(false); setEnhancedView(false);
      setQuery("");
      setNotes(current => [prepared, ...current]); setSelectedId(note.id); setView(projectId ? "project" : "library"); setPanel("notes");
      if (projectId) setActiveProject(projectId);
    } catch (error) { setNotice(`Could not create note: ${error}`); }
  }

  async function removeSelected() {
    if (recording || captureTransition.current) { setNotice("Finish recording before deleting this note."); return; }
    if (!selected || !confirm(`Delete “${selected.title}”? Its audio will also be removed.`)) return;
    try { await command("delete_note", { id: selected.id }); setNotes(current => current.filter(note => note.id !== selected.id)); setSelectedId(null); }
    catch (error) { setNotice(`Could not delete note: ${error}`); }
  }

  async function transcribeNote(noteId = selected?.id, automatic = false) {
    if (!noteId) return;
    setProcessing("transcribe"); setTranscriptionProgress({ noteId, progress: 1, stage: "Preparing audio", status: "running" });
    if (selectedId === noteId && !automatic) setPanel("transcript");
    try {
      const updated = await command<Note>("run_transcription_job", { noteId });
      setNotes(current => current.map(note => note.id === updated.id ? { ...note, transcript: updated.transcript, audioPath: updated.audioPath, durationSecs: updated.durationSecs, updatedAt: updated.updatedAt } : note));
      const finalized = selectedId === noteId ? await loadNoteData(noteId) : await command<Segment[]>("list_transcript_segments", { noteId });
      if (shadowSession.current) setLiveSegments(finalized.map(segment => ({ startMs: segment.startMs, endMs: segment.endMs, text: segment.text })));
      if (updated.transcript.trim()) {
        setPendingEnhancements(current => current.includes(noteId) ? current : [...current, noteId]);
        setNotice(localAi?.running ? "Transcript ready · Preparing enhanced notes" : "Transcript ready · Enhanced notes will start when local AI is ready");
      } else setNotice("Recording saved, but no speech was found. Check the audio and try transcribing again.");
      if (shadowSession.current) { setShadowPhase("ready"); setShadowMessage("Recording and transcript saved locally"); }
    } catch (error) {
      const message = String(error); setNotice(message.toLowerCase().includes("cancelled") ? "Draft saved · Refinement cancelled" : `Draft saved · Refinement could not finish: ${message}`);
      if (shadowSession.current) { setShadowPhase("error"); setShadowMessage("Recording saved, but transcription needs attention"); }
    }
    finally { setProcessing(null); }
  }

  async function cancelRefinement() {
    if (!selected) return;
    try { await command("cancel_transcription", { noteId: selected.id }); setTranscriptionJob(current => current ? { ...current, stage: "Cancelling refinement", cancelRequested: true } : current); }
    catch (error) { setNotice(`Could not cancel refinement: ${error}`); }
  }

  async function setTranscriptLanguage(language: string) {
    if (!selected) return;
    const preference = await command<TranscriptionPreference>("set_transcription_preference", { preference: { noteId: selected.id, language, translate: transcriptionPreference?.translate || false } });
    setTranscriptionPreference(preference); setNotice(language === "auto" ? "MOCHI will detect the language from meaningful speech." : `Language locked to ${languageName(language)}.`);
  }

  async function toggleTranscriptTranslation() {
    if (!selected) return;
    const translate = !transcriptionPreference?.translate;
    const preference = await command<TranscriptionPreference>("set_transcription_preference", { preference: { noteId: selected.id, language: transcriptionPreference?.language || "auto", translate } });
    setTranscriptionPreference(preference); setNotice(translate ? "Future refinement will translate speech to English." : "Future refinement will preserve the original language.");
  }

  async function editTranscriptSegment(segment: Segment, text: string) {
    const cleaned = text.trim(); if (!cleaned || cleaned === segment.text) return;
    try { const updated = await command<Segment>("update_transcript_segment", { segmentId: segment.id, text: cleaned }); setSegments(current => current.map(item => item.id === updated.id ? updated : item)); }
    catch (error) { setNotice(`Could not save transcript edit: ${error}`); }
  }

  async function diarizeNote() {
    if (!selected) return;
    setProcessing("diarize");
    try { setSegments(await command<Segment[]>("run_diarization", { noteId: selected.id })); setNotice("Speaker analysis finished. Review low-confidence and overlapping turns."); }
    catch (error) { setNotice(`Speaker analysis could not finish: ${error}`); }
    finally { setProcessing(null); }
  }

  async function renameSpeaker(from: string) {
    if (!selected) return;
    const to = prompt(`Rename ${from}`, from); if (!to || to === from) return;
    try { setSegments(await command<Segment[]>("rename_speaker", { noteId: selected.id, from, to })); }
    catch (error) { setNotice(`Could not rename speaker: ${error}`); }
  }

  function jumpToCitation(segmentId: number, noteId = selectedId) {
    const segment = noteId === selectedId ? segments.find(item => item.id === segmentId) : undefined;
    if (segment && audioRef.current) {
      audioRef.current.currentTime = segment.startMs / 1000;
      void audioRef.current.play().catch(() => undefined);
    }
    if (noteId && noteId !== selectedId) openNote(noteId);
    setPanel("transcript"); setRawTranscript(false); setHighlightedSegment(segmentId);
  }

  async function runAi<T>(kind: AiTask["kind"], name: string, request: Record<string, unknown>, noteId?: string): Promise<T> {
    if (activeAiTask.current) throw new Error("Local AI is busy. Finish or cancel the current request first.");
    const task = { requestId: crypto.randomUUID(), kind, noteId };
    activeAiTask.current = task; setAiTask(task);
    try {
      const result = await command<T>(name, { request: { ...request, requestId: task.requestId } });
      if (cancelledAiTasks.current.has(task.requestId)) throw new Error("Local AI request cancelled.");
      return result;
    } finally {
      cancelledAiTasks.current.delete(task.requestId);
      if (activeAiTask.current?.requestId === task.requestId) { activeAiTask.current = null; setAiTask(null); }
    }
  }

  async function cancelAi() {
    const task = activeAiTask.current; if (!task) return;
    cancelledAiTasks.current.add(task.requestId);
    try { await command("cancel_local_ai_request", { requestId: task.requestId }); }
    catch (error) { setNotice(`Could not cancel local AI: ${error}`); }
  }

  async function generateNotes(note = selected, automatic = false) {
    if (activeAiTask.current) return;
    if (!note?.transcript.trim()) { setNotice("Add or transcribe a conversation first."); return; }
    if (!localAi?.running) { setNotice("Install or start Qwen in Settings before generating notes."); setSettingsOpen(true); return; }
    const noteId = note.id;
    const template = templates.find(item => item.id === note.kind) || templates[0];
    setProcessing("generate"); setGenerationProgress(null);
    try {
      const result = await runAi<GeneratedNotes>("brief", "generate_cited_notes", { noteId, endpoint: modelEndpoint, model: modelName, userNotes: note.userNotes, focusInstruction: note.focusInstruction, templatePrompt: template?.summaryPrompt || "Create factual meeting notes." }, noteId);
      if (selectedIdRef.current === noteId) setBlocks(result.blocks);
      setActions(current => [...current.filter(action => action.noteId !== noteId), ...result.actions]);
      // Enhanced blocks are stored separately; the user's editable notes are never replaced.
      setNotes(current => current.map(note => note.id === noteId ? { ...note, summary: result.blocks.map(block => `## ${block.section}\n${block.text}`).join("\n\n"), actionItems: result.actions.map(action => action.description) } : note));
      setNotice(result.chunksProcessed > 1 ? `Enhanced notes ready · read ${result.chunksProcessed} parts.` : "Enhanced notes ready · sources attached.");
    } catch (error) { setNotice(automatic ? `Transcript saved · Automatic enhancement needs attention: ${String(error)}` : String(error)); }
    finally { if (automatic) autoEnhancementInFlight.current = null; setPendingEnhancements(current => current.filter(id => id !== noteId)); setProcessing(null); setGenerationProgress(null); }
  }

  async function saveEnhancedBlock(block: Block) {
    try {
      const savedBlock = await command<Block>("update_generated_block", { block });
      const nextBlocks = blocks.map(item => item.id === savedBlock.id ? savedBlock : item);
      setBlocks(nextBlocks);
      setNotes(current => current.map(note => note.id === savedBlock.noteId
        ? { ...note, summary: nextBlocks.map(item => `## ${item.section}\n${item.text}`).join("\n\n") }
        : note));
      setNotice("Enhanced note saved.");
    } catch (error) { setNotice(`Could not save enhanced note: ${error}`); }
  }

  async function askLibrary() {
    if (!chatQuery.trim() || activeAiTask.current) return;
    setChatBusy(true); setChatAnswer(null);
    try { setChatAnswer(await runAi<ChatAnswer>("answer", "chat_library", { query: chatQuery, previousQuery: previousChatQuery.current || null, endpoint: modelEndpoint, model: modelName })); previousChatQuery.current = chatQuery; }
    catch (error) { setNotice(String(error)); }
    finally { setChatBusy(false); }
  }

  async function askThisNote(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !noteQuestion.trim() || !localAi?.running || activeAiTask.current) return;
    const noteId = selected.id;
    const transcript = recording && activeCaptureMode.current === "meeting"
      ? liveSegmentsRef.current.map(segment => `[${formatTime(segment.startMs)}] ${segment.text}`).join("\n")
      : selected.transcript;
    const context = [selected.userNotes.trim() && `PERSONAL NOTES:\n${selected.userNotes}`, transcript.trim() && `TRANSCRIPT:\n${transcript}`].filter(Boolean).join("\n\n");
    if (!context) { setNotice("Add a note or transcript before asking about this meeting."); return; }
    try {
      setNoteAnswer(null);
      setNoteAnswer(await runAi<string>("answer", "answer_live", { endpoint: modelEndpoint, model: modelName, transcript: context, question: noteQuestion.trim() }, noteId));
    } catch (error) { if (!String(error).includes("cancelled")) setNotice(`Could not answer from this meeting: ${error}`); }
  }

  async function updateAction(action: ActionItem, patch: Partial<ActionItem>) {
    const changed = { ...action, ...patch };
    setActions(current => current.map(item => item.id === action.id ? changed : item));
    try {
      const savedAction = await command<ActionItem>("update_action_item", { action: changed });
      setActions(current => current.map(item => item.id === action.id ? savedAction : item));
    } catch (error) { setNotice(`Could not save action item: ${error}`); }
  }

  async function saveTemplate(template: Template) {
    try {
      const savedTemplate = await command<Template>("save_template", { template });
      setTemplates(current => [...current.filter(item => item.id !== savedTemplate.id), savedTemplate]);
      setNotice("Template saved.");
    } catch (error) { setNotice(`Could not save template: ${error}`); }
  }

  async function deleteTemplate(template: Template) {
    if (template.isDefault || !confirm(`Delete template “${template.name}”?`)) return;
    try { await command("delete_template", { id: template.id }); setTemplates(current => current.filter(item => item.id !== template.id)); }
    catch (error) { setNotice(`Could not delete template: ${error}`); }
  }

  async function saveOrganization(organization: NoteOrganization) {
    try {
      const savedOrganization = await command<NoteOrganization>("save_note_organization", { organization });
      setOrganizations(current => [...current.filter(item => item.noteId !== organization.noteId), savedOrganization]);
    } catch (error) { setNotice(`Could not organize note: ${error}`); }
  }

  async function updateMoment(moment: Moment, label: string) {
    try {
      const savedMoment = await command<Moment>("save_moment", { moment: { ...moment, label } });
      setMoments(current => current.map(item => item.id === savedMoment.id ? savedMoment : item));
    } catch (error) { setNotice(`Could not update moment: ${error}`); }
  }

  async function createMomentFromSegment(segment: Segment) {
    if (!selected) return;
    try {
      const moment = await command<Moment>("save_moment", { moment: { id: "", noteId: selected.id, kind: "Bookmark", label: segment.text.slice(0, 120), timestampMs: segment.startMs, createdAt: 0 } });
      setMoments(current => [...current, moment].sort((left, right) => left.timestampMs - right.timestampMs)); setNotice(`Moment saved at ${formatTime(segment.startMs)}.`);
    } catch (error) { setNotice(`Could not save moment: ${error}`); }
  }

  async function removeMoment(moment: Moment) {
    try { await command("delete_moment", { id: moment.id }); setMoments(current => current.filter(item => item.id !== moment.id)); setNotice(`${moment.kind} removed.`); }
    catch (error) { setNotice(`Could not remove moment: ${error}`); }
  }

  function jumpToMoment(moment: Moment) {
    const nearest = segments.reduce<Segment | null>((best, segment) => !best || Math.abs(segment.startMs - moment.timestampMs) < Math.abs(best.startMs - moment.timestampMs) ? segment : best, null);
    if (nearest) setHighlightedSegment(nearest.id);
    if (audioRef.current) { audioRef.current.currentTime = moment.timestampMs / 1000; void audioRef.current.play().catch(() => undefined); }
  }

  async function createProject(name: string, color: string) {
    if (!name.trim()) return;
    const palette = ["#B96B4E", "#A57943", "#657A69", "#6E7691", "#8A6881"];
    try {
      const project = await command<Project>("save_project", { project: { id: crypto.randomUUID(), name: name.trim(), color: color || palette[projects.length % palette.length], createdAt: now() } });
      setProjects(current => [...current, project].sort((left, right) => left.name.localeCompare(right.name)));
      setActiveProject(project.id); setView("project"); setSelectedId(null); setProjectCreatorOpen(false); setNotice(`Project “${project.name}” created.`);
    } catch (error) { setNotice(`Could not create project: ${error}`); }
  }

  function mergeAgentRun(run: AgentRun) {
    if (selectedIdRef.current !== run.noteId) return;
    setAgentRuns(current => [run, ...current.filter(item => item.id !== run.id)].sort((left, right) => right.createdAt - left.createdAt));
  }

  async function executeRecipe(run: AgentRun) {
    if (activeAiTask.current) throw new Error("Finish or cancel the active AI request first.");
    if (!localAi?.running) throw new Error("Start local Qwen in Settings before resuming this workflow.");
    const task: AiTask = { requestId: run.id, kind: "filing", noteId: run.noteId };
    activeAiTask.current = task; setAiTask(task); setAgentBusy(true);
    try {
      const result = await command<AgentRun>("execute_agent_run", { request: { runId: run.id, endpoint: modelEndpoint, model: run.model || modelName } });
      mergeAgentRun(result);
      setNotice(result.status === "proposed" ? "Preview ready. Review and edit the changes before approving." : result.status === "cancelled" ? "Workflow cancelled. No changes applied." : result.error || "Workflow updated.");
    } finally {
      if (activeAiTask.current?.requestId === run.id) { activeAiTask.current = null; setAiTask(null); }
      setAgentBusy(false);
      if (selectedIdRef.current === run.noteId) {
        void command<AgentRun[]>("list_agent_runs", { noteId: run.noteId }).then(rows => { if (selectedIdRef.current === run.noteId) setAgentRuns(rows); }).catch(error => setNotice(String(error)));
      }
    }
  }

  async function startRecipe(recipeId: string) {
    if (!selected || activeAiTask.current || !saved || recording || agentBusy) return;
    if (!localAi?.running) { setNotice("Start local Qwen in Settings before preparing a workflow."); setSettingsOpen(true); return; }
    setAgentBusy(true);
    try {
      const run = await command<AgentRun>("start_agent_run", { noteId: selected.id, recipeId });
      mergeAgentRun(run);
      await executeRecipe(run);
    } catch (error) { setNotice(`Workflow could not finish: ${error}`); }
    finally { setAgentBusy(false); }
  }

  async function reviewAgentRun(run: AgentRun, action: ReviewAction, proposal?: Proposal) {
    if (action === "resume") { await executeRecipe(run); return; }
    if (action === "approve" && (!saved || recording)) throw new Error("Finish recording and wait for your note to save before approving.");
    const name = action === "save" ? "save_agent_proposal" : action === "approve" ? "approve_agent_run" : action === "reject" ? "reject_agent_run" : "cancel_agent_run";
    const result = await command<AgentRun>(name, { runId: run.id, revision: run.revision, proposal });
    mergeAgentRun(result);
    if (action === "approve") {
      await refresh();
      if (selectedIdRef.current === run.noteId) await loadNoteData(run.noteId);
    }
    setNotice(action === "approve" ? "Approved changes applied locally. The receipt is in Activity." : action === "save" ? "Edited preview saved. Approval is still required." : action === "reject" ? "Preview dismissed. No changes applied." : "Workflow cancelled. No changes applied.");
  }

  async function downloadModel() {
    setDownloadingModel(true); setModelDownload({ downloadedBytes: 0, totalBytes: 0, percent: 0 });
    try { setModelStatus(await command<ModelStatus>("download_transcription_model")); setNotice("Whisper is ready."); }
    catch (error) { setNotice(`Model installation could not finish: ${error}`); }
    finally { setDownloadingModel(false); }
  }

  async function installLocalAi() {
    setInstallingAi(true); setAiDownload({ component: "Preparing", downloadedBytes: 0, totalBytes: 0, percent: 0 });
    try {
      await command<LocalAiStatus>("install_local_ai");
      const running = await command<LocalAiStatus>("start_local_ai");
      setLocalAi(running); setNotice("Qwen is ready. Generated notes now run inside MOCHI.");
    } catch (error) { setNotice(`Qwen installation could not finish: ${error}`); }
    finally { setInstallingAi(false); setAiDownload(null); }
  }

  async function importMedia() {
    if (!isTauri()) { setNotice("Media import is available in the desktop app."); return; }
    const path = await open({ multiple: false, filters: [{ name: "Audio and video", extensions: ["wav", "mp3", "m4a", "mp4", "mov", "webm", "ogg", "flac", "aac"] }] });
    if (!path || Array.isArray(path)) return;
    try { const note = await command<Note>("import_media", { sourcePath: path }); setNotes(current => [note, ...current]); openNote(note.id); setPanel("transcript"); setNotice("Media imported and queued for transcription."); }
    catch (error) { setNotice(`Could not import media: ${error}`); }
  }

  async function chooseFolder(title: string) { const path = await open({ directory: true, multiple: false, title }); return typeof path === "string" ? path : null; }
  async function exportSelected() {
    if (!selected || !isTauri()) return setNotice("Export is available in the desktop app.");
    const destination = await chooseFolder("Choose an export folder"); if (!destination) return;
    try { setNotice(`Exported to ${await command<string>("export_note", { id: selected.id, destination })}`); }
    catch (error) { setNotice(`Could not export note: ${error}`); }
  }
  async function exportLibrary() {
    if (!isTauri()) return setNotice("Backup is available in the desktop app.");
    const destination = await chooseFolder("Choose a backup folder"); if (!destination) return;
    try { setNotice(`Backup created at ${await command<string>("export_library", { destination })}`); }
    catch (error) { setNotice(`Could not create backup: ${error}`); }
  }
  async function restoreLibrary() {
    if (!isTauri()) return;
    const source = await open({ directory: true, multiple: false, title: "Choose a MOCHI backup" });
    if (typeof source !== "string" || !confirm("Restore this backup? MOCHI will keep a recovery copy of your current database.")) return;
    try { const recovery = await command<string>("restore_library", { source }); await refresh(); setSelectedId(null); setSettingsOpen(false); setNotice(`Library restored. Previous database kept at ${recovery}`); }
    catch (error) { setNotice(`Could not restore backup: ${error}`); }
  }

  function startAudioMeter(stream: MediaStream) {
    stopAudioMeter();
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 128; analyser.smoothingTimeConstant = 0.68;
    context.createMediaStreamSource(stream).connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const paint = (timestamp: number) => {
      if (timestamp - meterLastPaint.current > 70) {
        analyser.getByteFrequencyData(data);
        const bars = Array.from({ length: 14 }, (_, index) => {
          const start = Math.floor(index * data.length / 28);
          const end = Math.max(start + 1, Math.floor((index + 1) * data.length / 28));
          let total = 0;
          for (let cursor = start; cursor < end; cursor += 1) total += data[cursor];
          return Math.max(0.03, Math.min(1, total / (end - start) / 190));
        });
        setAudioLevels(bars); meterLastPaint.current = timestamp;
      }
      meterFrame.current = requestAnimationFrame(paint);
    };
    meterContext.current = context;
    meterFrame.current = requestAnimationFrame(paint);
  }

  function stopAudioMeter() {
    if (meterFrame.current != null) cancelAnimationFrame(meterFrame.current);
    meterFrame.current = null;
    if (meterContext.current) void meterContext.current.close().catch(() => undefined);
    meterContext.current = null; setAudioLevels(Array(14).fill(0.06));
    meetingMicStream.current?.getTracks().forEach(track => track.stop());
    meetingMicStream.current = null;
  }

  function startLiveChunks(stream: MediaStream, noteId: string, archiveMimeType: string) {
    if (!isTauri() || !modelStatus?.installed) {
      setLiveTranscriptionMessage("Recording safely · Install Whisper for a live transcript");
      return;
    }
    pendingLiveSegments.current = [];
    liveOwnerNoteId.current = noteId;
    liveChunkActive.current = true;
    const preferred = [archiveMimeType, "audio/webm;codecs=opus", "audio/mp4"].find(type => type && MediaRecorder.isTypeSupported(type));
    sessionLanguageRef.current = transcriptionPreference?.language || "auto";
    let consecutiveFailures = 0;
    const cycle = () => {
      if (!liveChunkActive.current || stream.getAudioTracks().every(track => track.readyState === "ended")) return;
      const offsetMs = Math.max(0, Date.now() - startedAt.current);
      const chunks: BlobPart[] = [];
      const chunkRecorder = preferred ? new MediaRecorder(stream, { mimeType: preferred }) : new MediaRecorder(stream);
      liveRecorder.current = chunkRecorder;
      chunkRecorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      chunkRecorder.onstop = async () => {
        if (liveChunkTimer.current != null) window.clearTimeout(liveChunkTimer.current);
        const blob = new Blob(chunks, { type: chunkRecorder.mimeType || preferred || "audio/webm" });
        if (liveChunkActive.current) cycle();
        if (!blob.size || Date.now() - startedAt.current - offsetMs < 850) return;
        const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
        liveTranscriptionQueue.current = liveTranscriptionQueue.current.catch(() => undefined).then(async () => {
          try {
            const result = await command<LiveSegment[]>("transcribe_live_chunk", { noteId, mimeType: blob.type, offsetMs, bytes, language: sessionLanguageRef.current, translate: transcriptionPreference?.translate || false });
            if (sessionLanguageRef.current === "auto" && result[0]?.language && result[0].language !== "auto") sessionLanguageRef.current = result[0].language;
            const saved = await persistLiveChunk(pendingLiveSegments.current, result, batch => command<Segment[]>("save_live_segments", { noteId, segments: batch, language: sessionLanguageRef.current }));
            consecutiveFailures = 0;
            setLiveTranscriptionMessage(activeCaptureMode.current === "meeting" ? "Live microphone transcript · saved locally" : "Live transcript · saved on this Mac");
            const ordered = saved.map(segment => ({ startMs: segment.startMs, endMs: segment.endMs, text: segment.text, language: segment.language }));
            liveSegmentsRef.current = ordered; setLiveSegments(ordered);
            if (selectedIdRef.current === noteId) setSegments(saved);
            const transcript = saved.map(segment => `[${formatTime(segment.startMs)}] ${segment.text}`).join("\n");
            setNotes(current => current.map(note => note.id === noteId ? { ...note, transcript } : note));
          } catch (error) {
            consecutiveFailures += 1;
            setShadowMessage("Live text paused · Audio is still safe");
            setLiveTranscriptionMessage(`Live text paused · Retrying (${consecutiveFailures}) · Recording is safe`);
            throw error;
          }
        });
      };
      chunkRecorder.start();
      liveChunkTimer.current = window.setTimeout(() => {
        if (chunkRecorder.state === "recording") chunkRecorder.stop();
      }, 6000);
    };
    cycle();
  }

  function stopLiveChunks() {
    liveChunkActive.current = false;
    if (liveChunkTimer.current != null) window.clearTimeout(liveChunkTimer.current);
    liveChunkTimer.current = null;
    const current = liveRecorder.current;
    if (!current || current.state !== "recording") { liveStopPending.current = retryPendingLiveWrites(); return; }
    liveStopPending.current = new Promise<void>(resolve => {
      const original = current.onstop;
      current.onstop = async event => {
        if (original) await original.call(current, event);
        await liveTranscriptionQueue.current.catch(() => undefined);
        await retryPendingLiveWrites(); resolve();
      };
      current.stop();
    });
  }

  async function retryPendingLiveWrites() {
    await liveTranscriptionQueue.current.catch(() => undefined);
    for (let attempt = 0; pendingLiveSegments.current.length && attempt < 3; attempt += 1) {
      await new Promise(resolve => window.setTimeout(resolve, 350 * (attempt + 1)));
      try {
        const pending = [...pendingLiveSegments.current];
        const noteId = liveOwnerNoteId.current;
        if (!noteId) break;
        const saved = await command<Segment[]>("save_live_segments", { noteId, segments: pending, language: sessionLanguageRef.current });
        pendingLiveSegments.current.splice(0, pending.length);
        const ordered = saved.map(segment => ({ startMs: segment.startMs, endMs: segment.endMs, text: segment.text, language: segment.language }));
        liveSegmentsRef.current = ordered; setLiveSegments(ordered);
        if (selectedIdRef.current === noteId) setSegments(saved);
        setLiveTranscriptionMessage("Draft transcript saved · Full refinement is optional");
      } catch { /* preserve the recording; final transcription can recover these words */ }
    }
    if (pendingLiveSegments.current.length) setLiveTranscriptionMessage("Some live text could not be saved · Full recording is safe to transcribe");
  }

  function drainNativeAudioChunks(noteId: string | null, drainUntilEmpty = false): Promise<void> {
    if (!noteId || !isTauri() || !modelStatus?.installed) return Promise.resolve();
    const work = nativeAudioDrainQueue.current.catch(() => undefined).then(async () => {
      let chunks: NativeAudioChunk[] = [];
      do {
        chunks = await command<NativeAudioChunk[]>("drain_native_audio_chunks", { noteId });
        if (chunks.length > 2 && selectedIdRef.current === noteId) setLiveTranscriptionMessage(`Catching up on ${chunks.length} saved audio chunks · recording continues safely`);
        for (const chunk of chunks) {
          if (selectedIdRef.current === noteId) setLiveTranscriptionMessage(`Transcribing live audio · ${formatTime(chunk.offsetMs)}`);
          const result = await command<LiveSegment[]>("transcribe_live_chunk", { noteId, mimeType: chunk.mimeType, offsetMs: chunk.offsetMs, bytes: chunk.bytes, language: sessionLanguageRef.current, translate: transcriptionPreference?.translate || false });
          if (sessionLanguageRef.current === "auto" && result[0]?.language && result[0].language !== "auto") sessionLanguageRef.current = result[0].language;
          const saved = await persistLiveChunk(pendingLiveSegments.current, result, batch => command<Segment[]>("save_live_segments", { noteId, segments: batch, language: sessionLanguageRef.current }));
          await command("acknowledge_native_audio_chunk", { noteId, chunkId: chunk.id });
          const ordered = saved.map(segment => ({ startMs: segment.startMs, endMs: segment.endMs, text: segment.text, language: segment.language }));
          liveSegmentsRef.current = ordered; setLiveSegments(ordered);
          if (selectedIdRef.current === noteId) setSegments(saved);
          const transcript = saved.map(segment => `[${formatTime(segment.startMs)}] ${segment.text}`).join("\n");
          setNotes(current => current.map(note => note.id === noteId ? { ...note, transcript } : note));
          const latestEndMs = ordered.length ? ordered[ordered.length - 1].endMs : 0;
          const lagMs = Math.max(0, recordSecondsRef.current * 1000 - latestEndMs);
          setLiveTranscriptionMessage(lagMs > 12_000 ? `Catching up · ${Math.ceil(lagMs / 1000)} seconds behind · audio is queued safely` : "Live Mac audio · draft saved locally · microphone requires full refinement");
        }
      } while (drainUntilEmpty && chunks.length === 3);
    });
    nativeAudioDrainQueue.current = work.catch(error => {
      setLiveTranscriptionMessage(`Live transcription paused · audio is queued safely · ${String(error)}`);
    });
    return work;
  }

  async function toggleRecording() {
    if (captureTransition.current) return;
    if (!recording && nativeRecoveryRunning.current) { setNotice("MOCHI is finishing a saved live transcript. Try recording again when it is ready."); return; }
    const selected = notes.find(note => note.id === (recording ? liveOwnerNoteId.current : selectedId));
    if (!selected) return;
    captureTransition.current = true;
    setCaptureBusy(recording ? "stopping" : "starting");
    try {
    if (recording) {
      setShadowPhase("finalizing"); setShadowMessage("Saving the recording…"); setPanel("transcript");
      stopLiveChunks(); stopAudioMeter();
      if (activeCaptureMode.current === "meeting") {
        try {
          const result = await command<{ path: string; durationSecs: number; fileBytes: number; warning?: string | null }>("stop_native_capture", { noteId: selected.id });
          try { await drainNativeAudioChunks(selected.id, true); }
          catch (error) { setLiveTranscriptionMessage(`A live chunk remains queued · full-recording refinement will recover it: ${String(error)}`); }
          await liveStopPending.current;
          setCaptureStatus(await command<NativeCaptureStatus>("native_capture_status"));
          await refresh();
          setRecording(false);
          activeCaptureMode.current = null;
          setCaptureError(current => current?.noteId === selected.id ? { ...current, title: "Recording ended early · audio saved" } : current);
          if (result.warning) setCaptureError({ noteId: selected.id, title: "Recording saved with an audio source missing", detail: result.warning });
          else if (liveSegmentsRef.current.length) setCaptureError({ noteId: selected.id, title: "Live transcript covers Mac audio only", detail: "The microphone is in the saved recording, but not in the live transcript. Choose Refine full recording to transcribe both sides." });
          if (modelStatus?.installed) {
            setShadowPhase("ready"); setShadowMessage("Recording saved · Full refinement is optional");
            if (liveSegmentsRef.current.length) setPendingEnhancements(current => current.includes(selected.id) ? current : [...current, selected.id]);
            setNotice(result.warning || (liveSegmentsRef.current.length ? "Mac audio transcript saved. Refine full recording to include the microphone." : "Recording saved. Choose Refine full recording to transcribe it."));
          }
          else { setNotice("Recording saved. Install Whisper in Settings to transcribe it."); setShadowPhase("ready"); setShadowMessage("Recording saved locally"); }
        }
        catch (error) {
          const status = await command<NativeCaptureStatus>("native_capture_status").catch(() => null);
          if (status) setCaptureStatus(status);
          if (status?.active) {
            setRecording(true); setShadowPhase("listening"); setShadowMessage("Still recording · Try Stop again");
          } else {
            activeCaptureMode.current = null; setRecording(false); setShadowPhase("error"); setShadowMessage("Open the note for recording details");
          }
          setCaptureError({ noteId: selected.id, title: status?.active ? "Could not stop recording · try Stop again" : "Recording could not be saved", detail: String(error) });
          const interrupted = await command<InterruptedCapture[]>("list_interrupted_captures").catch(() => []);
          setInterruptedCapture(interrupted[0] || null);
        }
      } else { recorder.current?.stop(); await roomCompletion.current; }
      return;
    }
    try {
      setCaptureError(null);
      if (captureMode === "meeting") {
        if (!systemCaptureAvailable) {
          setCaptureHelpOpen(true);
          setNotice("This copy of MOCHI needs the system-audio build before it can record remote meetings.");
          return;
        }
        let status = captureStatus;
        if (!["granted", "audio_permission_unknown"].includes(status?.permission || "")) {
          status = await command<NativeCaptureStatus>("native_capture_status");
          setCaptureStatus(status);
          if (!["granted", "audio_permission_unknown"].includes(status.permission)) {
            setCaptureHelpOpen(true);
            setNotice(status.permission === "microphone_required" ? "Grant Microphone access, then reopen MOCHI." : "Recording access needs attention. Open setup for details.");
            return;
          }
        }
        shadowSession.current = true; liveStopPending.current = null; liveTranscriptionQueue.current = Promise.resolve();
        liveOwnerNoteId.current = selected.id;
        liveSegmentsRef.current = []; setLiveSegments([]); setShadowMessage(null); setShadowPhase("starting");
        setRecordSeconds(0);
        if (isTauri()) await command("show_shadow").catch(() => setNotice("Could not show the overlay. Recording controls are available here."));
        const started = await command<NativeCaptureStatus>("start_native_capture", { noteId: selected.id });
        setCaptureStatus(started);
        activeCaptureMode.current = "meeting";
        setShadowPhase("listening");
        startedAt.current = Date.now(); setRecordSeconds(0); setRecording(true);
        setPanel("transcript");
        setLiveTranscriptionMessage(null);
        sessionLanguageRef.current = transcriptionPreference?.language || "auto";
        setLiveTranscriptionMessage(modelStatus?.installed ? "Waiting for live Mac audio · microphone included in the full recording" : "Recording locally · Install Whisper to transcribe");
        if (modelStatus?.installed) {
          const sessionStartedAt = startedAt.current;
          void openMicrophone(10_000).then(stream => {
            if (activeCaptureMode.current !== "meeting" || startedAt.current !== sessionStartedAt || captureTransition.current) {
              stream.getTracks().forEach(track => track.stop()); return;
            }
            startAudioMeter(stream); meetingMicStream.current = stream;
          }).catch(() => setLiveTranscriptionMessage("System audio is recording · microphone meter unavailable"));
        }
        return;
      }
      shadowSession.current = true; liveStopPending.current = null; liveTranscriptionQueue.current = Promise.resolve();
      liveOwnerNoteId.current = selected.id;
      liveSegmentsRef.current = []; setLiveSegments([]); setShadowMessage(null); setShadowPhase("starting");
      setLiveTranscriptionMessage(null);
      const stream = await openMicrophone();
      meetingMicStream.current = stream;
      const mediaRecorder = new MediaRecorder(stream); const mimeType = mediaRecorder.mimeType || "audio/webm";
      if (isTauri()) await command("begin_recording", { noteId: selected.id, mimeType });
      recordingWrites.current = Promise.resolve();
      mediaRecorder.ondataavailable = event => { if (!event.data.size || !isTauri()) return; recordingWrites.current = recordingWrites.current.then(async () => command("append_recording_chunk", { noteId: selected.id, mimeType, bytes: Array.from(new Uint8Array(await event.data.arrayBuffer())) })); };
      let completeRoom: () => void = () => undefined;
      roomCompletion.current = new Promise<void>(resolve => { completeRoom = resolve; });
      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(track => track.stop()); const durationSecs = Math.max(1, Math.floor((Date.now() - startedAt.current) / 1000));
        try {
          let audioPath: string | undefined;
          if (isTauri()) { await recordingWrites.current; audioPath = await command<string>("finalize_recording", { noteId: selected.id, mimeType, durationSecs }); }
          setNotes(current => current.map(note => note.id === selected.id ? { ...note, durationSecs, ...(audioPath ? { audioPath } : {}) } : note)); setRecording(false);
          if (liveStopPending.current) await liveStopPending.current;
          if (selectedIdRef.current === selected.id) await loadNoteData(selected.id);
          if (isTauri() && modelStatus?.installed) {
            setShadowPhase("ready"); setShadowMessage("Recording saved · Full refinement is optional");
            if (liveSegmentsRef.current.length) setPendingEnhancements(current => current.includes(selected.id) ? current : [...current, selected.id]);
            else setNotice("Recording saved. Choose Refine full recording to transcribe it.");
          }
          else {
            setNotice(isTauri() ? "Recording saved. Install Whisper in Settings to transcribe it." : "Recording captured in this preview.");
            setShadowPhase("ready"); setShadowMessage("Recording saved locally");
          }
        }
        catch (error) { setCaptureError({ noteId: selected.id, title: "Recording could not be saved", detail: String(error) }); setShadowPhase("error"); setShadowMessage("Recording could not be finalized"); }
        finally { activeCaptureMode.current = null; setRecording(false); completeRoom(); }
      };
      recorder.current = mediaRecorder; activeCaptureMode.current = "room"; startedAt.current = Date.now(); setRecordSeconds(0); setRecording(true);
      setPanel("transcript");
      meetingMicStream.current = null;
      startAudioMeter(stream); mediaRecorder.start(1000); startLiveChunks(stream, selected.id, mimeType);
      setShadowPhase("listening");
      if (isTauri()) await command("show_shadow").catch(() => setNotice("Could not show the overlay. Recording controls are available here."));
    } catch (error) {
      activeCaptureMode.current = null; stopAudioMeter(); stopLiveChunks(); setRecording(false);
      setShadowPhase("error"); setShadowMessage("Recording did not start · Open the note for details");
      setCaptureError({ noteId: selected.id, title: "Recording did not start", detail: String(error) });
    }
    } finally { captureTransition.current = false; setCaptureBusy(null); }
  }

  toggleRecordingRef.current = toggleRecording;

  return <div className={`app-shell${recording ? " recording-session" : ""}`}>
    <div className="window-drag-region" data-tauri-drag-region />
    <aside className={`sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
      <div className="sidebar-brand-row"><button className="brand" onClick={() => { setSelectedId(null); setView("library"); }} aria-label="MOCHI home"><span className="mochi-mark"><i /></span>{!sidebarCollapsed && <span>mochi</span>}</button><button className="sidebar-collapse" aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"} title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={toggleSidebar}>{sidebarCollapsed ? <PanelLeftOpen size={16}/> : <PanelLeftClose size={16}/>}</button></div>
      <button className="new-note" title="New note · ⌘N" aria-label="New note" onClick={() => addNote()}><Plus size={16}/>{!sidebarCollapsed && <> New note <kbd>⌘ N</kbd></>}</button>
      <label className="search"><Search size={14}/>{!sidebarCollapsed && <input ref={searchInput} value={query} onChange={event => setQuery(event.target.value)} placeholder="Search notes" aria-label="Search notes"/>}{!sidebarCollapsed && <kbd>⌘ K</kbd>}</label>
      <nav className="sidebar-primary-nav">
        <button className={view === "library" ? "active" : ""} title="All notes" onClick={() => { setSelectedId(null); setView("library"); }}><Home size={15}/>{!sidebarCollapsed && <> All notes <span>{notes.length}</span></>}</button>
        {!sidebarCollapsed && <button className={view === "inbox" ? "active" : ""} title="Inbox" onClick={() => { setSelectedId(null); setView("inbox"); }}><Inbox size={15}/> Inbox <span>{inboxCount}</span></button>}
      </nav>
      {!sidebarCollapsed && <>
        <div className="sidebar-section-head"><span>Folders</span><button onClick={() => setProjectCreatorOpen(true)} aria-label="New folder"><Plus size={13}/><em>New</em></button></div>
        <div className="project-list sidebar-folders">{projects.map(project => <button key={project.id} title={project.name} className={view === "project" && activeProject === project.id ? "active" : ""} onClick={() => openFolder(project.id)}><i style={{ background: project.color }}/><span>{project.name}</span><small>{notes.filter(note => organizationFor(note.id).projectId === project.id && !organizationFor(note.id).archived).length}</small></button>)}</div>
        <div className="sidebar-section-head recent-head"><span>{view === "project" ? "Folder notes" : "Recent"}</span><span>{visibleNotes.length}</span></div>
        <div className="sidebar-recent">{visibleNotes.slice(0, 40).map(note => { const organization = organizationFor(note.id); return <button key={note.id} className={selectedId === note.id ? "active" : ""} onClick={() => openNote(note.id)}><strong>{note.title || "Untitled note"}</strong><span>{friendlyNoteText(note.summary || note.userNotes || note.transcript || "New note")}</span><small>{formatDay(note.updatedAt)}{note.durationSecs ? ` · ${formatDuration(note.durationSecs)}` : ""}{organization.projectId ? ` · ${projects.find(item => item.id === organization.projectId)?.name || "Folder"}` : ""}</small></button>; })}{visibleNotes.length === 0 && <p className="sidebar-empty">No notes yet</p>}</div>
      </>}
      <div className="sidebar-footer"><button title="Ask MOCHI" onClick={() => { setSelectedId(null); setView("ask"); }}><MessageCircle size={16}/>{!sidebarCollapsed && " Ask MOCHI"}</button>{!sidebarCollapsed && <details className="sidebar-more"><summary><MoreHorizontal size={16}/> More</summary><div><button onClick={() => { setSelectedId(null); setView("actions"); }}><Check size={14}/> Action items <span>{openActionCount}</span></button><button onClick={() => { setSelectedId(null); setView("templates"); }}><Pencil size={14}/> Recipes</button><button onClick={() => { setSelectedId(null); setView("archive"); }}><ArchiveIcon size={14}/> Archive</button></div></details>}<button title="Settings" onClick={() => setSettingsOpen(true)} aria-label="Settings"><Settings size={16}/>{!sidebarCollapsed && " Settings"}</button></div>
    </aside>

    <main className="main">
      <div className={selected ? "note-content" : "main-content"}>{selected ? <div key={selected.id} className="note-screen">
        <header className="topbar"><div className="breadcrumbs"><span>Notes</span><span>/</span><span>{selected.title}</span></div><div className="top-actions"><span className={`save-state ${saved ? "" : "saving"}`} title="Written notes saved">{saved ? <><Check size={12}/> Saved</> : "Saving…"}</span><RecordingControls mode={activeCaptureMode.current || captureMode} recording={recording} busy={captureBusy} seconds={recordSeconds} toggle={() => void toggleRecording()} showOverlay={isTauri() ? () => { void command("show_shadow").catch(error => setNotice(`Could not show overlay: ${error}`)); } : undefined}/><button className="top-delete" aria-label="Delete note" title="Delete note" disabled={recording || !!captureBusy} onClick={removeSelected}><Trash2 size={14}/><span>Delete</span></button><details className="note-menu"><summary role="button" aria-label="More note actions"><MoreHorizontal size={17}/></summary><div><button onClick={exportSelected}><Download size={14}/> Export note</button>{selectedOrganization && <button onClick={() => saveOrganization({ ...selectedOrganization, archived: !selectedOrganization.archived })}><ArchiveIcon size={14}/>{selectedOrganization.archived ? "Restore note" : "Archive note"}</button>}<button className="destructive" disabled={recording || !!captureBusy} onClick={removeSelected}><Trash2 size={14}/> Delete note</button></div></details></div></header>
        <section className="workspace">
          {captureError && <RecordingError title={captureError.title} detail={captureError.detail}/>}
          <div className="document-head"><div className="meta-line"><span>{new Date(selected.createdAt * 1000).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</span>{selectedOrganization && <Picker ariaLabel="Folder" icon={<Folder size={13}/>} value={selectedOrganization.projectId || ""} options={[{ value: "", label: "No folder" }, ...projects.map(project => ({ value: project.id, label: project.name, color: project.color }))]} onChange={projectId => saveOrganization({ ...selectedOrganization, projectId: projectId || null, reviewed: true })} footer={<button onClick={() => setProjectCreatorOpen(true)}><Plus size={13}/> New folder</button>}/>}</div>
            <input className="title-input" aria-label="Note title" value={selected.title} onChange={event => patchSelected({ title: event.target.value })}/>
            <details className="capture-options" open={captureExpanded || recording} onToggle={event => setCaptureExpanded(event.currentTarget.open)}><summary role="button" aria-label="Recording options"><span>{selected.audioPath && !recording ? `Recording saved · ${formatDuration(selected.durationSecs)}` : "Recording options"}</span><ChevronDown size={14}/></summary>{(captureExpanded || recording) && <div className="capture-dock">
              <div className="capture-modes" role="group" aria-label="Recording source">
                <button aria-label="Meeting — Mac audio and microphone" className={captureMode === "meeting" ? "active" : ""} aria-pressed={captureMode === "meeting"} disabled={recording || !!captureBusy} onClick={() => setCaptureMode("meeting")}><MonitorUp size={14}/><span>Meeting<small>Mac + mic</small></span>{captureMode === "meeting" && <Check className="source-check" size={13}/>}</button>
                <button aria-label="Room — microphone only" className={captureMode === "room" ? "active" : ""} aria-pressed={captureMode === "room"} disabled={recording || !!captureBusy} onClick={() => setCaptureMode("room")}><Mic size={14}/><span>Room<small>Microphone</small></span>{captureMode === "room" && <Check className="source-check" size={13}/>}</button>
                <button aria-label="Import audio or video" disabled={recording || !!captureBusy} onClick={importMedia}><Upload size={14}/><span>Import<small>Audio or video</small></span></button>
              </div>
              {!recording && selected.audioPath && <div className="record-row"><button className="audio-saved" onClick={() => setPanel("transcript")}><Check size={13}/>{isRefining ? `Draft saved · Refining ${activeTranscription?.progress || 0}%` : selected.transcript.trim() ? "Transcript ready" : "Audio saved"}<small>{formatDuration(selected.durationSecs)}</small></button></div>}
              {captureMode === "meeting" ? <div className={`capture-readiness ${meetingCaptureReady ? "ready" : "needs-setup"}`}><span><i/>{recording ? (captureStatus?.screenPermission ? (captureStatus.systemAudioLevel && captureStatus.systemAudioLevel > 0.001 ? "Mac audio detected · microphone on" : "Mac audio stream connected · waiting for sound") : "Waiting for Mac audio · check audio access") : meetingCaptureReady ? "Mac audio + microphone · macOS may ask for system-audio access" : captureStatus?.compiled ? "Microphone permission is required" : "System-audio capture is not included in this build"}</span>{!recording && !meetingCaptureReady && <button onClick={() => setCaptureHelpOpen(true)}>Set up</button>}{recording && <small>{captureStatus?.fileBytes ? `${(captureStatus.fileBytes / 1_000_000).toFixed(1)} MB saved` : "Starting local file…"}</small>}</div> : <div className="capture-readiness ready"><span><i/>Microphone only · Live transcript available with Whisper</span></div>}
            </div>}</details>
          </div>
        <div className="panel-transition" key={`${selected.id}-${panel}`}>{panel === "notes" ? <div className="notepad-view">
          <div className="notepad-controls">
            <div className="notepad-switch" role="group" aria-label="Note view">
              <button type="button" aria-pressed={!enhancedView} className={!enhancedView ? "active" : ""} onClick={() => setEnhancedView(false)}>My notes</button>
              <button type="button" aria-pressed={enhancedView} className={enhancedView ? "active" : ""} onClick={() => setEnhancedView(true)}>Enhanced</button>
            </div>
            <div className="notepad-actions">
              <details className="enhance-options"><summary>Enhancement options <ChevronDown size={13}/></summary><div className="enhance-options-fields"><label htmlFor="focus-instruction">What should MOCHI look for?</label><input id="focus-instruction" aria-label="What should MOCHI look for?" value={selected.focusInstruction || ""} onChange={event => patchSelected({ focusInstruction: event.target.value })} placeholder="e.g. Pull out the timeline and open questions"/><Picker ariaLabel="Enhancement recipe" value={selected.kind} options={templates.map(template => ({ value: template.id, label: template.name }))} onChange={kind => patchSelected({ kind })}/></div></details>
              <button className="enhance-button" disabled={!!processing || !!aiTask || !selected.transcript.trim()} onClick={() => { setEnhancedView(true); if (localAi?.running) void generateNotes(); else setSettingsOpen(true); }}><WandSparkles size={14}/>{processing === "generate" && aiTask?.noteId === selected.id ? "Enhancing…" : blocks.length ? "Refresh" : "Enhance"}</button>
            </div>
          </div>
          {enhancedView ? <section className="enhanced-canvas" aria-label="Enhanced notes">{processing === "generate" && aiTask?.noteId === selected.id ? <AiProgress key={aiTask.requestId} label="Enhancing from the transcript" stage={generationProgress?.stage} completed={generationProgress?.completed} total={generationProgress?.total} cancel={cancelAi}/> : blocks.length ? <EnhancedNotes blocks={blocks} segments={segments} onCitation={jumpToCitation} onEdit={saveEnhancedBlock}/> : <p className="enhanced-empty">{selected.transcript.trim() ? "Enhance this conversation to see MOCHI’s notes here." : selected.audioPath ? isRefining ? "Transcript is being refined locally. You can enhance it when it is ready." : "A transcript is needed before this note can be enhanced." : "Record or import a conversation to create enhanced notes."}</p>}</section> : <FriendlyNotesEditor value={friendlyNoteText(selected.userNotes)} onChange={value => patchSelected({ userNotes: value })}/>}
          <div className="notepad-footer"><details className="note-actions"><summary><WandSparkles size={13}/> Actions and recipes</summary><div>{agentRecipes.map(recipe => <button key={recipe.id} className="organize-button" disabled={agentBusy || !!aiTask || recording || !saved || (!selected.transcript.trim() && !selected.userNotes.trim()) || agentRuns.some(run => run.recipe === recipe.id && ["queued", "running", "proposed"].includes(run.status))} onClick={() => void startRecipe(recipe.id)} title={recipe.description}><WandSparkles size={14}/>{recipe.name}</button>)}<HarnessPanel runs={agentRuns} busy={agentBusy || !saved} recording={recording} onAction={reviewAgentRun}/></div></details><button className="transcript-link" type="button" onClick={() => setPanel("transcript")}>Transcript {selected.transcript.trim() ? "· ready to review" : selected.audioPath ? "· refining locally" : "· no audio yet"}</button><details className="note-ask-disclosure" open={noteAnswer ? true : undefined}><summary><MessageCircle size={14}/> Ask MOCHI about this meeting</summary><section className="note-ask" aria-label="Ask about this meeting"><form onSubmit={askThisNote}><MessageCircle size={15}/><input aria-label="Ask this meeting" value={noteQuestion} onChange={event => setNoteQuestion(event.target.value)} placeholder="Ask this meeting or find a detail…" disabled={!localAi?.running || !!aiTask}/><button type="submit" disabled={!noteQuestion.trim() || !localAi?.running || !!aiTask} aria-label="Ask MOCHI">{aiTask?.kind === "answer" && aiTask.noteId === selected.id ? "Working…" : "Ask"}</button></form>{aiTask?.kind === "answer" && aiTask.noteId === selected.id && <AiProgress label="Reading this meeting" cancel={cancelAi} />}{noteAnswer && <div className="note-answer" role="status"><p>{noteAnswer}</p><button type="button" className="text-button" onClick={() => setPanel("transcript")}>Open transcript evidence</button></div>}{!localAi?.running && <small>Start Qwen in Settings to ask questions privately.</small>}</section></details></div>
        </div> : <details className="transcript-disclosure" open onToggle={event => { if (!event.currentTarget.open) setPanel("notes"); }}><summary>Transcript{selected.transcript.trim() ? " · ready" : selected.audioPath ? " · audio saved, no transcript yet" : " · waiting for audio"}</summary><button type="button" className="transcript-close" onClick={() => setPanel("notes")} aria-label="Close transcript"><X size={14}/> Back to notes</button><section className="transcript-panel">{selected.audioPath && <AudioPlayer key={selected.audioPath} audioRef={audioRef} durationSecs={selected.durationSecs} onReady={() => setAudioError(false)} onError={() => setAudioError(true)} src={isTauri() ? convertFileSrc(selected.audioPath) : undefined}/>}{audioError && selected.audioPath && <div className="audio-error" role="alert"><span>Could not play this recording. Retry loading it or export the original audio.</span><button type="button" onClick={() => { setAudioError(false); audioRef.current?.load(); }}>Retry playback</button><button type="button" onClick={exportSelected}>Export recording</button></div>}{recording && <div className="live-capture-state" role="status"><i/><div><strong>{activeCaptureMode.current === "meeting" ? "Meeting recording · saving locally" : "Recording · saving locally"}</strong><small>{liveTranscriptionMessage || (activeCaptureMode.current === "meeting" ? "Live Mac-audio transcript · full refinement is optional." : "Transcript updates as you speak.")}</small></div><span>{formatDuration(recordSeconds)}</span></div>}<div className="section-title"><div><span className="label">Transcript</span><h2>Conversation</h2></div><div className="row-actions"><Picker ariaLabel="Transcript language" value={transcriptionPreference?.language || "auto"} options={transcriptionLanguages} onChange={setTranscriptLanguage}/><button className={`text-button ${transcriptionPreference?.translate ? "active" : ""}`} onClick={toggleTranscriptTranslation}>{transcriptionPreference?.translate ? "Translate: English" : "Keep original"}</button>{selected.audioPath && <button className="text-button" disabled={isRefining || !modelStatus?.installed} onClick={() => transcribeNote()}>{isRefining ? "Refining…" : "Refine full recording"}</button>} {segments.length > 1 && selected.audioPath && <button className="text-button" disabled={!!processing} onClick={diarizeNote}>{processing === "diarize" ? "Finding speakers…" : "Find speakers"}</button>}<button className="text-button" onClick={() => setRawTranscript(value => !value)}>{rawTranscript ? "Show segments" : "Edit text"}</button></div></div>
            {activeTranscription && <div className={`transcription-status status-${activeTranscription.status}`}><div><span>{activeTranscription.status === "completed" ? <Check size={14}/> : <i/>}</span><strong>{activeTranscription.stage}</strong><small>{activeTranscription.status === "running" ? `Your draft is saved and usable · ${activeTranscription.progress}%` : activeTranscription.status === "failed" ? "Your draft is safe. Retry when you’re ready." : activeTranscription.status === "cancelled" || activeTranscription.status === "paused" ? "Your draft transcript remains available." : "Saved locally"}</small></div>{activeTranscription.status === "running" && <button onClick={cancelRefinement}>Cancel</button>}{["failed","cancelled","paused"].includes(activeTranscription.status) && selected.audioPath && <button onClick={() => transcribeNote()}>Refine full recording</button>}<span style={{ width: `${activeTranscription.progress}%` }}/></div>}
            {selected.audioPath && !modelStatus?.installed && <p className="inline-note">Recording saved. Install Whisper in Settings when you want to refine this draft.</p>}
            {moments.length > 0 && <MomentsPanel moments={moments} jump={jumpToMoment} update={updateMoment} remove={removeMoment}/>} 
            {rawTranscript || !segments.length ? <textarea aria-label="Transcript" value={selected.transcript} readOnly={recording} onChange={event => patchSelected({ transcript: event.target.value })} placeholder={isRefining ? "Your first words will appear here while MOCHI refines the recording." : "Nothing recorded yet."}/> : <div className="segment-list">{segments.map(segment => <article id={`segment-${segment.id}`} key={segment.id} className={`${highlightedSegment === segment.id ? "highlighted" : ""} ${segment.overlap ? "overlap" : ""} ${segment.status === "draft" ? "draft" : ""} ${(segment.confidence ?? 1) < .55 ? "uncertain" : ""}`}><button className="timestamp" onClick={() => jumpToCitation(segment.id)}>{formatTime(segment.startMs)}</button><div><button className="speaker" onClick={() => renameSpeaker(segment.speaker)}>{segment.speaker}</button>{segment.status === "draft" && <span className="draft-flag">Draft</span>}{(segment.confidence ?? 1) < .55 && <span className="review-flag">Review</span>}{segment.overlap && <span className="review-flag">Possible overlap</span>}<button className="segment-moment" title="Save this transcript moment" onClick={() => createMomentFromSegment(segment)}><Bookmark size={11}/> Moment</button><p contentEditable={!recording} suppressContentEditableWarning onBlur={event => editTranscriptSegment(segment, event.currentTarget.textContent || "")}>{segment.text}</p></div></article>)}</div>}
          </section></details>}</div>
        </section>
      </div> : view === "actions" ? <ActionsView actions={actions} onOpen={openNote} onUpdate={updateAction} onCitation={jumpToCitation}/> : view === "ask" ? <AskView query={chatQuery} setQuery={setChatQuery} busy={chatBusy} answer={chatAnswer} ask={askLibrary} cancel={cancelAi} onCitation={(segmentId, noteId) => { setView("library"); jumpToCitation(segmentId, noteId); }} onOpenNote={(id, kind) => { setView("library"); openNote(id); setEnhancedView(kind === "enhanced_notes"); }}/>: view === "templates" ? <TemplatesView templates={templates} save={saveTemplate} remove={deleteTemplate}/> : <LibraryHome notes={visibleNotes} organizations={organizations} projects={projects} title={libraryTitle} description={libraryDescription} quiet={view === "library"} facets={view === "people" ? allPeople : view === "tags" ? allTags : undefined} activeFacet={activeFacet} setFacet={setActiveFacet} loading={loading} onNew={addNote} onOpen={openNote} onImport={importMedia}/>}</div>
    </main>

    {notice && <div className="toast"><span>{notice}</span><button aria-label="Dismiss message" onClick={() => setNotice(null)}><X size={14}/></button></div>}
    {!notice && interruptedCapture && <div className="toast recovery-toast"><span><strong>Interrupted meeting preserved</strong>{interruptedCapture.noteTitle} ended before MOCHI could finalize it.</span>{interruptedCapture.fileBytes > 0 && <button className="toast-action" onClick={() => void command("reveal_interrupted_capture", { id: interruptedCapture.id }).catch(error => setNotice(String(error)))}>Show file</button>}<button aria-label="Dismiss interrupted recording" onClick={() => { void command("dismiss_interrupted_capture", { id: interruptedCapture.id }).catch(error => setNotice(String(error))); setInterruptedCapture(null); }}><X size={14}/></button></div>}
    {commandOpen && <CommandPalette notes={notes} projects={projects} close={() => setCommandOpen(false)} chooseNote={id => { openNote(id); setCommandOpen(false); }} run={action => { setCommandOpen(false); if (action === "new") void addNote(); if (action === "home") { setSelectedId(null); setView("library"); } if (action === "inbox") { setSelectedId(null); setView("inbox"); } if (action === "actions") { setSelectedId(null); setView("actions"); } if (action === "ask") { setSelectedId(null); setView("ask"); } if (action === "record" && selected) void toggleRecording(); if (action === "settings") setSettingsOpen(true); }} chooseProject={id => { openFolder(id); setCommandOpen(false); }}/>} 
    {projectCreatorOpen && <ProjectCreator close={() => setProjectCreatorOpen(false)} create={createProject}/>} 
    {settingsOpen && <SettingsModal modelStatus={modelStatus} downloading={downloadingModel} progress={modelDownload} localAi={localAi} installingAi={installingAi} aiProgress={aiDownload} endpoint={modelEndpoint} model={modelName} setEndpoint={setModelEndpoint} setModel={setModelName} appearance={appearance} setAppearance={setAppearance} close={() => setSettingsOpen(false)} download={downloadModel} installAi={installLocalAi} backup={exportLibrary} restore={restoreLibrary}/>} 
    {captureHelpOpen && <CaptureSetupModal status={captureStatus} recheck={async () => { try { const status = await command<NativeCaptureStatus>("native_capture_status"); setCaptureStatus(status); if (["granted", "audio_permission_unknown"].includes(status.permission)) { setCaptureHelpOpen(false); setNotice("Recording access is ready."); } else setNotice("Microphone access is not ready. Allow MOCHI in Microphone settings, then reopen the app."); } catch (error) { setNotice(`Could not check recording access: ${error}`); } }} close={() => setCaptureHelpOpen(false)} request={async () => { try { const status = await command<NativeCaptureStatus>("request_native_capture_permission"); setCaptureStatus(status); if (["granted", "audio_permission_unknown"].includes(status.permission)) setCaptureHelpOpen(false); else setNotice("Microphone access requested. Return to MOCHI after granting it."); } catch (error) { setNotice(`Could not request capture access: ${error}`); } }} openSettings={async () => { try { await command("open_capture_settings"); } catch (error) { setNotice(`Could not open System Settings: ${error}`); } }} openMicrophoneSettings={async () => { try { await command("open_microphone_settings"); } catch (error) { setNotice(`Could not open Microphone settings: ${error}`); } }}/>} 
    {onboarding && <Onboarding close={() => { localStorage.setItem("mochi-onboarded", "yes"); setOnboarding(false); }}/>} 
  </div>;
}

function Picker({ ariaLabel, value, options, onChange, icon, footer }: { ariaLabel: string; value: string; options: Array<{ value: string; label: string; color?: string }>; onChange: (value: string) => void; icon?: ReactNode; footer?: ReactNode }) {
  const menu = useRef<HTMLDetailsElement | null>(null);
  const selected = options.find(option => option.value === value) || options[0];
  return <details ref={menu} className="mochi-picker"><summary role="button" aria-label={ariaLabel}>{icon}{selected?.color && <i style={{ background: selected.color }}/>}<span>{selected?.label || "Choose"}</span><ChevronDown size={13}/></summary><div className="picker-menu">{options.map(option => <button key={option.value || "empty"} className={option.value === value ? "active" : ""} onClick={() => { onChange(option.value); if (menu.current) menu.current.open = false; }}>{option.color && <i style={{ background: option.color }}/>}<span>{option.label}</span>{option.value === value && <Check size={13}/>}</button>)}{footer && <footer onClick={() => { if (menu.current) menu.current.open = false; }}>{footer}</footer>}</div></details>;
}

function ProjectCreator({ close, create }: { close: () => void; create: (name: string, color: string) => void }) {
  const colors = ["#B96B4E", "#A57943", "#657A69", "#6E7691", "#8A6881"];
  const [name, setName] = useState(""); const [color, setColor] = useState(colors[0]);
  return <div className="modal-backdrop" onMouseDown={close}><form className="project-creator" onMouseDown={event => event.stopPropagation()} onSubmit={event => { event.preventDefault(); if (name.trim()) create(name, color); }}><div className="modal-head"><div><span className="label">New folder</span><h2>Give related notes a home</h2></div><button type="button" onClick={close} aria-label="Close folder creator"><X size={17}/></button></div><p>Folders keep related notes together. You can move any note later.</p><label>Folder name<input autoFocus aria-label="Folder name" value={name} onChange={event => setName(event.target.value)} placeholder="Product launch" maxLength={64}/></label><fieldset><legend>Color</legend>{colors.map(option => <button type="button" key={option} className={color === option ? "active" : ""} style={{ background: option }} onClick={() => setColor(option)} aria-label={`Use folder color ${option}`}>{color === option && <Check size={14}/>}</button>)}</fieldset><div className="project-preview"><i style={{ background: color }}/><span>{name.trim() || "Folder name"}</span></div><footer><button type="button" className="secondary" onClick={close}>Cancel</button><button className="primary" disabled={!name.trim()}>Create folder</button></footer></form></div>;
}

function FriendlyNotesEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const editor = useRef<HTMLTextAreaElement | null>(null);
  const mirror = useRef<HTMLDivElement | null>(null);
  const [taskPositions, setTaskPositions] = useState<{ line: number; top: number }[]>([]);
  const [scrollTop, setScrollTop] = useState(0);
  const lines = value.split("\n");
  useLayoutEffect(() => {
    const input = editor.current, measure = mirror.current;
    if (!input || !measure) return;
    const update = () => {
      measure.style.width = `${input.clientWidth}px`;
      const positions = Array.from(measure.children).flatMap((node, index) => /^[☐☑]/.test(value.split("\n")[index] || "")
        ? [{ line: index, top: (node as HTMLElement).offsetTop }] : []);
      setTaskPositions(positions);
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(input);
    return () => observer?.disconnect();
  }, [value]);

  function toggleTask(index: number) {
    const next = value.split("\n");
    next[index] = next[index].replace(/^[☐☑]/, mark => mark === "☐" ? "☑" : "☐");
    onChange(next.join("\n"));
  }

  function replaceSelectedLines(kind: "bullet" | "number" | "check" | "heading") {
    const input = editor.current; if (!input) return;
    if (!value.trim()) return;
    const start = value.lastIndexOf("\n", Math.max(0, input.selectionStart - 1)) + 1;
    const nextBreak = value.indexOf("\n", input.selectionEnd);
    const end = nextBreak < 0 ? value.length : nextBreak;
    const lines = value.slice(start, end).split("\n");
    const clean = (line: string) => line.replace(/^\s*(?:•\s+|\d+\.\s+|[☐☑]\s+|#{1,6}\s+)/, "");
    const replacement = lines.map((line, index) => {
      const text = clean(line);
      if (kind === "bullet") return `• ${text}`;
      if (kind === "number") return `${index + 1}. ${text}`;
      if (kind === "check") return `${line.trimStart().startsWith("☐") ? "☑" : "☐"} ${text}`;
      return text || "Section title";
    }).join("\n");
    const next = `${value.slice(0, start)}${replacement}${value.slice(end)}`;
    onChange(next);
    requestAnimationFrame(() => { input.focus(); input.setSelectionRange(start, start + replacement.length); });
  }

  return <section className="friendly-editor" aria-label="My notes"><div className="format-toolbar" aria-label="Note formatting">
    <button type="button" title="Section heading" aria-label="Section heading" onClick={() => replaceSelectedLines("heading")}><Heading2 size={15}/></button>
    <button type="button" title="Bulleted list" aria-label="Bulleted list" onClick={() => replaceSelectedLines("bullet")}><List size={15}/></button>
    <button type="button" title="Numbered list" aria-label="Numbered list" onClick={() => replaceSelectedLines("number")}><ListOrdered size={15}/></button>
    <button type="button" title="Checklist" aria-label="Checklist" onClick={() => replaceSelectedLines("check")}><SquareCheckBig size={15}/></button>
  </div><div className="note-writing-surface">
    <div ref={mirror} className="note-line-mirror" aria-hidden="true">{lines.map((line, index) => <div key={index}>{line || "\u200b"}</div>)}</div>
    <textarea ref={editor} aria-label="Personal notes" value={value} onScroll={event => setScrollTop(event.currentTarget.scrollTop)} onChange={event => onChange(event.target.value)} placeholder=""/>
    <div className="note-check-controls">{taskPositions.map(({ line, top }) => <input key={line} type="checkbox" className="note-inline-check" style={{ top: top - scrollTop + 5 }} checked={lines[line]?.startsWith("☑") || false} aria-label={`${lines[line]?.slice(1).trim() || "Untitled task"}, line ${line + 1}`} onChange={() => toggleTask(line)}/>)}</div>
  </div></section>;
}

function MomentsPanel({ moments, jump, update, remove }: { moments: Moment[]; jump: (moment: Moment) => void; update: (moment: Moment, label: string) => void; remove: (moment: Moment) => void }) {
  const icon = (kind: Moment["kind"]) => kind === "Decision" ? <Flag size={13}/> : kind === "Action" ? <ListTodo size={13}/> : <Bookmark size={13}/>;
  return <section className="moments-panel"><header><span>Moments</span><small>{moments.length} marked</small></header><div>{moments.map(moment => <article key={moment.id} className={`moment-${moment.kind.toLowerCase()}`}><button className="moment-time" onClick={() => jump(moment)}>{formatTime(moment.timestampMs)}</button><span>{icon(moment.kind)}{moment.kind}</span><input aria-label={`${moment.kind} label at ${formatTime(moment.timestampMs)}`} defaultValue={moment.label} placeholder={moment.kind === "Decision" ? "What was decided?" : moment.kind === "Action" ? "What needs to happen?" : "Why save this point?"} onBlur={event => update(moment, event.target.value)}/><button className="moment-remove" aria-label={`Remove ${moment.kind} at ${formatTime(moment.timestampMs)}`} onClick={() => remove(moment)}><X size={13}/></button></article>)}</div></section>;
}

function CommandPalette({ notes, projects, close, chooseNote, chooseProject, run }: { notes: Note[]; projects: Project[]; close: () => void; chooseNote: (id: string) => void; chooseProject: (id: string) => void; run: (action: "new" | "home" | "inbox" | "actions" | "ask" | "record" | "settings") => void }) {
  const [value, setValue] = useState("");
  useEffect(() => { const handler = (event: KeyboardEvent) => { if (event.key === "Escape") close(); }; window.addEventListener("keydown", handler); return () => window.removeEventListener("keydown", handler); }, [close]);
  const query = value.trim().toLowerCase();
  const commands = [
    { id: "new" as const, label: "New note", hint: "⌘N", icon: <Plus size={15}/> },
    { id: "record" as const, label: "Start or stop recording", hint: "", icon: <Mic size={15}/> },
    { id: "home" as const, label: "Go to Home", hint: "", icon: <Home size={15}/> },
    { id: "inbox" as const, label: "Go to Inbox", hint: "", icon: <Inbox size={15}/> },
    { id: "actions" as const, label: "Open action items", hint: "", icon: <Check size={15}/> },
    { id: "ask" as const, label: "Ask MOCHI", hint: "", icon: <MessageCircle size={15}/> },
    { id: "settings" as const, label: "Open Settings", hint: "", icon: <Settings size={15}/> },
  ].filter(item => !query || item.label.toLowerCase().includes(query));
  const matchingNotes = notes.filter(note => !query || `${note.title} ${note.transcript} ${note.userNotes}`.toLowerCase().includes(query)).slice(0, 6);
  const matchingProjects = projects.filter(project => !query || project.name.toLowerCase().includes(query)).slice(0, 4);
  return <div className="command-backdrop" onMouseDown={close}><section className="command-palette" onMouseDown={event => event.stopPropagation()} aria-label="Command palette"><label><Search size={17}/><input autoFocus aria-label="Search commands and notes" value={value} onChange={event => setValue(event.target.value)} placeholder="Search notes or type a command…"/><kbd>esc</kbd></label><div className="command-results">{commands.length > 0 && <><small>Commands</small>{commands.map(command => <button key={command.id} onClick={() => run(command.id)}>{command.icon}<span>{command.label}</span><kbd>{command.hint}</kbd></button>)}</>}{matchingProjects.length > 0 && <><small>Projects</small>{matchingProjects.map(project => <button key={project.id} onClick={() => chooseProject(project.id)}><i className="project-dot" style={{ background: project.color }}/><span>{project.name}</span></button>)}</>}{matchingNotes.length > 0 && <><small>Notes</small>{matchingNotes.map(note => <button key={note.id} onClick={() => chooseNote(note.id)}><FileText size={15}/><span>{note.title}</span><em>{formatDay(note.updatedAt)}</em></button>)}</>}{commands.length + matchingNotes.length + matchingProjects.length === 0 && <div className="command-empty">No matching notes or commands.</div>}</div></section></div>;
}

function LibraryHome({ notes, organizations, projects, title, description, quiet, facets, activeFacet, setFacet, loading, onNew, onOpen, onImport }: { notes: Note[]; organizations: NoteOrganization[]; projects: Project[]; title: string; description: string; quiet: boolean; facets?: string[]; activeFacet: string | null; setFacet: (value: string | null) => void; loading: boolean; onNew: (kind?: string) => void; onOpen: (id: string) => void; onImport: () => void }) {
  if (quiet && notes.length > 0) return <div className="home-welcome"><div><span className="mochi-mark"><i/></span><h1>{title === "Home" ? "Your notes" : title}</h1><p>Choose a note from the sidebar, or start a new one.</p><div><button className="primary" onClick={() => onNew()}><Plus size={15}/> New note</button><button className="secondary" onClick={onImport}><Upload size={15}/> Import</button></div></div></div>;
  const emptyTitle = title === "Inbox" ? "Everything is filed" : title === "Archive" ? "Nothing archived" : title === "People" ? "No people connected yet" : title === "Tags" ? "No topics yet" : title !== "Home" && title !== "Meetings" ? `No notes in ${title} yet` : "Start your first conversation";
  const emptyCopy = title === "Inbox" ? "New and unreviewed notes will appear here." : title === "Archive" ? "Archived notes stay safely on this Mac." : title === "People" ? "Add people to a note or accept a filing suggestion." : title === "Tags" ? "Add a topic to a note to see it here." : "Record a conversation or import existing audio.";
  return <div className="library-home"><header className="library-heading"><div><h1>{title}</h1><p>{description}</p></div><div><button className="secondary" onClick={onImport}><Upload size={15}/> Import</button><button className="primary" onClick={() => onNew()}><Plus size={15}/> New note</button></div></header>{facets && facets.length > 0 && <div className="facet-strip"><button className={!activeFacet ? "active" : ""} onClick={() => setFacet(null)}>All</button>{facets.map(facet => <button key={facet} className={activeFacet === facet ? "active" : ""} onClick={() => setFacet(facet)}>{facet}</button>)}</div>}<section><div className="section-row"><h2>{title === "Home" ? "Recent" : title}</h2><span>{notes.length} notes</span></div>{loading ? <div className="empty-state">Opening your library…</div> : notes.length === 0 ? <div className="empty-state"><span className="mochi-mark"><i/></span><h3>{emptyTitle}</h3><p>{emptyCopy}</p>{title !== "Inbox" && title !== "Archive" && title !== "Home" && <div><button onClick={() => onNew()}><Plus size={14}/> New note</button></div>}</div> : <div className="recent-list">{notes.map(note => { const organization = organizations.find(item => item.noteId === note.id); const project = projects.find(project => project.id === organization?.projectId); return <button key={note.id} onClick={() => onOpen(note.id)}><div><strong>{note.title}</strong><p>{friendlyNoteText(note.summary || note.userNotes || note.transcript || "Empty note")}</p><div className="note-badges">{project && <span><i style={{ background: project.color }}/>{project.name}</span>}{organization?.people.slice(0, 2).map(person => <span key={person}>{person}</span>)}{organization?.tags.slice(0, 2).map(tag => <span key={tag}>#{tag}</span>)}</div></div><small>{formatDay(note.updatedAt)}{note.durationSecs ? ` · ${formatDuration(note.durationSecs)}` : ""}</small></button>; })}</div>}</section></div>;
}

function ActionsView({ actions, onOpen, onUpdate, onCitation }: { actions: ActionItem[]; onOpen: (id: string) => void; onUpdate: (action: ActionItem, patch: Partial<ActionItem>) => void; onCitation: (id: number, noteId: string) => void }) {
  const [filter, setFilter] = useState<"open" | "completed" | "all">("open");
  const shown = actions.filter(action => filter === "all" || action.status === filter);
  return <div className="collection-view"><header><div><h1>Action items</h1><p>Commitments collected from every meeting.</p></div><Picker ariaLabel="Action filter" value={filter} options={[{ value: "open", label: "Open" }, { value: "completed", label: "Completed" }, { value: "all", label: "All" }]} onChange={value => setFilter(value as typeof filter)}/></header>{shown.length === 0 ? <div className="empty-state"><h3>No {filter === "all" ? "" : filter} action items</h3></div> : <div className="action-table">{shown.map(action => <article key={action.id}><button className={`action-check ${action.status}`} onClick={() => onUpdate(action, { status: action.status === "open" ? "completed" : "open" })}><Check size={13}/></button><div className="action-body"><input aria-label="Action description" value={action.description} onChange={event => onUpdate(action, { description: event.target.value })}/><button className="source-link" onClick={() => onOpen(action.noteId)}>{action.noteTitle}</button><div className="action-fields"><input aria-label="Assignee" placeholder="Unassigned" value={action.assignee || ""} onChange={event => onUpdate(action, { assignee: event.target.value || null })}/><input aria-label="Due date" type="date" value={action.dueDate || ""} onChange={event => onUpdate(action, { dueDate: event.target.value || null })}/>{action.citationIds.map(id => <button key={id} className="citation" onClick={() => onCitation(id, action.noteId)}>{id}</button>)}</div></div></article>)}</div>}</div>;
}

function AskView({ query, setQuery, busy, answer, ask, cancel, onCitation, onOpenNote }: { query: string; setQuery: (value: string) => void; busy: boolean; answer: ChatAnswer | null; ask: () => void; cancel: () => void; onCitation: (id: number, noteId: string) => void; onOpenNote: (id: string, kind: string) => void }) {
  return <div className="ask-view"><header><h1>Ask your notes</h1><p>Search and answer from your meeting library.</p></header><form onSubmit={event => { event.preventDefault(); ask(); }}><input aria-label="Ask your notes" value={query} onChange={event => setQuery(event.target.value)} placeholder="What did I promise Alex last week?"/><button disabled={busy}>{busy ? "Searching…" : "Ask"}</button></form>{busy && <AiProgress label="Finding an answer in your notes" cancel={cancel}/>}{answer && <section className="answer"><p>{answer.answer}</p>{answer.sources.length > 0 && <h2>Sources</h2>}{answer.sources.map((source, index) => <button key={`${source.noteId}-${source.segmentId}-${index}`} onClick={() => source.segmentId != null ? onCitation(source.segmentId, source.noteId) : onOpenNote(source.noteId, source.kind)}><strong>{source.noteTitle}</strong><span>{source.kind === "transcript" ? `Transcript · ${source.startMs != null ? formatTime(source.startMs) : ""}${source.speaker ? ` · ${source.speaker}` : ""}` : source.kind === "personal_notes" ? "Your notes" : source.kind === "enhanced_notes" ? "Enhanced notes · AI-generated" : "Action items"}</span><p>{source.excerpt}</p></button>)}</section>}</div>;
}

function CaptureSetupModal({ status, close, request, recheck, openSettings, openMicrophoneSettings }: { status: NativeCaptureStatus | null; close: () => void; request: () => Promise<void>; recheck: () => Promise<void>; openSettings: () => Promise<unknown>; openMicrophoneSettings: () => Promise<unknown> }) {
  const included = !!status?.compiled;
  const permitted = ["granted", "audio_permission_unknown"].includes(status?.permission || "");
  // macOS has no reliable preflight for a Core Audio tap; permission is
  // confirmed only once its stream starts delivering samples.
  const screenReady = !!status?.screenPermission;
  const microphoneReady = !!status?.microphone;
  return <div className="modal-backdrop"><section className="capture-setup modal" aria-label="Meeting capture setup"><div className="modal-head"><div><span className="label">Meeting recording</span><h2>Hear both sides of the call</h2></div><button aria-label="Close meeting capture setup" onClick={close}><X size={16}/></button></div><p>Meeting mode records Mac audio and your microphone together, even while you wear headphones. The recording stays on this Mac.</p><div className="capture-checks"><div className={included ? "complete" : "blocked"}><span>{included ? <Check size={14}/> : "1"}</span><div><strong>System-audio build</strong><small>{included ? "Included in this copy of MOCHI" : "Not included in this copy. Install MOCHI's system-audio build to enable remote meetings."}</small></div></div><div className={screenReady ? "complete" : included ? "current" : "blocked"}><span>{screenReady ? <Check size={14}/> : "2"}</span><div><strong>System Audio Recording</strong><small>{screenReady ? "System audio stream is connected" : "macOS requests system-audio access when recording starts"}</small></div></div><div className={microphoneReady ? "complete" : included ? "current" : "blocked"}><span>{microphoneReady ? <Check size={14}/> : "3"}</span><div><strong>Microphone</strong><small>{microphoneReady ? "Access is ready" : "Allow MOCHI in Privacy &amp; Security → Microphone"}</small></div></div><div className={permitted ? "current" : "blocked"}><span>4</span><div><strong>Reopen MOCHI</strong><small>macOS may apply recording permissions after the app restarts.</small></div></div></div><p className="capture-permission-help">macOS requests system-audio access when recording starts. If access stops working after an update, reopen MOCHI and review its System Audio Recording setting.</p><footer><button className="secondary" onClick={close}>Not now</button>{included && !screenReady && <button className="secondary" onClick={() => void openSettings()}>Open Audio Settings</button>}{included && !microphoneReady && <button className="secondary" onClick={() => void openMicrophoneSettings()}>Open Microphone Settings</button>}<button className="secondary" disabled={!included} onClick={() => void recheck()}>Check access again</button><button className="primary" disabled={!included || permitted} onClick={() => void request()}>{permitted ? "Ready" : included ? "Request access" : "System build required"}</button></footer></section></div>;
}

function TemplatesView({ templates, save, remove }: { templates: Template[]; save: (template: Template) => void; remove: (template: Template) => void }) {
  const [editing, setEditing] = useState<Template | null>(null);
  return <div className="collection-view"><header><div><h1>Templates</h1><p>Choose what MOCHI listens for in each kind of meeting.</p></div><button className="primary" onClick={() => setEditing({ id: "", name: "New template", noteStructure: "Notes\n\nFollow-ups\n\n☐ ", summaryPrompt: "Summarize the important details.", isDefault: false })}><Plus size={15}/> New template</button></header><div className="template-list">{templates.map(template => <article key={template.id}><button onClick={() => setEditing({ ...template })}><strong>{template.name}</strong><p>{template.summaryPrompt}</p><span>{template.isDefault ? "Built in" : "Custom"}</span></button>{!template.isDefault && <button className="template-delete" aria-label={`Delete ${template.name}`} onClick={() => remove(template)}><Trash2 size={13}/></button>}</article>)}</div>{editing && <div className="inline-editor"><div className="modal-head"><h2>Edit template</h2><button onClick={() => setEditing(null)}><X size={16}/></button></div><label>Name<input value={editing.name} onChange={event => setEditing({ ...editing, name: event.target.value })}/></label><label>Starting note<textarea value={editing.noteStructure} onChange={event => setEditing({ ...editing, noteStructure: event.target.value })}/></label><label>Summary instructions<textarea value={editing.summaryPrompt} onChange={event => setEditing({ ...editing, summaryPrompt: event.target.value })}/></label><button className="primary" onClick={() => { save(editing); setEditing(null); }}>Save template</button></div>}</div>;
}

function SettingsModal(props: { modelStatus: ModelStatus | null; downloading: boolean; progress: ModelDownloadProgress | null; localAi: LocalAiStatus | null; installingAi: boolean; aiProgress: AiDownloadProgress | null; endpoint: string; model: string; setEndpoint: (value: string) => void; setModel: (value: string) => void; appearance: "system" | "light" | "dark"; setAppearance: (value: "system" | "light" | "dark") => void; close: () => void; download: () => void; installAi: () => void; backup: () => void; restore: () => void }) {
  return <div className="modal-backdrop" onMouseDown={props.close}><div className="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={event => event.stopPropagation()}>
    <div className="modal-head"><div><span className="label">Settings</span><h2 id="settings-title">Models, connections and data</h2></div><button aria-label="Close settings" onClick={props.close}><X size={17}/></button></div>
    <section className="privacy-setting"><h3>Privacy</h3><p>Recording, transcription, search, and local model requests run on this computer. MOCHI rejects model endpoints that are not on the loopback interface. Optional MCP sharing lets connected clients retrieve only the meeting content you explicitly grant.</p></section>
    <section className="appearance-setting"><label htmlFor="appearance-choice"><span><strong>Appearance</strong><small>Choose how the notebook looks on this Mac.</small></span><select id="appearance-choice" value={props.appearance} onChange={event => props.setAppearance(event.target.value as "system" | "light" | "dark")}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label></section>
    <section className="model-setting"><div><strong>Transcription · Whisper Small</strong><small>{props.modelStatus?.installed ? `Ready on this Mac · ${(props.modelStatus.sizeBytes / 1_000_000).toFixed(0)} MB` : "Turns recordings into searchable text · 488 MB"}</small></div>{props.modelStatus?.installed ? <span className="ready">Ready</span> : <button onClick={props.download} disabled={props.downloading}>{props.downloading ? `${props.progress?.percent || 0}%` : "Enable"}</button>}</section>
    {props.downloading && <div className="progress"><i style={{ width: `${props.progress?.percent || 0}%` }}/></div>}
    <section className="model-setting"><div><strong>Local intelligence · Qwen3 4B</strong><small>{props.localAi?.running ? "Ready for briefs, filing suggestions, and questions" : props.localAi?.installed ? "Installed locally · ready to start" : "Briefs, filing suggestions, and Ask MOCHI · 2.5 GB"}</small></div>{props.localAi?.running ? <span className="ready">Ready</span> : <button onClick={props.installAi} disabled={props.installingAi}>{props.installingAi ? `${props.aiProgress?.percent || 0}%` : props.localAi?.installed ? "Start" : "Enable"}</button>}</section>
    {props.installingAi && <div className="ai-progress"><div><span>{props.aiProgress?.component || "Preparing"}</span><span>{props.aiProgress?.totalBytes ? `${(props.aiProgress.downloadedBytes / 1_000_000_000).toFixed(1)} / ${(props.aiProgress.totalBytes / 1_000_000_000).toFixed(1)} GB` : ""}</span></div><div className="progress"><i style={{ width: `${props.aiProgress?.percent || 0}%` }}/></div></div>}
    <details className="advanced-settings"><summary>Advanced local endpoint</summary><label>Endpoint<input value={props.endpoint} onChange={event => props.setEndpoint(event.target.value)}/></label><label>Model name<input value={props.model} onChange={event => props.setModel(event.target.value)}/></label></details>
    <McpSettings request={command} desktop={isTauri()}/>
    <div className="data-actions"><button onClick={props.backup}><Download size={14}/> Back up library</button><button onClick={props.restore}><ArchiveRestore size={14}/> Restore backup</button></div>
    <div className="modal-footer"><button className="primary" onClick={() => { localStorage.setItem("mochi-endpoint", props.endpoint); localStorage.setItem("mochi-model", props.model); props.close(); }}>Save settings</button></div>
  </div></div>;
}

function Onboarding({ close }: { close: () => void }) {
  return <div className="modal-backdrop onboarding"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="welcome-title"><span className="mochi-mark large"><i/></span><h1 id="welcome-title">Welcome to mochi</h1><p>Record, transcribe, and search meetings without an account or subscription.</p><div className="onboarding-points"><div><strong>Your data stays here</strong><span>Recordings, transcripts, notes, and model processing stay on this computer. You control any optional sharing with connected apps.</span></div><div><strong>You can always leave</strong><span>Export Markdown, JSON, SRT, and original audio, or back up the complete SQLite library.</span></div><div><strong>Models are optional downloads</strong><span>Install Whisper and Qwen from Settings when you want transcription and generated notes.</span></div></div><button className="primary" onClick={close}>Get started</button></div></div>;
}

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    fs::OpenOptions,
    io::{Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex, atomic::{AtomicBool, AtomicI32, Ordering}},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use url::{Host, Url};
use uuid::Uuid;
#[cfg(target_os = "macos")]
use tauri_nspanel::{tauri_panel, WebviewWindowExt, StyleMask};

#[cfg(target_os = "macos")]
tauri_panel! {
    panel!(MochiOverlayPanel {
        config: { can_become_key_window: true, can_become_main_window: false, is_floating_panel: true }
    })
}

mod local_ai;
mod inference;
mod harness;
mod mcp;
pub use mcp::run_stdio_bridge;
use mcp::{McpManager,mcp_status,mcp_save_sharing,mcp_start,mcp_stop};
use harness::*;
mod macos_window;
mod native_capture;
mod round2;
mod transcription;
use local_ai::{LocalAiManager, *};
use inference::{InferenceManager, Task, cancel_local_ai_request};
use native_capture::{capture_partial_path, CaptureResult, CaptureStatus, NativeCaptureManager};
use round2::*;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Note {
    id: String,
    title: String,
    kind: String,
    transcript: String,
    user_notes: String,
    focus_instruction: String,
    summary: String,
    action_items: Vec<String>,
    audio_path: Option<String>,
    duration_secs: i64,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoteDraft {
    id: String,
    title: String,
    kind: String,
    transcript: String,
    user_notes: String,
    #[serde(default)]
    focus_instruction: String,
    summary: String,
    action_items: Vec<String>,
    duration_secs: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiRequest {
    request_id: Option<String>,
    endpoint: String,
    model: String,
    transcript: String,
    user_notes: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiveAssistRequest {
    request_id: Option<String>,
    endpoint: String,
    model: String,
    transcript: String,
    question: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Project {
    id: String,
    name: String,
    color: String,
    created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoteOrganization {
    note_id: String,
    project_id: Option<String>,
    tags: Vec<String>,
    people: Vec<String>,
    archived: bool,
    reviewed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Moment {
    id: String,
    note_id: String,
    kind: String,
    label: String,
    timestamp_ms: i64,
    created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibrarianProposal {
    title: String,
    #[serde(alias = "projectName", alias = "project_name")]
    folder_name: String,
    rationale: String,
    confidence: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppStatus {
    data_dir: String,
    database_path: String,
    network_policy: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InterruptedCapture {
    id: String,
    note_id: String,
    note_title: String,
    path: String,
    started_at: i64,
    file_bytes: u64,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelStatus {
    installed: bool,
    path: String,
    size_bytes: u64,
    display_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelDownloadProgress {
    downloaded_bytes: u64,
    total_bytes: u64,
    percent: u8,
}

#[derive(Default)]
struct ShadowWindowState {
    positioned: Mutex<bool>,
    active: Mutex<bool>,
}

#[derive(Default)]
struct TranscriptionManager {
    cancellations: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptionProgress {
    note_id: String,
    progress: i64,
    stage: String,
    status: String,
}

const WHISPER_MODEL_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/c521a4b02f422512d734391fdf08bb08c0862f68/ggml-small.bin";
const WHISPER_MODEL_SHA256: &str =
    "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Job {
    id: String,
    note_id: String,
    kind: String,
    status: String,
    error: Option<String>,
    progress: i64,
    stage: String,
    cancel_requested: bool,
    created_at: i64,
    updated_at: i64,
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn initialize_connection(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "PRAGMA journal_mode=WAL;
         PRAGMA foreign_keys=ON;
         CREATE TABLE IF NOT EXISTS notes (
           id TEXT PRIMARY KEY,
           title TEXT NOT NULL,
           kind TEXT NOT NULL DEFAULT 'meeting',
           transcript TEXT NOT NULL DEFAULT '',
           user_notes TEXT NOT NULL DEFAULT '',
           summary TEXT NOT NULL DEFAULT '',
           action_items_json TEXT NOT NULL DEFAULT '[]',
           audio_path TEXT,
           duration_secs INTEGER NOT NULL DEFAULT 0,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_notes_updated_at ON notes(updated_at DESC);
         CREATE TABLE IF NOT EXISTS jobs (
           id TEXT PRIMARY KEY,
           note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
           kind TEXT NOT NULL,
           status TEXT NOT NULL DEFAULT 'queued',
           error TEXT,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           UNIQUE(note_id, kind)
         );
         CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at);
         CREATE TABLE IF NOT EXISTS transcript_segments (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
           start_ms INTEGER NOT NULL,
           end_ms INTEGER NOT NULL,
           text TEXT NOT NULL,
           no_speech_probability REAL NOT NULL DEFAULT 0
         );
         CREATE INDEX IF NOT EXISTS idx_segments_note_time
           ON transcript_segments(note_id, start_ms);
         CREATE TABLE IF NOT EXISTS generated_blocks (
           id TEXT PRIMARY KEY,
           note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
           section TEXT NOT NULL,
           text TEXT NOT NULL,
           citation_ids_json TEXT NOT NULL DEFAULT '[]',
           ordinal INTEGER NOT NULL DEFAULT 0,
           created_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_generated_note
           ON generated_blocks(note_id, section, ordinal);
         CREATE TABLE IF NOT EXISTS action_items (
           id TEXT PRIMARY KEY,
           note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
           description TEXT NOT NULL,
           assignee TEXT,
           due_date TEXT,
           status TEXT NOT NULL DEFAULT 'open',
           citation_ids_json TEXT NOT NULL DEFAULT '[]',
           confidence REAL NOT NULL DEFAULT 0,
           user_edited INTEGER NOT NULL DEFAULT 0,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_actions_status ON action_items(status, due_date);
         CREATE TABLE IF NOT EXISTS projects (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL COLLATE NOCASE UNIQUE,
           color TEXT NOT NULL DEFAULT '#B96B4E',
           created_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS note_organization (
           note_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
           project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
           tags_json TEXT NOT NULL DEFAULT '[]',
           people_json TEXT NOT NULL DEFAULT '[]',
           archived INTEGER NOT NULL DEFAULT 0,
           reviewed INTEGER NOT NULL DEFAULT 0,
           updated_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_note_organization_project ON note_organization(project_id, archived);
         CREATE TABLE IF NOT EXISTS moments (
           id TEXT PRIMARY KEY,
           note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
           kind TEXT NOT NULL,
           label TEXT NOT NULL DEFAULT '',
           timestamp_ms INTEGER NOT NULL,
           created_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_moments_note_time ON moments(note_id, timestamp_ms);
         CREATE TABLE IF NOT EXISTS agent_runs (
           id TEXT PRIMARY KEY,
           note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
           recipe TEXT NOT NULL,
           status TEXT NOT NULL,
           proposal_json TEXT NOT NULL DEFAULT '{}',
           applied_tools_json TEXT NOT NULL DEFAULT '[]',
           error TEXT,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_agent_runs_note ON agent_runs(note_id, created_at DESC);
         CREATE TABLE IF NOT EXISTS note_templates (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL,
           note_structure TEXT NOT NULL,
           summary_prompt TEXT NOT NULL,
           is_default INTEGER NOT NULL DEFAULT 0,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS transcription_preferences (
           note_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
           language TEXT NOT NULL DEFAULT 'auto',
           translate INTEGER NOT NULL DEFAULT 0,
           updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS migration_backups (
           note_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
           user_notes TEXT NOT NULL,
           transcript TEXT NOT NULL,
           created_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS capture_sessions (
           id TEXT PRIMARY KEY,
           note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
           source TEXT NOT NULL,
           path TEXT NOT NULL,
           status TEXT NOT NULL,
           error TEXT,
           started_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_capture_sessions_status
           ON capture_sessions(status, updated_at DESC);
         INSERT OR IGNORE INTO note_templates VALUES
           ('meeting','General meeting','## Notes\n\n## Decisions\n\n## Follow-ups','Summarize key points, decisions, and explicit commitments.',1,0,0),
           ('oneOnOne','1:1','## Check-in\n\n## Wins\n\n## Challenges\n\n## Commitments','Focus on feedback, support, and mutual commitments.',1,0,0),
           ('standup','Stand-up','## Done\n\n## Next\n\n## Blockers','Focus on progress, next work, and blockers.',1,0,0),
           ('interview','Interview','## Evidence\n\n## Strengths\n\n## Concerns\n\n## Next step','Summarize evidence without making a hiring decision.',1,0,0),
           ('lecture','Lecture','## Main ideas\n\n## Definitions\n\n## Questions','Explain concepts, definitions, and examples.',1,0,0),
           ('customer','Sales call','## Context\n\n## Needs\n\n## Objections\n\n## Follow-up','Focus on customer needs, objections, and commitments.',1,0,0);
         UPDATE note_templates SET note_structure='Notes\n\nDecisions\n\nFollow-ups\n\n☐ ' WHERE id='meeting' AND is_default=1;
         UPDATE note_templates SET note_structure='Check-in\n\nWins\n\nChallenges\n\nCommitments\n\n☐ ' WHERE id='oneOnOne' AND is_default=1;
         UPDATE note_templates SET note_structure='Done\n\nNext\n\nBlockers' WHERE id='standup' AND is_default=1;
         UPDATE note_templates SET note_structure='Evidence\n\nStrengths\n\nConcerns\n\nNext step' WHERE id='interview' AND is_default=1;
         UPDATE note_templates SET note_structure='Main ideas\n\nDefinitions\n\nQuestions' WHERE id='lecture' AND is_default=1;
         UPDATE note_templates SET note_structure='Context\n\nNeeds\n\nObjections\n\nFollow-up\n\n☐ ' WHERE id='customer' AND is_default=1;
         INSERT OR IGNORE INTO migration_backups(note_id,user_notes,transcript,created_at)
           SELECT id,user_notes,transcript,0 FROM notes WHERE instr(user_notes,'## ') > 0;
         UPDATE notes SET user_notes=replace(user_notes,'## ','') WHERE instr(user_notes,'## ') > 0;
         CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
           note_id UNINDEXED, title, transcript, user_notes, summary, action_items,
           tokenize='unicode61 remove_diacritics 2'
         );
         CREATE TRIGGER IF NOT EXISTS notes_fts_insert AFTER INSERT ON notes BEGIN
           INSERT INTO notes_fts(note_id,title,transcript,user_notes,summary,action_items)
           VALUES(new.id,new.title,new.transcript,new.user_notes,new.summary,new.action_items_json);
         END;
         CREATE TRIGGER IF NOT EXISTS notes_fts_update AFTER UPDATE ON notes BEGIN
           DELETE FROM notes_fts WHERE note_id=old.id;
           INSERT INTO notes_fts(note_id,title,transcript,user_notes,summary,action_items)
           VALUES(new.id,new.title,new.transcript,new.user_notes,new.summary,new.action_items_json);
         END;
         CREATE TRIGGER IF NOT EXISTS notes_fts_delete AFTER DELETE ON notes BEGIN
           DELETE FROM notes_fts WHERE note_id=old.id;
         END;
         INSERT INTO notes_fts(note_id,title,transcript,user_notes,summary,action_items)
         SELECT n.id,n.title,n.transcript,n.user_notes,n.summary,n.action_items_json
         FROM notes n WHERE NOT EXISTS (SELECT 1 FROM notes_fts f WHERE f.note_id=n.id);",
        )
        .map_err(|e| e.to_string())?;
    ensure_column(
        connection,
        "notes",
        "focus_instruction",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    ensure_column(
        connection,
        "transcript_segments",
        "speaker",
        "TEXT NOT NULL DEFAULT 'Speaker 1'",
    )?;
    ensure_column(
        connection,
        "transcript_segments",
        "overlap",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(
        connection,
        "transcript_segments",
        "speaker_confidence",
        "REAL NOT NULL DEFAULT 0",
    )?;
    ensure_column(connection, "transcript_segments", "status", "TEXT NOT NULL DEFAULT 'final'")?;
    ensure_column(connection, "transcript_segments", "confidence", "REAL NOT NULL DEFAULT 1")?;
    ensure_column(connection, "transcript_segments", "language", "TEXT NOT NULL DEFAULT 'auto'")?;
    ensure_column(connection, "transcript_segments", "source", "TEXT NOT NULL DEFAULT 'legacy'")?;
    ensure_column(connection, "transcript_segments", "user_edited", "INTEGER NOT NULL DEFAULT 0")?;
    ensure_column(connection, "jobs", "progress", "INTEGER NOT NULL DEFAULT 0")?;
    ensure_column(connection, "jobs", "stage", "TEXT NOT NULL DEFAULT 'Queued'")?;
    ensure_column(connection, "jobs", "cancel_requested", "INTEGER NOT NULL DEFAULT 0")?;
    harness::initialize(connection)?;
    ensure_column(connection, "generated_blocks", "note_sources_json", "TEXT NOT NULL DEFAULT '[]'")?;
    mcp::initialize(connection)?;
    Ok(())
}

fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| error.to_string())?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())?;
    if !columns.iter().any(|existing| existing == column) {
        connection
            .execute(
                &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
                [],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn open_db(app: &AppHandle) -> Result<Connection, String> {
    let path = app_data_dir(app)?.join("mochi.sqlite3");
    let connection = Connection::open(path).map_err(|e| e.to_string())?;
    initialize_connection(&connection)?;
    Ok(connection)
}

fn recover_interrupted_jobs(connection: &Connection) -> Result<(), String> {
    connection.execute(
        "UPDATE jobs SET status='paused',stage='Refinement paused',error='MOCHI closed before refinement finished',updated_at=?1 WHERE status='running'",
        [now()],
    ).map(|_| ()).map_err(|error| error.to_string())
}

fn recover_interrupted_captures(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            "UPDATE capture_sessions SET status='interrupted',error='MOCHI closed before the recording was finalized',updated_at=?1 WHERE status IN ('preparing','recording')",
            [now()],
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn row_to_note(row: &rusqlite::Row<'_>) -> rusqlite::Result<Note> {
    let actions: String = row.get(6)?;
    Ok(Note {
        id: row.get(0)?,
        title: row.get(1)?,
        kind: row.get(2)?,
        transcript: row.get(3)?,
        user_notes: row.get(4)?,
        summary: row.get(5)?,
        action_items: serde_json::from_str(&actions).unwrap_or_default(),
        audio_path: row.get(7)?,
        duration_secs: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        focus_instruction: row.get(11)?,
    })
}

#[tauri::command]
fn list_notes(app: AppHandle, query: Option<String>) -> Result<Vec<Note>, String> {
    let connection = open_db(&app)?;
    list_notes_in(&connection, query)
}

fn list_notes_in(connection: &Connection, query: Option<String>) -> Result<Vec<Note>, String> {
    let query = query.unwrap_or_default();
    let (sql, parameter) = if query.trim().is_empty() {
        (
            "SELECT id,title,kind,transcript,user_notes,summary,action_items_json,audio_path,
                    duration_secs,created_at,updated_at,focus_instruction FROM notes ORDER BY updated_at DESC",
            None,
        )
    } else {
        (
            "SELECT n.id,n.title,n.kind,n.transcript,n.user_notes,n.summary,n.action_items_json,
                    n.audio_path,n.duration_secs,n.created_at,n.updated_at,n.focus_instruction
             FROM notes n JOIN notes_fts f ON f.note_id=n.id
             WHERE notes_fts MATCH ?1 ORDER BY n.updated_at DESC",
            Some(fts_query(&query)),
        )
    };
    let mut statement = connection.prepare(sql).map_err(|e| e.to_string())?;
    let rows = match parameter {
        Some(value) => statement.query_map([value], row_to_note),
        None => statement.query_map([], row_to_note),
    }
    .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

fn fts_query(query: &str) -> String {
    query
        .split_whitespace()
        .filter(|term| !term.is_empty())
        .map(|term| format!("\"{}\"*", term.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" AND ")
}

#[tauri::command]
fn create_note(app: AppHandle, kind: Option<String>, project_id: Option<String>) -> Result<Note, String> {
    let connection = open_db(&app)?;
    create_note_in_folder(&connection, kind, project_id)
}

fn create_note_in_folder(connection: &Connection, kind: Option<String>, project_id: Option<String>) -> Result<Note, String> {
    let transaction = connection.unchecked_transaction().map_err(|error| error.to_string())?;
    if let Some(id) = &project_id {
        let exists: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1)", [id], |row| row.get(0)).map_err(|error| error.to_string())?;
        if !exists { return Err("That folder no longer exists.".into()); }
    }
    let note = create_note_in(&transaction, kind)?;
    if let Some(id) = project_id {
        transaction.execute("UPDATE note_organization SET project_id=?2,reviewed=1 WHERE note_id=?1", params![&note.id, id]).map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(note)
}

fn create_note_in(connection: &Connection, kind: Option<String>) -> Result<Note, String> {
    let timestamp = now();
    let note = Note {
        id: Uuid::new_v4().to_string(),
        title: "Untitled note".into(),
        kind: kind.unwrap_or_else(|| "meeting".into()),
        transcript: String::new(),
        user_notes: String::new(),
        focus_instruction: String::new(),
        summary: String::new(),
        action_items: vec![],
        audio_path: None,
        duration_secs: 0,
        created_at: timestamp,
        updated_at: timestamp,
    };
    connection.execute(
        "INSERT INTO notes (id,title,kind,transcript,user_notes,summary,action_items_json,duration_secs,created_at,updated_at)
         VALUES (?1,?2,?3,'','','','[]',0,?4,?4)",
        params![note.id, note.title, note.kind, timestamp],
    ).map_err(|e| e.to_string())?;
    connection.execute(
        "INSERT INTO note_organization (note_id,updated_at) VALUES (?1,?2)",
        params![note.id, timestamp],
    ).map_err(|e| e.to_string())?;
    Ok(note)
}

#[tauri::command]
fn update_note(app: AppHandle, note: NoteDraft, edited_fields: Option<Vec<String>>) -> Result<Note, String> {
    let connection = open_db(&app)?;
    let Some(fields) = edited_fields else { return update_note_in(&connection, note); };
    // Autosaves must not overwrite transcript or generated content written by
    // another job while the user was typing.
    let changed = |field: &str| fields.iter().any(|value| value == field);
    connection.execute(
        "UPDATE notes SET title=CASE WHEN ?2 THEN ?3 ELSE title END,
         kind=CASE WHEN ?4 THEN ?5 ELSE kind END,
         transcript=CASE WHEN ?6 THEN ?7 ELSE transcript END,
         user_notes=CASE WHEN ?8 THEN ?9 ELSE user_notes END,
         focus_instruction=CASE WHEN ?10 THEN ?11 ELSE focus_instruction END,
         updated_at=?12 WHERE id=?1",
        params![note.id, changed("title"), note.title, changed("kind"), note.kind,
            changed("transcript"), note.transcript, changed("userNotes"), note.user_notes,
            changed("focusInstruction"), note.focus_instruction, now()],
    ).map_err(|error| error.to_string())?;
    get_note(&connection, &note.id)
}

fn update_note_in(connection: &Connection, note: NoteDraft) -> Result<Note, String> {
    let timestamp = now();
    let actions = serde_json::to_string(&note.action_items).map_err(|e| e.to_string())?;
    connection
        .execute(
            "UPDATE notes SET title=?2,kind=?3,transcript=?4,user_notes=?5,focus_instruction=?6,summary=?7,
          action_items_json=?8,duration_secs=?9,updated_at=?10 WHERE id=?1",
            params![
                note.id,
                note.title,
                note.kind,
                note.transcript,
                note.user_notes,
                note.focus_instruction,
                note.summary,
                actions,
                note.duration_secs,
                timestamp
            ],
        )
        .map_err(|e| e.to_string())?;
    get_note(&connection, &note.id)
}

fn get_note(connection: &Connection, id: &str) -> Result<Note, String> {
    connection
        .query_row(
            "SELECT id,title,kind,transcript,user_notes,summary,action_items_json,audio_path,
                duration_secs,created_at,updated_at,focus_instruction FROM notes WHERE id=?1",
            [id],
            row_to_note,
        )
        .map_err(|e| e.to_string())
}

fn clean_labels(values: Vec<String>, limit: usize) -> Vec<String> {
    let mut clean = Vec::new();
    for value in values {
        let label = value.trim().trim_start_matches('#').chars().take(48).collect::<String>();
        if label.is_empty() || clean.iter().any(|existing: &String| existing.eq_ignore_ascii_case(&label)) {
            continue;
        }
        clean.push(label);
        if clean.len() == limit { break; }
    }
    clean
}

#[tauri::command]
fn list_projects(app: AppHandle) -> Result<Vec<Project>, String> {
    let connection = open_db(&app)?;
    let mut statement = connection.prepare(
        "SELECT id,name,color,created_at FROM projects ORDER BY name COLLATE NOCASE"
    ).map_err(|error| error.to_string())?;
    let rows = statement.query_map([], |row| Ok(Project {
        id: row.get(0)?, name: row.get(1)?, color: row.get(2)?, created_at: row.get(3)?,
    })).map_err(|error| error.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|error| error.to_string())
}

#[tauri::command]
fn save_project(app: AppHandle, mut project: Project) -> Result<Project, String> {
    let connection = open_db(&app)?;
    project.name = project.name.trim().chars().take(64).collect();
    if project.name.is_empty() { return Err("Give the project a name.".into()); }
    if project.id.is_empty() { project.id = Uuid::new_v4().to_string(); }
    if project.color.is_empty() { project.color = "#B96B4E".into(); }
    if project.created_at == 0 { project.created_at = now(); }
    connection.execute(
        "INSERT INTO projects (id,name,color,created_at) VALUES (?1,?2,?3,?4)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name,color=excluded.color",
        params![project.id, project.name, project.color, project.created_at],
    ).map_err(|error| if error.to_string().contains("UNIQUE") { "A project with that name already exists.".into() } else { error.to_string() })?;
    Ok(project)
}

#[tauri::command]
fn list_note_organizations(app: AppHandle) -> Result<Vec<NoteOrganization>, String> {
    let connection = open_db(&app)?;
    connection.execute(
        "INSERT OR IGNORE INTO note_organization (note_id,updated_at) SELECT id,updated_at FROM notes",
        [],
    ).map_err(|error| error.to_string())?;
    let mut statement = connection.prepare(
        "SELECT note_id,project_id,tags_json,people_json,archived,reviewed FROM note_organization"
    ).map_err(|error| error.to_string())?;
    let rows = statement.query_map([], |row| {
        let tags: String = row.get(2)?;
        let people: String = row.get(3)?;
        Ok(NoteOrganization {
            note_id: row.get(0)?, project_id: row.get(1)?,
            tags: serde_json::from_str(&tags).unwrap_or_default(),
            people: serde_json::from_str(&people).unwrap_or_default(),
            archived: row.get::<_, i64>(4)? != 0,
            reviewed: row.get::<_, i64>(5)? != 0,
        })
    }).map_err(|error| error.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|error| error.to_string())
}

#[tauri::command]
fn save_note_organization(app: AppHandle, mut organization: NoteOrganization) -> Result<NoteOrganization, String> {
    Uuid::parse_str(&organization.note_id).map_err(|_| "Invalid note identifier".to_string())?;
    organization.tags = clean_labels(organization.tags, 8);
    organization.people = clean_labels(organization.people, 12);
    let connection = open_db(&app)?;
    get_note(&connection, &organization.note_id)?;
    if let Some(project_id) = &organization.project_id {
        let exists: i64 = connection.query_row("SELECT count(*) FROM projects WHERE id=?1", [project_id], |row| row.get(0)).map_err(|error| error.to_string())?;
        if exists == 0 { return Err("That project no longer exists.".into()); }
    }
    let tags = serde_json::to_string(&organization.tags).map_err(|error| error.to_string())?;
    let people = serde_json::to_string(&organization.people).map_err(|error| error.to_string())?;
    connection.execute(
        "INSERT INTO note_organization (note_id,project_id,tags_json,people_json,archived,reviewed,updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7)
         ON CONFLICT(note_id) DO UPDATE SET project_id=excluded.project_id,tags_json=excluded.tags_json,
           people_json=excluded.people_json,archived=excluded.archived,reviewed=excluded.reviewed,updated_at=excluded.updated_at",
        params![organization.note_id, organization.project_id, tags, people, organization.archived as i64, organization.reviewed as i64, now()],
    ).map_err(|error| error.to_string())?;
    Ok(organization)
}

fn row_to_moment(row: &rusqlite::Row<'_>) -> rusqlite::Result<Moment> {
    Ok(Moment { id: row.get(0)?, note_id: row.get(1)?, kind: row.get(2)?, label: row.get(3)?, timestamp_ms: row.get(4)?, created_at: row.get(5)? })
}

#[tauri::command]
fn list_moments(app: AppHandle, note_id: String) -> Result<Vec<Moment>, String> {
    let connection = open_db(&app)?;
    let mut statement = connection.prepare(
        "SELECT id,note_id,kind,label,timestamp_ms,created_at FROM moments WHERE note_id=?1 ORDER BY timestamp_ms,created_at"
    ).map_err(|error| error.to_string())?;
    let rows = statement.query_map([note_id], row_to_moment).map_err(|error| error.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|error| error.to_string())
}

#[tauri::command]
fn save_moment(app: AppHandle, mut moment: Moment) -> Result<Moment, String> {
    Uuid::parse_str(&moment.note_id).map_err(|_| "Invalid note identifier".to_string())?;
    let allowed = ["Decision", "Action", "Bookmark"];
    if !allowed.contains(&moment.kind.as_str()) { return Err("Unknown moment type.".into()); }
    moment.label = moment.label.trim().chars().take(160).collect();
    moment.timestamp_ms = moment.timestamp_ms.max(0);
    if moment.id.is_empty() { moment.id = Uuid::new_v4().to_string(); }
    if moment.created_at == 0 { moment.created_at = now(); }
    let connection = open_db(&app)?;
    get_note(&connection, &moment.note_id)?;
    connection.execute(
        "INSERT INTO moments (id,note_id,kind,label,timestamp_ms,created_at) VALUES (?1,?2,?3,?4,?5,?6)
         ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,label=excluded.label,timestamp_ms=excluded.timestamp_ms",
        params![moment.id, moment.note_id, moment.kind, moment.label, moment.timestamp_ms, moment.created_at],
    ).map_err(|error| error.to_string())?;
    Ok(moment)
}

#[tauri::command]
fn delete_moment(app: AppHandle, id: String) -> Result<(), String> {
    let connection = open_db(&app)?;
    connection.execute("DELETE FROM moments WHERE id=?1", [id]).map_err(|error| error.to_string())?;
    Ok(())
}

fn parse_librarian_proposal(raw: &str) -> Result<LibrarianProposal, String> {
    let trimmed = raw.trim();
    let json = if trimmed.starts_with("```") {
        trimmed.trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim()
    } else { trimmed };
    let mut proposal: LibrarianProposal = serde_json::from_str(json)
        .map_err(|error| format!("The Librarian returned invalid structured data: {error}"))?;
    proposal.title = proposal.title.trim().chars().take(120).collect();
    proposal.folder_name = proposal.folder_name.trim().chars().take(64).collect();
    proposal.rationale = proposal.rationale.trim().chars().take(320).collect();
    proposal.confidence = proposal.confidence.clamp(0.0, 1.0);
    if proposal.title.is_empty() { return Err("The Librarian did not suggest a title.".into()); }
    Ok(proposal)
}

fn enqueue_job_in(connection: &Connection, note_id: &str, kind: &str) -> Result<Job, String> {
    let timestamp = now();
    let id = Uuid::new_v4().to_string();
    connection
        .execute(
            "INSERT INTO jobs (id,note_id,kind,status,error,progress,stage,cancel_requested,created_at,updated_at)
         VALUES (?1,?2,?3,'queued',NULL,0,'Queued',0,?4,?4)
         ON CONFLICT(note_id,kind) DO UPDATE SET status='queued',error=NULL,progress=0,stage='Queued',cancel_requested=0,updated_at=?4",
            params![id, note_id, kind, timestamp],
        )
        .map_err(|e| e.to_string())?;
    connection.query_row(
        "SELECT id,note_id,kind,status,error,progress,stage,cancel_requested,created_at,updated_at FROM jobs WHERE note_id=?1 AND kind=?2",
        params![note_id, kind],
        row_to_job,
    ).map_err(|e| e.to_string())
}

fn row_to_job(row: &rusqlite::Row<'_>) -> rusqlite::Result<Job> {
    Ok(Job { id: row.get(0)?, note_id: row.get(1)?, kind: row.get(2)?, status: row.get(3)?, error: row.get(4)?, progress: row.get(5)?, stage: row.get(6)?, cancel_requested: row.get::<_, i64>(7)? != 0, created_at: row.get(8)?, updated_at: row.get(9)? })
}

#[tauri::command]
fn list_jobs(app: AppHandle, note_id: String) -> Result<Vec<Job>, String> {
    let connection = open_db(&app)?;
    let mut statement = connection.prepare(
        "SELECT id,note_id,kind,status,error,progress,stage,cancel_requested,created_at,updated_at FROM jobs WHERE note_id=?1 ORDER BY created_at"
    ).map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([note_id], row_to_job)
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_note(app: AppHandle, id: String) -> Result<(), String> {
    let connection = open_db(&app)?;
    let audio_path: Option<String> = connection
        .query_row("SELECT audio_path FROM notes WHERE id=?1", [&id], |row| {
            row.get(0)
        })
        .unwrap_or(None);
    let mut capture_statement = connection
        .prepare("SELECT path FROM capture_sessions WHERE note_id=?1")
        .map_err(|error| error.to_string())?;
    let capture_paths = capture_statement
        .query_map([&id], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())?;
    drop(capture_statement);
    connection
        .execute("DELETE FROM notes WHERE id=?1", [&id])
        .map_err(|e| e.to_string())?;
    if let Some(path) = audio_path {
        let _ = fs::remove_file(path);
    }
    let audio_dir = app_data_dir(&app)?.join("audio");
    for path in capture_paths {
        let path = PathBuf::from(path);
        if path.parent() == Some(audio_dir.as_path()) {
            let _ = fs::remove_file(path);
        }
    }
    Ok(())
}

fn safe_export_name(title: &str) -> String {
    let cleaned = title
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, ' ' | '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    let compact = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.is_empty() {
        "Untitled note".into()
    } else {
        compact
    }
}

#[tauri::command]
fn import_media(app: AppHandle, source_path: String) -> Result<Note, String> {
    let source = PathBuf::from(source_path);
    if !source.is_file() {
        return Err("Select an audio or video file to import.".into());
    }
    let extension = source
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .filter(|extension| {
            matches!(
                extension.as_str(),
                "wav" | "mp3" | "m4a" | "mp4" | "mov" | "webm" | "ogg" | "flac" | "aac"
            )
        })
        .ok_or_else(|| {
            "MOCHI supports WAV, MP3, M4A, MP4, MOV, WebM, OGG, FLAC, and AAC files.".to_string()
        })?;
    let connection = open_db(&app)?;
    let mut note = create_note_in(&connection, Some("meeting".into()))?;
    let audio_dir = app_data_dir(&app)?.join("audio");
    fs::create_dir_all(&audio_dir).map_err(|error| error.to_string())?;
    let destination = audio_dir.join(format!("{}.{}", note.id, extension));
    fs::copy(&source, &destination)
        .map_err(|error| format!("Could not copy the selected media: {error}"))?;
    note.title = source
        .file_stem()
        .and_then(|name| name.to_str())
        .map(safe_export_name)
        .unwrap_or_else(|| "Imported recording".into());
    note.audio_path = Some(destination.to_string_lossy().into_owned());
    note.updated_at = now();
    connection
        .execute(
            "UPDATE notes SET title=?2,audio_path=?3,updated_at=?4 WHERE id=?1",
            params![&note.id, &note.title, &note.audio_path, note.updated_at],
        )
        .map_err(|error| error.to_string())?;
    enqueue_job_in(&connection, &note.id, "transcribe")?;
    get_note(&connection, &note.id)
}

#[tauri::command]
fn export_note(app: AppHandle, id: String, destination: String) -> Result<String, String> {
    let connection = open_db(&app)?;
    let note = get_note(&connection, &id)?;
    let segments = round2::segments_in(&connection, &id)?;
    let generated_blocks = round2::blocks_in(&connection, &id)?;
    let structured_actions = round2::actions_in(&connection, Some(&id))?;
    let root = PathBuf::from(destination);
    if !root.is_dir() {
        return Err("Choose an existing folder for the export.".into());
    }
    let export_dir = root.join(format!(
        "MOCHI - {} - {}",
        safe_export_name(&note.title),
        &note.id[..8]
    ));
    fs::create_dir(&export_dir)
        .map_err(|error| format!("Could not create export folder: {error}"))?;
    let actions = if note.action_items.is_empty() {
        "- None recorded".to_string()
    } else {
        note.action_items
            .iter()
            .map(|action| format!("- {action}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let markdown = format!(
        "# {}\n\n- Type: {}\n- Created: {}\n- Duration: {} seconds\n\n## Your notes\n\n{}\n\n## Generated summary\n\n{}\n\n## Action items\n\n{}\n\n## Transcript\n\n{}\n",
        note.title, note.kind, note.created_at, note.duration_secs, note.user_notes,
        note.summary, actions, note.transcript
    );
    fs::write(export_dir.join("note.md"), markdown).map_err(|error| error.to_string())?;
    fs::write(
        export_dir.join("note.json"),
        serde_json::to_vec_pretty(&note).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    fs::write(export_dir.join("transcript.txt"), &note.transcript)
        .map_err(|error| error.to_string())?;
    let srt = segments
        .iter()
        .enumerate()
        .map(|(index, segment)| {
            format!(
                "{}\n{} --> {}\n{}: {}{}\n",
                index + 1,
                srt_timestamp(segment.start_ms),
                srt_timestamp(segment.end_ms),
                segment.speaker,
                segment.text,
                if segment.overlap {
                    " [possible overlap]"
                } else {
                    ""
                }
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(export_dir.join("transcript.srt"), srt).map_err(|error| error.to_string())?;
    fs::write(
        export_dir.join("evidence.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "segments": segments,
            "generatedBlocks": generated_blocks,
            "actionItems": structured_actions
        }))
        .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    if let Some(audio_path) = note.audio_path {
        let audio = PathBuf::from(audio_path);
        if audio.is_file() {
            let extension = audio
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("audio");
            fs::copy(&audio, export_dir.join(format!("recording.{extension}")))
                .map_err(|error| format!("Could not export the recording: {error}"))?;
        }
    }
    Ok(export_dir.to_string_lossy().into_owned())
}

fn srt_timestamp(milliseconds: i64) -> String {
    let value = milliseconds.max(0);
    let hours = value / 3_600_000;
    let minutes = (value / 60_000) % 60;
    let seconds = (value / 1_000) % 60;
    let millis = value % 1_000;
    format!("{hours:02}:{minutes:02}:{seconds:02},{millis:03}")
}

#[tauri::command]
fn export_library(app: AppHandle, destination: String) -> Result<String, String> {
    let root = PathBuf::from(destination);
    if !root.is_dir() {
        return Err("Choose an existing folder for the library export.".into());
    }
    let data_dir = app_data_dir(&app)?;
    let export_dir = root.join(format!("MOCHI library backup {}", now()));
    fs::create_dir(&export_dir)
        .map_err(|error| format!("Could not create backup folder: {error}"))?;
    let connection = open_db(&app)?;
    connection
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .map_err(|error| error.to_string())?;
    fs::copy(
        data_dir.join("mochi.sqlite3"),
        export_dir.join("mochi.sqlite3"),
    )
    .map_err(|error| format!("Could not copy the local library: {error}"))?;
    let source_audio_dir = data_dir.join("audio");
    if source_audio_dir.is_dir() {
        let destination_audio_dir = export_dir.join("audio");
        fs::create_dir(&destination_audio_dir).map_err(|error| error.to_string())?;
        for entry in fs::read_dir(source_audio_dir).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let source = entry.path();
            if source.is_file() {
                fs::copy(&source, destination_audio_dir.join(entry.file_name()))
                    .map_err(|error| format!("Could not copy a recording: {error}"))?;
            }
        }
    }
    fs::write(
        export_dir.join("README.txt"),
        "MOCHI portable local library backup\n\nOpen the SQLite file with a SQLite browser or restore it into MOCHI. The audio folder contains original local recordings. No cloud account is required.\n",
    )
    .map_err(|error| error.to_string())?;
    Ok(export_dir.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> Connection {
        let connection = Connection::open_in_memory().expect("open in-memory database");
        initialize_connection(&connection).expect("initialize schema");
        connection
    }

    #[test]
    fn new_notes_inherit_the_folder_and_invalid_folders_leave_no_orphan_notes() {
        let connection = memory_db();
        connection.execute("INSERT INTO projects(id,name,color,created_at) VALUES('folder-a','Work','#B96B4E',1)", []).unwrap();
        let note = create_note_in_folder(&connection, None, Some("folder-a".into())).unwrap();
        let membership: (String, bool) = connection.query_row("SELECT project_id,reviewed FROM note_organization WHERE note_id=?1", [&note.id], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
        assert_eq!(membership, ("folder-a".into(), true));
        assert!(create_note_in_folder(&connection, None, Some("missing-folder".into())).is_err());
        let count: i64 = connection.query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 1);
        let unfiled = create_note_in_folder(&connection, None, None).unwrap();
        let folder: Option<String> = connection.query_row("SELECT project_id FROM note_organization WHERE note_id=?1", [&unfiled.id], |row| row.get(0)).unwrap();
        assert!(folder.is_none());
    }

    #[test]
    fn focus_instruction_column_is_added_to_existing_libraries() {
        let connection = Connection::open_in_memory().expect("open legacy database");
        connection.execute_batch("CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL); INSERT INTO notes VALUES ('legacy', 'Old note');").unwrap();
        ensure_column(&connection, "notes", "focus_instruction", "TEXT NOT NULL DEFAULT ''").unwrap();
        let value: String = connection.query_row("SELECT focus_instruction FROM notes WHERE id='legacy'", [], |row| row.get(0)).unwrap();
        assert!(value.is_empty());
    }

    #[test]
    fn note_lifecycle_persists_and_searches_all_text_fields() {
        let connection = memory_db();
        let created = create_note_in(&connection, Some("lecture".into())).expect("create note");
        assert_eq!(created.kind, "lecture");

        let updated = update_note_in(
            &connection,
            NoteDraft {
                id: created.id.clone(),
                title: "Distributed systems".into(),
                kind: "lecture".into(),
                transcript: "Consensus requires a quorum.".into(),
                user_notes: "Review Raft".into(),
                focus_instruction: "Look for assumptions".into(),
                summary: "A lecture about consensus.".into(),
                action_items: vec!["Read the Raft paper".into()],
                duration_secs: 3600,
            },
        )
        .expect("update note");
        assert_eq!(updated.duration_secs, 3600);
        assert_eq!(updated.action_items, vec!["Read the Raft paper"]);
        assert_eq!(updated.focus_instruction, "Look for assumptions");

        let by_title =
            list_notes_in(&connection, Some("distributed".into())).expect("search title");
        let by_transcript =
            list_notes_in(&connection, Some("quorum".into())).expect("search transcript");
        let by_action =
            list_notes_in(&connection, Some("Raft paper".into())).expect("search action item");
        let missing = list_notes_in(&connection, Some("unrelated".into())).expect("search missing");
        assert_eq!(by_title.len(), 1);
        assert_eq!(by_transcript.len(), 1);
        assert_eq!(by_action.len(), 1);
        assert!(missing.is_empty());
    }

    #[test]
    fn editing_enhanced_blocks_updates_the_saved_copy_not_personal_notes() {
        let mut connection = memory_db();
        let note = create_note_in(&connection, Some("meeting".into())).expect("create note");
        update_note_in(&connection, NoteDraft {
            id: note.id.clone(), title: "Planning".into(), kind: "meeting".into(),
            transcript: "We will ship Friday.".into(), user_notes: "Keep my shorthand intact.".into(),
            focus_instruction: "Find the delivery date.".into(), summary: String::new(),
            action_items: vec![], duration_secs: 0,
        }).expect("set user notes");
        connection.execute(
            "INSERT INTO generated_blocks (id,note_id,section,text,citation_ids_json,ordinal,created_at) VALUES ('block-1',?1,'Summary','Original generated text','[17]',0,1)",
            [&note.id],
        ).expect("insert generated block");

        let saved = round2::update_generated_block_in(&mut connection, GeneratedBlock {
            id: "block-1".into(), note_id: note.id.clone(), section: "Summary".into(),
            text: "Edited enhanced note.".into(), citation_ids: vec![17], note_sources: vec![], ordinal: 0,
        }).expect("save edit");

        assert_eq!(saved.text, "Edited enhanced note.");
        assert_eq!(round2::blocks_in(&connection, &note.id).unwrap()[0].text, "Edited enhanced note.");
        let saved_note = get_note(&connection, &note.id).expect("read note");
        assert_eq!(saved_note.user_notes, "Keep my shorthand intact.");
        assert_eq!(saved_note.focus_instruction, "Find the delivery date.");
        assert!(saved_note.summary.contains("Edited enhanced note."));
    }

    #[test]
    fn startup_marks_unfinished_capture_sessions_as_interrupted() {
        let connection = memory_db();
        let note = create_note_in(&connection, Some("meeting".into())).expect("create note");
        connection
            .execute(
                "INSERT INTO capture_sessions(id,note_id,source,path,status,started_at,updated_at) VALUES('capture-1',?1,'system-and-microphone','/tmp/mochi.partial.mp4','recording',10,10)",
                [&note.id],
            )
            .expect("insert capture session");

        recover_interrupted_captures(&connection).expect("recover captures");

        let (status, error): (String, Option<String>) = connection
            .query_row(
                "SELECT status,error FROM capture_sessions WHERE id='capture-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read capture session");
        assert_eq!(status, "interrupted");
        assert!(error.unwrap_or_default().contains("before the recording was finalized"));
    }

    #[test]
    fn newest_updated_note_is_first() {
        let connection = memory_db();
        let first = create_note_in(&connection, None).expect("first note");
        let second = create_note_in(&connection, None).expect("second note");
        connection
            .execute("UPDATE notes SET updated_at=10 WHERE id=?1", [&first.id])
            .unwrap();
        connection
            .execute("UPDATE notes SET updated_at=20 WHERE id=?1", [&second.id])
            .unwrap();
        let notes = list_notes_in(&connection, None).expect("list notes");
        assert_eq!(notes[0].id, second.id);
    }

    #[test]
    fn recording_mime_types_map_to_safe_extensions() {
        assert_eq!(audio_extension("audio/mp4"), "m4a");
        assert_eq!(audio_extension("audio/ogg;codecs=opus"), "ogg");
        assert_eq!(audio_extension("audio/webm;codecs=opus"), "webm");
        assert_eq!(audio_extension("unexpected/value"), "webm");
    }

    #[test]
    fn transcription_job_is_idempotent_and_resumable() {
        let connection = memory_db();
        let note = create_note_in(&connection, None).expect("create note");
        let first = enqueue_job_in(&connection, &note.id, "transcribe").expect("queue job");
        connection
            .execute(
                "UPDATE jobs SET status='failed',error='worker stopped' WHERE id=?1",
                [&first.id],
            )
            .unwrap();
        let retried = enqueue_job_in(&connection, &note.id, "transcribe").expect("retry job");
        assert_eq!(retried.id, first.id);
        assert_eq!(retried.status, "queued");
        assert!(retried.error.is_none());
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM jobs", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn ai_endpoint_must_resolve_to_loopback() {
        assert!(validate_local_endpoint("http://127.0.0.1:8080/v1").is_ok());
        assert!(validate_local_endpoint("http://localhost:11434/v1").is_ok());
        assert!(validate_local_endpoint("http://[::1]:8080/v1").is_ok());
        assert!(validate_local_endpoint("https://example.com/v1").is_err());
        assert!(validate_local_endpoint("http://localhost:80@evil.example/v1").is_err());
    }

    #[test]
    fn export_names_cannot_escape_the_selected_folder() {
        assert_eq!(
            safe_export_name("../../confidential: notes"),
            "------confidential- notes"
        );
        assert_eq!(safe_export_name(""), "Untitled note");
    }

    #[test]
    fn librarian_proposals_are_bounded_deduplicated_and_clamped() {
        let raw = r##"```json
          {"title":"  Weekly product review  ","folderName":"  Product  ",
           "rationale":"  Discussed launch ownership.  ","confidence":1.7}
        ```"##;
        let proposal = parse_librarian_proposal(raw).expect("parse proposal");
        assert_eq!(proposal.title, "Weekly product review");
        assert_eq!(proposal.folder_name, "Product");
        assert_eq!(proposal.confidence, 1.0);
    }

    #[test]
    fn structured_moments_are_ordered_and_removed_with_their_note() {
        let connection = memory_db();
        let note = create_note_in(&connection, None).expect("create note");
        connection.execute(
            "INSERT INTO moments (id,note_id,kind,label,timestamp_ms,created_at) VALUES
             ('later',?1,'Action','Send recap',9000,2),('earlier',?1,'Decision','Ship Friday',3000,1)",
            [&note.id],
        ).unwrap();
        let mut statement = connection.prepare(
            "SELECT id,note_id,kind,label,timestamp_ms,created_at FROM moments WHERE note_id=?1 ORDER BY timestamp_ms"
        ).unwrap();
        let moments = statement.query_map([&note.id], row_to_moment).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
        assert_eq!(moments.iter().map(|moment| moment.id.as_str()).collect::<Vec<_>>(), vec!["earlier", "later"]);
        drop(statement);
        connection.execute("DELETE FROM notes WHERE id=?1", [&note.id]).unwrap();
        let remaining: i64 = connection.query_row("SELECT count(*) FROM moments", [], |row| row.get(0)).unwrap();
        assert_eq!(remaining, 0);
    }
}

#[tauri::command]
fn save_recording(
    app: AppHandle,
    note_id: String,
    bytes: Vec<u8>,
    mime_type: String,
) -> Result<String, String> {
    let extension = audio_extension(&mime_type);
    let audio_dir = app_data_dir(&app)?.join("audio");
    fs::create_dir_all(&audio_dir).map_err(|e| e.to_string())?;
    let path = audio_dir.join(format!("{}.{}", note_id, extension));
    fs::write(&path, bytes).map_err(|e| e.to_string())?;
    let connection = open_db(&app)?;
    connection
        .execute(
            "UPDATE notes SET audio_path=?2,updated_at=?3 WHERE id=?1",
            params![note_id, path.to_string_lossy(), now()],
        )
        .map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

fn audio_extension(mime_type: &str) -> &'static str {
    if mime_type.contains("caf") {
        "caf"
    } else if mime_type.contains("mp4") {
        "m4a"
    } else if mime_type.contains("ogg") {
        "ogg"
    } else {
        "webm"
    }
}

fn recording_path(
    app: &AppHandle,
    note_id: &str,
    mime_type: &str,
    partial: bool,
) -> Result<PathBuf, String> {
    Uuid::parse_str(note_id).map_err(|_| "Invalid note identifier".to_string())?;
    let audio_dir = app_data_dir(app)?.join("audio");
    fs::create_dir_all(&audio_dir).map_err(|e| e.to_string())?;
    let suffix = if partial { ".partial" } else { "" };
    Ok(audio_dir.join(format!(
        "{}.{}{}",
        note_id,
        audio_extension(mime_type),
        suffix
    )))
}

/// Finds the partial recording by note ID rather than re-deriving its extension.
/// WebKit can report an empty MIME type before `MediaRecorder.start()` and a
/// concrete one later, which previously made the finalization command look for
/// a different filename than the one created at the beginning of recording.
fn active_partial_recording_path(app: &AppHandle, note_id: &str) -> Result<PathBuf, String> {
    Uuid::parse_str(note_id).map_err(|_| "Invalid note identifier".to_string())?;
    let audio_dir = app_data_dir(app)?.join("audio");
    let prefix = format!("{note_id}.");
    let mut candidates = fs::read_dir(&audio_dir)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(&prefix) && name.ends_with(".partial"))
        });

    candidates.next().ok_or_else(|| {
        "The temporary recording file is missing. Start a new recording and try again.".to_string()
    })
}

#[tauri::command]
fn begin_recording(app: AppHandle, note_id: String, mime_type: String) -> Result<(), String> {
    let connection = open_db(&app)?;
    get_note(&connection, &note_id)?;
    let path = recording_path(&app, &note_id, &mime_type, true)?;
    fs::File::create(path)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn append_recording_chunk(
    app: AppHandle,
    note_id: String,
    _mime_type: String,
    bytes: Vec<u8>,
) -> Result<(), String> {
    let path = active_partial_recording_path(&app, &note_id)?;
    let mut file = OpenOptions::new()
        .create(false)
        .append(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.write_all(&bytes).map_err(|e| e.to_string())?;
    file.sync_data().map_err(|e| e.to_string())
}

#[tauri::command]
fn finalize_recording(
    app: AppHandle,
    note_id: String,
    _mime_type: String,
    duration_secs: i64,
) -> Result<String, String> {
    let partial = active_partial_recording_path(&app, &note_id)?;
    let file_name = partial
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "The temporary recording filename is invalid".to_string())?;
    let final_name = file_name
        .strip_suffix(".partial")
        .ok_or_else(|| "The temporary recording filename is invalid".to_string())?;
    let final_path = partial.with_file_name(final_name);
    fs::rename(partial, &final_path).map_err(|e| e.to_string())?;
    let connection = open_db(&app)?;
    connection
        .execute(
            "UPDATE notes SET audio_path=?2,duration_secs=?3,updated_at=?4 WHERE id=?1",
            params![
                &note_id,
                final_path.to_string_lossy(),
                duration_secs.max(0),
                now()
            ],
        )
        .map_err(|e| e.to_string())?;
    enqueue_job_in(&connection, &note_id, "transcribe")?;
    connection.execute("UPDATE jobs SET status='paused',stage='Full refinement is optional' WHERE note_id=?1 AND kind='transcribe'", [&note_id]).map_err(|error| error.to_string())?;
    Ok(final_path.to_string_lossy().into_owned())
}

#[tauri::command]
async fn start_native_capture(app: AppHandle, note_id: String) -> Result<CaptureStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        start_native_capture_blocking(app.clone(), app.state::<NativeCaptureManager>(), note_id)
    }).await.map_err(|error| format!("Recording startup failed: {error}"))?
}

fn start_native_capture_blocking(
    app: AppHandle,
    state: tauri::State<'_, NativeCaptureManager>,
    note_id: String,
) -> Result<CaptureStatus, String> {
    Uuid::parse_str(&note_id).map_err(|_| "Invalid note identifier".to_string())?;
    let connection = open_db(&app)?;
    get_note(&connection, &note_id)?;
    let audio_dir = app_data_dir(&app)?.join("audio");
    fs::create_dir_all(&audio_dir).map_err(|error| error.to_string())?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis() as i64;
    let path = capture_partial_path(&audio_dir, &note_id, timestamp);
    let session_id = Uuid::new_v4().to_string();
    let chunk_directory = audio_dir.join("live-chunks").join(&session_id);
    connection
        .execute(
            "INSERT INTO capture_sessions(id,note_id,source,path,status,error,started_at,updated_at) VALUES(?1,?2,'system-and-microphone',?3,'preparing',NULL,?4,?4)",
            params![&session_id, &note_id, path.to_string_lossy(), now()],
        )
        .map_err(|error| format!("Could not prepare the local capture ledger: {error}"))?;
    match state.start(&note_id, &path, &chunk_directory) {
        Ok(status) => {
            if let Err(error) = connection.execute(
                "UPDATE capture_sessions SET status='recording',updated_at=?2 WHERE id=?1",
                params![&session_id, now()],
            ) {
                let stopped = state.stop(&note_id).ok();
                if let Some(result) = stopped.as_ref() {
                    let _ = connection.execute(
                        "UPDATE capture_sessions SET status='interrupted',path=?2,error=?3,updated_at=?4 WHERE id=?1",
                        params![&session_id, result.path.to_string_lossy(), "The recording was stopped because its local ledger could not be updated", now()],
                    );
                }
                return Err(format!("The recording was stopped safely because its local ledger could not be updated: {error}"));
            }
            Ok(status)
        }
        Err(error) => {
            let separate_file_exists = [".system.caf", ".microphone.caf"].iter().any(|suffix| fs::metadata(format!("{}{}", path.display(), suffix)).map(|metadata| metadata.len() > 0).unwrap_or(false));
            let _ = connection.execute(
                "UPDATE capture_sessions SET status=?4,error=?2,updated_at=?3 WHERE id=?1",
                params![&session_id, &error, now(), if separate_file_exists { "interrupted" } else { "failed" }],
            );
            Err(error)
        }
    }
}

#[tauri::command]
fn drain_native_audio_chunks(
    app: AppHandle,
    state: tauri::State<'_, NativeCaptureManager>,
    note_id: String,
) -> Result<Vec<native_capture::NativeAudioChunk>, String> {
    Uuid::parse_str(&note_id).map_err(|_| "Invalid note identifier".to_string())?;
    let connection = open_db(&app)?;
    let session_id: String = connection.query_row("SELECT id FROM capture_sessions WHERE note_id=?1 ORDER BY started_at DESC LIMIT 1", [&note_id], |row| row.get(0)).map_err(|_| "No saved meeting audio session was found.".to_string())?;
    let directory = app_data_dir(&app)?.join("audio").join("live-chunks").join(session_id);
    state.register_chunk_directory(&note_id, &directory)?;
    state.drain_chunks(&note_id)
}

#[tauri::command]
fn list_pending_native_audio_notes(app: AppHandle) -> Result<Vec<String>, String> {
    let connection = open_db(&app)?;
    let mut query = connection.prepare("SELECT note_id,id FROM capture_sessions c WHERE status='finalized' AND id=(SELECT id FROM capture_sessions WHERE note_id=c.note_id ORDER BY started_at DESC LIMIT 1)").map_err(|error| error.to_string())?;
    let rows = query.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).map_err(|error| error.to_string())?;
    let audio = app_data_dir(&app)?.join("audio").join("live-chunks");
    let mut pending = Vec::new();
    for row in rows {
        let (note, session) = row.map_err(|error| error.to_string())?;
        if Uuid::parse_str(&session).is_err() || Uuid::parse_str(&note).is_err() { continue; }
        if fs::read_dir(audio.join(session)).ok().into_iter().flatten().filter_map(Result::ok).any(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            name.starts_with("audio-system-") && !name.contains(".partial.") && (name.ends_with(".caf") || name.ends_with(".m4a"))
        }) { pending.push(note); }
    }
    Ok(pending)
}

#[tauri::command]
fn acknowledge_native_audio_chunk(
    app: AppHandle,
    state: tauri::State<'_, NativeCaptureManager>,
    note_id: String,
    chunk_id: String,
) -> Result<(), String> {
    Uuid::parse_str(&note_id).map_err(|_| "Invalid note identifier".to_string())?;
    let connection = open_db(&app)?;
    let session_id: String = connection.query_row("SELECT id FROM capture_sessions WHERE note_id=?1 ORDER BY started_at DESC LIMIT 1", [&note_id], |row| row.get(0)).map_err(|_| "No saved meeting audio session was found.".to_string())?;
    let directory = app_data_dir(&app)?.join("audio").join("live-chunks").join(session_id);
    state.register_chunk_directory(&note_id, &directory)?;
    state.acknowledge_chunk(&note_id, &chunk_id)
}

#[tauri::command]
async fn stop_native_capture(app: AppHandle, note_id: String) -> Result<CaptureResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        stop_native_capture_blocking(app.clone(), app.state::<NativeCaptureManager>(), note_id)
    }).await.map_err(|error| format!("Recording finalization failed: {error}"))?
}

fn stop_native_capture_blocking(
    app: AppHandle,
    state: tauri::State<'_, NativeCaptureManager>,
    note_id: String,
) -> Result<CaptureResult, String> {
    let result = match state.stop(&note_id) {
        Ok(result) => result,
        Err(error) => {
            if !state.status().active {
                let connection = open_db(&app)?;
                connection.execute(
                    "UPDATE capture_sessions SET status='interrupted',error=?2,updated_at=?3 WHERE note_id=?1 AND status='recording'",
                    params![&note_id, &error, now()],
                ).map_err(|ledger_error| format!("{error} Capture ledger: {ledger_error}"))?;
            }
            return Err(error);
        }
    };
    let connection = open_db(&app)?;
    connection
        .execute(
            "UPDATE capture_sessions SET status='interrupted',path=?2,error='The recording was finalized but has not yet been attached to its note',updated_at=?3 WHERE id=(SELECT id FROM capture_sessions WHERE note_id=?1 AND status IN ('recording','interrupted') ORDER BY started_at DESC LIMIT 1)",
            params![&note_id, result.path.to_string_lossy(), now()],
        )
        .map_err(|error| format!("The recording was saved at {}, but its capture ledger could not be updated: {error}", result.path.display()))?;
    connection
        .execute(
            "UPDATE notes SET audio_path=?2,duration_secs=?3,updated_at=?4 WHERE id=?1",
            params![
                &note_id,
                result.path.to_string_lossy(),
                result.duration_secs,
                now()
            ],
        )
        .map_err(|error| error.to_string())?;
    enqueue_job_in(&connection, &note_id, "transcribe")?;
    connection.execute("UPDATE jobs SET status='paused',stage='Full refinement is optional' WHERE note_id=?1 AND kind='transcribe'", [&note_id]).map_err(|error| error.to_string())?;
    connection
        .execute(
            "UPDATE capture_sessions SET status='finalized',path=?2,error=NULL,updated_at=?3 WHERE id=(SELECT id FROM capture_sessions WHERE note_id=?1 AND status='interrupted' ORDER BY started_at DESC LIMIT 1)",
            params![&note_id, result.path.to_string_lossy(), now()],
        )
        .map_err(|error| format!("The recording was saved, but its capture ledger could not be finalized: {error}"))?;
    // The original audio tracks remain available until the combined file is
    // attached and its ledger is finalized. Only then remove these sidecars.
    if let Some(final_path) = result.path.to_str().and_then(|path| path.strip_suffix(".mp4")) {
        for source in ["system", "microphone"] {
            let _ = fs::remove_file(format!("{final_path}.partial.mp4.{source}.caf"));
        }
    }
    Ok(result)
}

#[tauri::command]
fn list_interrupted_captures(app: AppHandle) -> Result<Vec<InterruptedCapture>, String> {
    let connection = open_db(&app)?;
    let mut statement = connection
        .prepare(
            "SELECT c.id,c.note_id,n.title,c.path,c.started_at,c.error
             FROM capture_sessions c JOIN notes n ON n.id=c.note_id
             WHERE c.status='interrupted' ORDER BY c.updated_at DESC",
        )
        .map_err(|error| error.to_string())?;
    let captures = statement
        .query_map([], |row| {
            let original: String = row.get(3)?;
            let path = available_capture_file(&original);
            let file_bytes = fs::metadata(&path).map(|metadata| metadata.len()).unwrap_or(0);
            Ok(InterruptedCapture {
                id: row.get(0)?,
                note_id: row.get(1)?,
                note_title: row.get(2)?,
                path,
                started_at: row.get(4)?,
                file_bytes,
                error: row.get(5)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())?;
    Ok(captures
        .into_iter()
        .filter(|capture| capture.file_bytes > 0)
        .collect())
}

fn available_capture_file(path: &str) -> String {
    if fs::metadata(path).map(|metadata| metadata.len() > 0).unwrap_or(false) { return path.to_owned(); }
    for suffix in [".system.caf", ".microphone.caf"] {
        let candidate = format!("{path}{suffix}");
        if fs::metadata(&candidate).map(|metadata| metadata.len() > 0).unwrap_or(false) { return candidate; }
    }
    path.to_owned()
}

#[tauri::command]
fn reveal_interrupted_capture(app: AppHandle, id: String) -> Result<(), String> {
    let connection = open_db(&app)?;
    let path: String = connection
        .query_row(
            "SELECT path FROM capture_sessions WHERE id=?1 AND status='interrupted'",
            [&id],
            |row| row.get(0),
        )
        .map_err(|_| "That interrupted recording is no longer available.".to_string())?;
    let candidate = PathBuf::from(available_capture_file(&path));
    let audio_dir = app_data_dir(&app)?.join("audio");
    if candidate.parent() != Some(audio_dir.as_path()) {
        return Err("The interrupted recording path is outside MOCHI's audio folder.".into());
    }
    if !candidate.exists() {
        return Err("The interrupted recording file is no longer on disk.".into());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&candidate)
            .spawn()
            .map_err(|error| format!("Could not reveal the recording in Finder: {error}"))?;
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    Err("Revealing interrupted captures is currently available only on macOS.".into())
}

#[tauri::command]
fn dismiss_interrupted_capture(app: AppHandle, id: String) -> Result<(), String> {
    let connection = open_db(&app)?;
    connection
        .execute(
            "UPDATE capture_sessions SET status='dismissed',updated_at=?2 WHERE id=?1 AND status='interrupted'",
            params![id, now()],
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn native_capture_available() -> bool {
    native_capture::is_available()
}

#[tauri::command]
fn native_capture_status(state: tauri::State<'_, NativeCaptureManager>) -> CaptureStatus {
    state.status()
}

#[tauri::command]
fn request_native_capture_permission(
    state: tauri::State<'_, NativeCaptureManager>,
) -> CaptureStatus {
    let _ = native_capture::request_permission();
    state.status()
}

#[tauri::command]
fn open_capture_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
            .spawn()
            .map_err(|error| format!("Could not open System Settings: {error}"))?;
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    Err("System-audio capture settings are currently available only on macOS.".into())
}

#[tauri::command]
fn open_microphone_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
            .spawn()
            .map_err(|error| format!("Could not open Microphone settings: {error}"))?;
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    Err("Microphone settings are currently available only on macOS.".into())
}

#[tauri::command]
async fn transcribe_live_chunk(
    app: AppHandle,
    note_id: String,
    mime_type: String,
    offset_ms: i64,
    bytes: Vec<u8>,
    language: Option<String>,
    translate: Option<bool>,
) -> Result<Vec<transcription::TranscriptSegment>, String> {
    Uuid::parse_str(&note_id).map_err(|_| "Invalid note identifier".to_string())?;
    if bytes.is_empty() || bytes.len() > 16 * 1024 * 1024 {
        return Err("The live audio chunk is empty or too large.".into());
    }
    let model_path = whisper_model_path(&app)?;
    if fs::metadata(&model_path).map(|meta| meta.len()).unwrap_or(0) < 400_000_000 {
        return Err("Install Whisper in Settings to see live transcription.".into());
    }
    let live_dir = app_data_dir(&app)?.join("live-transcription");
    fs::create_dir_all(&live_dir).map_err(|error| error.to_string())?;
    let audio_path = live_dir.join(format!(
        "{}-{}.{}",
        note_id,
        Uuid::new_v4(),
        audio_extension(&mime_type)
    ));
    fs::write(&audio_path, bytes).map_err(|error| error.to_string())?;
    let language = language.filter(|value| !value.trim().is_empty()).unwrap_or_else(|| open_db(&app).ok().and_then(|connection| connection.query_row("SELECT language FROM transcription_preferences WHERE note_id=?1", [&note_id], |row| row.get(0)).ok()).unwrap_or_else(|| "auto".into()));
    let worker_path = audio_path.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        transcription::transcribe_live_configured(&model_path, &worker_path, Some(&language), translate.unwrap_or(false))
    })
    .await
    .map_err(|error| format!("Live transcription stopped: {error}"))?;
    let _ = fs::remove_file(&audio_path);
    result.map(|mut segments| {
        for segment in &mut segments {
            segment.start_ms += offset_ms.max(0);
            segment.end_ms += offset_ms.max(0);
        }
        segments
    })
}

#[tauri::command]
fn show_shadow(app: AppHandle, state: tauri::State<'_, ShadowWindowState>) -> Result<(), String> {
    let window = app
        .get_webview_window("shadow")
        .ok_or_else(|| "The meeting overlay is unavailable.".to_string())?;
    *state.active.lock().map_err(|_| "Could not activate the meeting overlay.".to_string())? = true;
    window
        .set_size(LogicalSize::new(368.0, 72.0))
        .map_err(|error| error.to_string())?;
    let mut positioned = state.positioned.lock().map_err(|_| "Could not restore the overlay position.".to_string())?;
    if !*positioned {
        macos_window::position_overlay(&window)?;
        *positioned = true;
    }
    macos_window::show_overlay(&window)
}

#[tauri::command]
fn set_shadow_expanded(app: AppHandle, expanded: bool) -> Result<(), String> {
    let window = app
        .get_webview_window("shadow")
        .ok_or_else(|| "The meeting overlay is unavailable.".to_string())?;
    let old_size = window.outer_size().map_err(|error| error.to_string())?;
    let old_position = window.outer_position().map_err(|error| error.to_string())?;
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let (width, height) = if expanded { (520.0, 388.0) } else { (368.0, 72.0) };
    let new_width = (width * scale) as i32;
    let new_x = old_position.x + (old_size.width as i32 - new_width) / 2;
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|error| error.to_string())?;
    window
        .set_position(PhysicalPosition::new(new_x, old_position.y))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn hide_shadow(app: AppHandle) -> Result<(), String> {
    app.get_webview_window("shadow")
        .ok_or_else(|| "The meeting overlay is unavailable.".to_string())?
        .hide()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn show_main(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "The MOCHI library window is unavailable.".to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[tauri::command]
fn start_shadow_drag(window: tauri::WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|error| error.to_string())
}

fn whisper_model_path(app: &AppHandle) -> Result<PathBuf, String> {
    let models_dir = app_data_dir(app)?.join("models");
    fs::create_dir_all(&models_dir).map_err(|error| error.to_string())?;
    Ok(models_dir.join("ggml-small.bin"))
}

#[tauri::command]
fn transcription_model_status(app: AppHandle) -> Result<ModelStatus, String> {
    let path = whisper_model_path(&app)?;
    let size_bytes = fs::metadata(&path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    Ok(ModelStatus {
        installed: size_bytes > 400_000_000,
        path: path.to_string_lossy().into_owned(),
        size_bytes,
        display_name: "Whisper Small Multilingual".into(),
    })
}

#[tauri::command]
async fn download_transcription_model(app: AppHandle) -> Result<ModelStatus, String> {
    use futures_util::StreamExt;

    let final_path = whisper_model_path(&app)?;
    let partial_path = final_path.with_extension("bin.partial");
    let mut existing = fs::metadata(&partial_path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let client = reqwest::Client::new();
    let mut request = client.get(WHISPER_MODEL_URL);
    if existing > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={existing}-"));
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("Could not start the model download: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Model host returned {}", response.status()));
    }
    let resumed = response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    if existing > 0 && !resumed {
        existing = 0;
    }
    let total = existing + response.content_length().unwrap_or(0);
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .append(resumed)
        .truncate(!resumed)
        .open(&partial_path)
        .map_err(|error| format!("Could not create the model file: {error}"))?;
    let mut downloaded = existing;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("Model download was interrupted: {error}"))?;
        file.write_all(&chunk)
            .map_err(|error| format!("Could not save the model: {error}"))?;
        downloaded += chunk.len() as u64;
        let percent = if total == 0 {
            0
        } else {
            ((downloaded.saturating_mul(100) / total).min(100)) as u8
        };
        let _ = app.emit(
            "model-download-progress",
            ModelDownloadProgress {
                downloaded_bytes: downloaded,
                total_bytes: total,
                percent,
            },
        );
    }
    file.sync_all()
        .map_err(|error| format!("Could not finalize the model file: {error}"))?;
    drop(file);

    let verification_path = partial_path.clone();
    let digest = tauri::async_runtime::spawn_blocking(move || hash_file(&verification_path))
        .await
        .map_err(|error| format!("Model verifier stopped: {error}"))??;
    if digest != WHISPER_MODEL_SHA256 {
        return Err("The downloaded model failed its SHA-256 integrity check. The partial file was kept so the download can be retried.".into());
    }
    fs::rename(&partial_path, &final_path)
        .map_err(|error| format!("Could not activate the model: {error}"))?;
    transcription_model_status(app)
}

fn hash_file(path: &std::path::Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[tauri::command]
async fn run_transcription_job(app: AppHandle, manager: tauri::State<'_, TranscriptionManager>, note_id: String) -> Result<Note, String> {
    Uuid::parse_str(&note_id).map_err(|_| "Invalid note identifier".to_string())?;
    let cancellation = Arc::new(AtomicBool::new(false));
    manager.cancellations.lock().map_err(|_| "Transcription control is unavailable.".to_string())?.insert(note_id.clone(), cancellation.clone());
    let manager_note_id = note_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let emit_progress = |progress: i64, stage: &str, status: &str| {
            let _ = app.emit("transcription-progress", TranscriptionProgress { note_id: note_id.clone(), progress, stage: stage.into(), status: status.into() });
        };
        let model_path = whisper_model_path(&app)?;
        if !model_path.exists() { return Err("Install the free Whisper Small model in Settings before transcribing.".into()); }
        let mut connection = open_db(&app)?;
        let note = get_note(&connection, &note_id)?;
        let audio_path = note.audio_path.as_deref().map(PathBuf::from).ok_or_else(|| "This note does not have a local recording.".to_string())?;
        enqueue_job_in(&connection, &note_id, "transcribe")?;
        connection.execute(
            "UPDATE jobs SET status='running',error=NULL,progress=2,stage='Preparing audio',cancel_requested=0,updated_at=?2 WHERE note_id=?1 AND kind='transcribe'",
            params![&note_id, now()],
        ).map_err(|error| error.to_string())?;
        emit_progress(2, "Preparing audio", "running");
        let (language, translate): (String, bool) = connection.query_row("SELECT language,translate FROM transcription_preferences WHERE note_id=?1", [&note_id], |row| Ok((row.get(0)?, row.get::<_,i64>(1)? != 0))).unwrap_or_else(|_| ("auto".into(), false));
        let progress_app = app.clone();
        let progress_note = note_id.clone();
        let progress_db = app_data_dir(&app)?.join("mochi.sqlite3");
        let last_persisted = Arc::new(AtomicI32::new(-10));
        let progress_last = last_persisted.clone();
        let progress_callback: Box<dyn FnMut(i32) + Send> = Box::new(move |percent| {
            let scaled = 8 + percent.clamp(0, 100) as i64 * 82 / 100;
            let _ = progress_app.emit("transcription-progress", TranscriptionProgress { note_id: progress_note.clone(), progress: scaled, stage: "Refining transcript".into(), status: "running".into() });
            let previous = progress_last.load(Ordering::Relaxed);
            if scaled as i32 - previous >= 5 {
                progress_last.store(scaled as i32, Ordering::Relaxed);
                if let Ok(connection) = Connection::open(&progress_db) { let _ = connection.execute("UPDATE jobs SET progress=?2,stage='Refining transcript',updated_at=?3 WHERE note_id=?1 AND kind='transcribe'", params![&progress_note, scaled, now()]); }
            }
        });
        let abort_flag = cancellation.clone();
        let abort_callback: Box<dyn FnMut() -> bool + Send> = Box::new(move || abort_flag.load(Ordering::Relaxed));
        let segments = match transcription::transcribe_configured(&model_path, &audio_path, Some(&language), translate, Some(progress_callback), Some(abort_callback)) {
            Ok(segments) => segments,
            Err(error) => {
                let cancelled = cancellation.load(Ordering::Relaxed);
                connection.execute(
                    "UPDATE jobs SET status=?2,error=?3,stage=?4,updated_at=?5 WHERE note_id=?1 AND kind='transcribe'",
                    params![&note_id, if cancelled { "cancelled" } else { "failed" }, if cancelled { None::<String> } else { Some(error.clone()) }, if cancelled { "Refinement cancelled" } else { "Refinement needs attention" }, now()],
                ).map_err(|database_error| database_error.to_string())?;
                emit_progress(0, if cancelled { "Draft saved · Refinement cancelled" } else { "Draft saved · Refinement needs attention" }, if cancelled { "cancelled" } else { "failed" });
                return if cancelled { Err("Refinement cancelled. Your draft transcript is saved.".into()) } else { Err(error) };
            }
        };
        emit_progress(92, "Saving refined segments", "running");
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        transaction.execute("DELETE FROM transcript_segments WHERE note_id=?1 AND user_edited=0", [&note_id]).map_err(|error| error.to_string())?;
        for segment in &segments {
            transaction.execute(
                "INSERT INTO transcript_segments (note_id,start_ms,end_ms,text,no_speech_probability,speaker,overlap,speaker_confidence,status,confidence,language,source,user_edited)
                 VALUES (?1,?2,?3,?4,?5,'Speaker 1',0,0,'final',?6,?7,'refined',0)",
                params![&note_id, segment.start_ms, segment.end_ms, &segment.text, segment.no_speech_probability, (1.0-segment.no_speech_probability).clamp(0.0,1.0), &segment.language],
            ).map_err(|error| error.to_string())?;
        }
        transaction.execute(
            "UPDATE jobs SET status='completed',error=NULL,progress=100,stage='Transcript ready',cancel_requested=0,updated_at=?2 WHERE note_id=?1 AND kind='transcribe'",
            params![&note_id, now()],
        ).map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        let views = round2::segments_in(&connection, &note_id)?;
        let transcript = views.iter().map(|segment| { let seconds = segment.start_ms.max(0) / 1_000; format!("[{:02}:{:02}] {}", seconds / 60, seconds % 60, segment.text) }).collect::<Vec<_>>().join("\n");
        connection.execute("UPDATE notes SET transcript=?2,updated_at=?3 WHERE id=?1", params![&note_id, transcript, now()]).map_err(|error| error.to_string())?;
        emit_progress(100, "Transcript ready", "completed");
        get_note(&connection, &note_id)
    }).await.map_err(|error| format!("Transcription worker stopped: {error}"))?;
    manager.cancellations.lock().map_err(|_| "Transcription control is unavailable.".to_string())?.remove(&manager_note_id);
    result
}

#[tauri::command]
fn cancel_transcription(app: AppHandle, manager: tauri::State<'_, TranscriptionManager>, note_id: String) -> Result<(), String> {
    if let Some(flag) = manager.cancellations.lock().map_err(|_| "Transcription control is unavailable.".to_string())?.get(&note_id) { flag.store(true, Ordering::Relaxed); }
    let connection = open_db(&app)?;
    connection.execute("UPDATE jobs SET cancel_requested=1,stage='Cancelling refinement',updated_at=?2 WHERE note_id=?1 AND kind='transcribe'", params![note_id, now()]).map(|_| ()).map_err(|error| error.to_string())
}

#[tauri::command]
fn validate_local_endpoint(endpoint: &str) -> Result<Url, String> {
    let parsed = Url::parse(endpoint)
        .map_err(|_| "The local model endpoint is not a valid URL.".to_string())?;
    let is_loopback = match parsed.host() {
        Some(Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(address)) => address.is_loopback(),
        Some(Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    };
    if parsed.scheme() != "http"
        || !is_loopback
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("For privacy, MOCHI only connects to unauthenticated HTTP services on this computer's loopback interface.".into());
    }
    Ok(parsed)
}

#[tauri::command]
async fn generate_summary(state: tauri::State<'_, InferenceManager>, request: AiRequest) -> Result<String, String> {
    state.run(request.request_id.clone(), async {
        let prompt = format!(
            "Create concise, factual notes from this transcript. Preserve names and numbers. Never invent details. Return markdown with exactly these headings: Summary, Key points, Decisions, Action items. User notes are high-priority context.\n\nUSER NOTES:\n{}\n\nTRANSCRIPT:\n{}",
            request.user_notes, request.transcript
        );
        inference::complete(&request.endpoint, &request.model,
            "You are a careful local meeting-notes editor. If information is absent, say so.",
            &prompt, Task::Brief, false).await
    }).await
}

#[tauri::command]
async fn answer_live(state: tauri::State<'_, InferenceManager>, request: LiveAssistRequest) -> Result<String, String> {
    state.run(request.request_id.clone(), async {
        if request.question.trim().is_empty() || request.transcript.trim().is_empty() {
            return Err("MOCHI needs a question and some conversation first.".into());
        }
        let prompt = format!(
            "Answer the question using only the meeting context below, which may include the user's own notes and a provisional transcript. Be concise. If the answer is not present, say you could not find it in this meeting.\n\nQUESTION:\n{}\n\nMEETING CONTEXT:\n{}",
            request.question, request.transcript
        );
        inference::complete(&request.endpoint, &request.model,
        "You are MOCHI, a private local meeting assistant. Never invent missing meeting details or claim a preview is a finalized transcript.",
            &prompt, Task::Answer, false).await
    }).await
}

#[tauri::command]
fn app_status(app: AppHandle) -> Result<AppStatus, String> {
    let data_dir = app_data_dir(&app)?;
    Ok(AppStatus {
        database_path: data_dir
            .join("mochi.sqlite3")
            .to_string_lossy()
            .into_owned(),
        data_dir: data_dir.to_string_lossy().into_owned(),
        network_policy: "localhost-only AI; no analytics; no cloud sync; opt-in scoped MCP sharing".into(),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let active = app.state::<ShadowWindowState>().active.lock().map(|value| *value).unwrap_or(false);
                    if active {
                        let Some(window) = app.get_webview_window("shadow") else { return; };
                        if window.is_visible().unwrap_or(false) {
                            let _ = window.hide();
                        } else {
                            let _ = macos_window::show_overlay(&window);
                        }
                    }
                })
                .build(),
        )
        .manage(LocalAiManager::default())
        .manage(InferenceManager::default())
        .manage(McpManager::default())
        .manage(NativeCaptureManager::default())
        .manage(ShadowWindowState::default())
        .manage(TranscriptionManager::default())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                let window = app.get_webview_window("shadow").ok_or_else(|| std::io::Error::other("Overlay window is unavailable"))?;
                let panel = window.to_panel::<MochiOverlayPanel>()?;
                panel.add_style_mask(StyleMask::empty().nonactivating_panel().into()).map_err(std::io::Error::other)?;
                panel.set_hides_on_deactivate(false);
            }
            app.global_shortcut().register("CmdOrCtrl+Backslash")?;
            let connection = open_db(&app.handle()).map_err(std::io::Error::other)?;
            mcp::recover(&connection).map_err(std::io::Error::other)?;
            harness::recover(&connection).map_err(std::io::Error::other)?;
            recover_interrupted_jobs(&connection).map_err(std::io::Error::other)?;
            recover_interrupted_captures(&connection).map_err(std::io::Error::other)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            mcp_status,
            mcp_save_sharing,
            mcp_start,
            mcp_stop,
            list_notes,
            create_note,
            update_note,
            delete_note,
            list_projects,
            save_project,
            list_note_organizations,
            save_note_organization,
            list_moments,
            save_moment,
            delete_moment,
            list_agent_recipes,
            start_agent_run,
            execute_agent_run,
            list_agent_runs,
            save_agent_proposal,
            approve_agent_run,
            cancel_agent_run,
            reject_agent_run,
            import_media,
            export_note,
            export_library,
            save_recording,
            begin_recording,
            append_recording_chunk,
            finalize_recording,
            start_native_capture,
            stop_native_capture,
            drain_native_audio_chunks,
            list_pending_native_audio_notes,
            acknowledge_native_audio_chunk,
            list_interrupted_captures,
            reveal_interrupted_capture,
            dismiss_interrupted_capture,
            native_capture_available,
            native_capture_status,
            request_native_capture_permission,
            open_capture_settings,
            open_microphone_settings,
            transcribe_live_chunk,
            save_live_segments,
            show_shadow,
            set_shadow_expanded,
            hide_shadow,
            show_main,
            start_shadow_drag,
            transcription_model_status,
            download_transcription_model,
            run_transcription_job,
            cancel_transcription,
            cancel_local_ai_request,
            generate_summary,
            answer_live,
            app_status,
            list_jobs,
            list_transcript_segments,
            update_transcript_segment,
            get_transcription_preference,
            set_transcription_preference,
            rename_speaker,
            run_diarization,
            list_generated_blocks,
            update_generated_block,
            generate_cited_notes,
            list_action_items,
            update_action_item,
            list_templates,
            save_template,
            delete_template,
            search_library,
            chat_library,
            restore_library,
            local_ai_status,
            install_local_ai,
            start_local_ai
        ])
        .run(tauri::generate_context!())
        .expect("error while running MOCHI");
}

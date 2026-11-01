// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|arg|arg=="--mcp-stdio") {
        if let Err(message)=mochi_lib::run_stdio_bridge() { eprintln!("{message}"); std::process::exit(1); }
        return;
    }
    mochi_lib::run()
}

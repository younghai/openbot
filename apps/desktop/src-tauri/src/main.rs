// OpenBot Desktop — Tauri v2 shell (replaces Electron scaffold)
// Spawns the Node.js server, opens a system WebView at localhost:8940, tray icon.
// Build: cargo install tauri-cli && cd apps/desktop/src-tauri && cargo tauri build

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Child, Command, Stdio};
use std::net::TcpStream;
use std::time::Duration;
use std::io;

const PORT: u16 = 8940;
const HOST: &str = "127.0.0.1";

struct ServerProcess(Option<Child>);

impl Drop for ServerProcess {
    fn drop(&mut self) {
        if let Some(child) = self.0.take() {
            let _ = child.kill();
        }
    }
}

fn start_server() -> Option<Child> {
    let server_dir = "../../server";
    let tsx_path = "../../node_modules/.bin/tsx";

    Command::new(tsx_path)
        .arg("src/index.ts")
        .current_dir(server_dir)
        .env("OPENBOT_PORT", PORT.to_string())
        .env("OPENBOT_HOST", HOST)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()
}

fn wait_for_server(timeout_ms: u64) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    while std::time::Instant::now() < deadline {
        if TcpStream::connect((HOST, PORT)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    false
}

fn main() {
    // Spawn the Node.js server
    let _server = ServerProcess(start_server());

    // Wait for it to come up
    if !wait_for_server(15000) {
        eprintln!("OpenBot: server failed to start on {}:{} within 15s", HOST, PORT);
        std::process::exit(1);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            use tauri::Manager;

            // Tray
            let _tray = tauri::tray::TrayIconBuilder::new()
                .tooltip("OpenBot")
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click { .. } = event {
                        if let Some(window) = tray.app().get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .menu(
                    &tauri::menu::Menu::with_items(
                        app,
                        &[
                            &tauri::menu::MenuItem::with_id(app, "open", "Open OpenBot", true, None::<&str>)?,
                            &tauri::menu::MenuItem::with_id(app, "restart", "Restart Server", true, None::<&str>)?,
                            &tauri::menu::MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?,
                        ],
                    )?,
                )
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "open" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // Hide to tray on close (macOS/Linux behavior)
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// DriverRadar desktop shell.
//
// The engine is the existing Node server in `resources/app`. This shell gives
// it a native window, a bundled Node runtime and a writable per-user data
// folder, then gets out of the way: the window is the same UI the browser
// build serves, so there is exactly one front end to maintain.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent};

const DEFAULT_PORT: u16 = 7788;
/// How long the window shows its splash before it reports a backend failure.
const START_TIMEOUT: Duration = Duration::from_secs(45);

/// The Node process this shell started. A server that was already running
/// (a second launch, or an elevated hand-off) is not owned here and is never
/// killed on exit.
#[derive(Default)]
struct Backend {
    child: Mutex<Option<Child>>,
}

fn port() -> u16 {
    std::env::var("DRIVERRADAR_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT)
}

/// A real HTTP health check, not just an open socket: the port can be taken by
/// something that is not this server.
fn healthy(port: u16) -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1500)));
    let request = format!("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 32];
    match stream.read(&mut buf) {
        Ok(n) => {
            let head = String::from_utf8_lossy(&buf[..n]);
            head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.0 200")
        }
        Err(_) => false,
    }
}

/// Tauri keeps the `resources/` prefix from tauri.conf.json in some bundle
/// layouts and strips it in others (raw target/release vs. an installed app),
/// so both positions are probed.
fn resource_subdir(resource_dir: &Path, name: &str) -> PathBuf {
    let direct = resource_dir.join(name);
    if direct.exists() {
        return direct;
    }
    let nested = resource_dir.join("resources").join(name);
    if nested.exists() {
        return nested;
    }
    direct
}

/// The bundled runtime layout. Windows ships `node.exe`; the other names only
/// keep a source checkout runnable on a developer machine.
fn node_binary(resource_dir: &Path) -> PathBuf {
    let dir = resource_subdir(resource_dir, "node");
    let candidates: &[&str] = if cfg!(windows) {
        &["node.exe"]
    } else if cfg!(target_arch = "aarch64") {
        &["node-arm64", "node"]
    } else {
        &["node-x64", "node"]
    };
    for name in candidates {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return candidate;
        }
    }
    // Last resort: a Node the user installed themselves.
    PathBuf::from("node")
}

fn start_backend(resource_dir: &Path, data_dir: &Path, port: u16) -> Result<Child, String> {
    let app_dir = resource_subdir(resource_dir, "app");
    if !app_dir.join("server.js").is_file() {
        return Err(format!("The application payload is missing from {}", app_dir.display()));
    }
    let node = node_binary(resource_dir);

    let mut command = Command::new(&node);
    command
        .arg("server.js")
        .current_dir(&app_dir)
        .env("PORT", port.to_string())
        .env("DRIVERRADAR_DATA", data_dir)
        .env("DRIVERRADAR_DESKTOP", "1")
        .stdin(Stdio::null());

    // Server output goes to a log beside the user's data, so a machine that
    // misbehaves has something to read.
    match fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(data_dir.join("desktop.log"))
    {
        Ok(file) => {
            let err = file.try_clone().map_err(|e| e.to_string())?;
            command.stdout(file).stderr(err);
        }
        Err(_) => {
            command.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: the shell has no console, so the server must not
        // open one.
        command.creation_flags(0x0800_0000);
    }

    command.spawn().map_err(|err| {
        format!(
            "Could not start the bundled Node runtime ({}): {err}",
            node.display()
        )
    })
}

/// Start the server if our own process is gone and nothing else is serving.
fn ensure_running(
    app: &tauri::AppHandle,
    resource_dir: &Path,
    data_dir: &Path,
    port: u16,
) -> Result<(), String> {
    let state = app.state::<Backend>();
    let mut guard = state.child.lock().map_err(|_| "backend lock poisoned".to_string())?;

    let exited = match guard.as_mut() {
        Some(child) => match child.try_wait() {
            Ok(Some(_)) => true,
            Ok(None) => false,
            Err(_) => true,
        },
        None => true,
    };
    if !exited {
        return Ok(());
    }
    *guard = None;

    if healthy(port) {
        // Someone else owns the port (elevated hand-off or a second launch).
        return Ok(());
    }

    let child = start_backend(resource_dir, data_dir, port)?;
    *guard = Some(child);
    Ok(())
}

fn run_backend(app: tauri::AppHandle, window: tauri::WebviewWindow, resource_dir: PathBuf, data_dir: PathBuf, port: u16) {
    let deadline = Instant::now() + START_TIMEOUT;
    let mut failure: Option<String> = None;

    while Instant::now() < deadline {
        if healthy(port) {
            match format!("http://127.0.0.1:{port}/").parse::<tauri::Url>() {
                Ok(url) => {
                    let _ = window.navigate(url);
                    watch(&app, &resource_dir, &data_dir, port);
                    return;
                }
                Err(err) => failure = Some(format!("Bad local address: {err}")),
            }
        }
        if let Err(err) = ensure_running(&app, &resource_dir, &data_dir, port) {
            failure = Some(err);
        }
        std::thread::sleep(Duration::from_millis(400));
    }

    let message = failure.unwrap_or_else(|| {
        format!(
            "The local server did not answer on 127.0.0.1:{port} within {} seconds.",
            START_TIMEOUT.as_secs()
        )
    });
    let _ = window.eval(&format!(
        "window.driverRadarFailed && window.driverRadarFailed({:?});",
        message
    ));
}

/// After the UI is on screen: keep the engine alive. The page reconnects and
/// reloads itself once /api/health answers again.
fn watch(app: &tauri::AppHandle, resource_dir: &Path, data_dir: &Path, port: u16) {
    loop {
        std::thread::sleep(Duration::from_secs(2));
        if healthy(port) {
            continue;
        }
        if let Err(err) = ensure_running(app, resource_dir, data_dir, port) {
            eprintln!("[driverradar] {err}");
            std::thread::sleep(Duration::from_secs(2));
        }
    }
}

fn main() {
    let app = tauri::Builder::default()
        .manage(Backend::default())
        .setup(|app| {
            let resource_dir = app.path().resource_dir()?;
            let data_dir = app
                .path()
                .app_local_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("DriverRadar"));
            let _ = fs::create_dir_all(&data_dir);

            let port = port();
            let window = app
                .get_webview_window("main")
                .ok_or_else(|| "the main window is missing from tauri.conf.json".to_string())?;

            // Something is already serving (a second launch): show it at once.
            if healthy(port) {
                if let Ok(url) = format!("http://127.0.0.1:{port}/").parse::<tauri::Url>() {
                    let _ = window.navigate(url);
                }
            }

            let handle = app.handle().clone();
            std::thread::spawn(move || {
                run_backend(
                    handle,
                    window,
                    resource_dir.clone(),
                    data_dir.clone(),
                    port,
                )
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("could not build the DriverRadar window");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<Backend>() {
                if let Ok(mut guard) = state.child.lock() {
                    if let Some(mut child) = guard.take() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                }
            }
        }
    });
}

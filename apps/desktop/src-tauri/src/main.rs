#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

#[derive(Default)]
struct AgentWatcher(Mutex<Option<Child>>);

impl AgentWatcher {
    fn stop(&self) {
        let mut owned = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(mut child) = owned.take() {
            // Child retains the process handle: never terminate by name or a stale PID.
            if let Err(error) = child.kill() {
                startup_log("agent_watch.stop_failed", error.to_string());
            }
            let _ = child.wait();
        }
    }
}

impl Drop for AgentWatcher {
    fn drop(&mut self) { self.stop(); }
}
use tauri::{AppHandle, CustomMenuItem, Manager, SystemTray, SystemTrayMenu};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;
const CREDENTIAL_SERVICE: &str = "cn.zhixin.ai.desktop";

struct AppInstanceLock {
    path: PathBuf,
}

struct AgentRuntime {
    executable: PathBuf,
    script: PathBuf,
    working_dir: PathBuf,
    browsers_dir: Option<PathBuf>,
}

impl Drop for AppInstanceLock {
    fn drop(&mut self) {
        let current_pid = std::process::id().to_string();
        if fs::read_to_string(&self.path)
            .map(|value| value.trim() == current_pid)
            .unwrap_or(false)
        {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn app_data_dir() -> PathBuf {
    std::env::var("LOCALAPPDATA")
        .or_else(|_| std::env::var("APPDATA"))
        .or_else(|_| std::env::var("HOME"))
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("cn.zhixin.ai.desktop")
}

fn startup_log(event: &str, detail: impl AsRef<str>) {
    let log_path = app_data_dir().join("desktop-startup.log");
    if let Some(parent) = log_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0);
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_path) {
        let detail = detail.as_ref().replace(['\r', '\n'], " ");
        let _ = writeln!(file, "{} {} {}", timestamp, event, detail);
    }
}

fn process_is_alive(pid: u32) -> bool {
    if pid == std::process::id() {
        return true;
    }

    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("tasklist");
        command
            .arg("/FI")
            .arg(format!("PID eq {}", pid))
            .arg("/FO")
            .arg("CSV")
            .arg("/NH")
            .stdin(Stdio::null())
            .stderr(Stdio::null());
        command.creation_flags(CREATE_NO_WINDOW);
        let output = match command.output() {
            Ok(output) => output,
            Err(_) => return false,
        };
        String::from_utf8_lossy(&output.stdout).contains(&pid.to_string())
    }

    #[cfg(not(target_os = "windows"))]
    {
        Command::new("kill")
            .arg("-0")
            .arg(pid.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }
}

fn acquire_app_instance_lock() -> Result<AppInstanceLock, String> {
    let lock_path = app_data_dir().join("desktop-app.lock");
    if let Some(parent) = lock_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    if let Ok(existing) = fs::read_to_string(&lock_path) {
        if existing
            .trim()
            .parse::<u32>()
            .map(process_is_alive)
            .unwrap_or(false)
        {
            return Err("ZHIXIN_DESKTOP_ALREADY_RUNNING".to_string());
        }
        let _ = fs::remove_file(&lock_path);
    }

    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock_path)
        .map_err(|_| "ZHIXIN_DESKTOP_ALREADY_RUNNING".to_string())?;
    file.write_all(std::process::id().to_string().as_bytes())
        .map_err(|error| error.to_string())?;

    Ok(AppInstanceLock { path: lock_path })
}

fn credential_entry(key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(CREDENTIAL_SERVICE, key).map_err(|error| error.to_string())
}

fn run_credential_helper() -> Option<i32> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) != Some("__credential") {
        return None;
    }

    let action = args.get(2).map(String::as_str).unwrap_or("");
    let key = args.get(3).map(String::as_str).unwrap_or("desktop-device-token");
    let result = (|| -> Result<(), String> {
        let entry = credential_entry(key)?;
        match action {
            "get" => {
                if let Ok(value) = entry.get_password() {
                    print!("{}", value);
                }
                Ok(())
            }
            "set" => {
                let mut value = String::new();
                std::io::stdin()
                    .read_to_string(&mut value)
                    .map_err(|error| error.to_string())?;
                if value.is_empty() {
                    return Err("CREDENTIAL_VALUE_REQUIRED".to_string());
                }
                entry.set_password(&value).map_err(|error| error.to_string())
            }
            "delete" => {
                let _ = entry.delete_credential();
                Ok(())
            }
            _ => Err("UNKNOWN_CREDENTIAL_ACTION".to_string()),
        }
    })();

    match result {
        Ok(()) => Some(0),
        Err(error) => {
            eprintln!("{}", error);
            Some(1)
        }
    }
}

fn command_compatible_path(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{}", rest));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path
}

fn packaged_runtime(app: &AppHandle) -> Result<AgentRuntime, String> {
    let resource_dir = match app.path_resolver().resource_dir() {
        Some(path) => {
            startup_log("packaged_runtime.resource_dir", path.display().to_string());
            path
        }
        None => {
            startup_log("packaged_runtime.resource_dir_missing", "no path resolved");
            return Err("DESKTOP_RESOURCE_DIR_NOT_FOUND".to_string());
        }
    };
    let mut roots = vec![resource_dir.join("resources"), resource_dir.clone()];
    if let Some(executable_dir) = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(PathBuf::from))
    {
        startup_log("packaged_runtime.executable_dir", executable_dir.display().to_string());
        roots.push(executable_dir.join("resources"));
        roots.push(executable_dir);
    }
    let runtime_name = if cfg!(target_os = "windows") { "node.exe" } else { "node" };

    for root in roots {
        let root = command_compatible_path(root);
        let executable = root.join("runtime").join(runtime_name);
        let working_dir = root.join("agent");
        let script = working_dir.join("src").join("agent.mjs");
        startup_log(
            "packaged_runtime.candidate",
            format!(
                "root={} executable_exists={} script_exists={}",
                root.display(),
                executable.exists(),
                script.exists()
            ),
        );
        if executable.exists() && script.exists() {
            startup_log(
                "packaged_runtime.selected",
                format!("executable={} script={}", executable.display(), script.display()),
            );
            return Ok(AgentRuntime {
                executable,
                script,
                working_dir,
                browsers_dir: Some(root.join("browsers")),
            });
        }
    }
    startup_log("packaged_runtime.failed", "no complete runtime candidate");
    Err("PACKAGED_AGENT_RUNTIME_NOT_FOUND".to_string())
}

#[cfg(debug_assertions)]
fn development_runtime() -> Result<AgentRuntime, String> {
    let desktop_root = std::env::var("ZHIXIN_DEV_AGENT_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap_or_else(|| std::path::Path::new(env!("CARGO_MANIFEST_DIR")))
                .to_path_buf()
        });
    let script = desktop_root.join("src").join("agent.mjs");
    if !script.exists() {
        return Err("DEVELOPMENT_AGENT_NOT_FOUND".to_string());
    }
    Ok(AgentRuntime {
        executable: PathBuf::from(std::env::var("ZHIXIN_NODE_BINARY").unwrap_or_else(|_| "node".to_string())),
        script,
        working_dir: desktop_root,
        browsers_dir: None,
    })
}

fn agent_runtime(app: &AppHandle) -> Result<AgentRuntime, String> {
    match packaged_runtime(app) {
        Ok(runtime) => Ok(runtime),
        Err(packaged_error) => {
            #[cfg(debug_assertions)]
            {
                return development_runtime().map_err(|development_error| {
                    format!("{}; {}", packaged_error, development_error)
                });
            }
            #[cfg(not(debug_assertions))]
            {
                Err(packaged_error)
            }
        }
    }
}

fn agent_process(app: &AppHandle, command: &str, args: &[String]) -> Result<Command, String> {
    let runtime = agent_runtime(app)?;
    let helper = std::env::current_exe().map_err(|error| error.to_string())?;
    let mut process = Command::new(&runtime.executable);
    process
        .current_dir(&runtime.working_dir)
        .arg(&runtime.script)
        .arg(command)
        .args(args)
        .env("ZHIXIN_CREDENTIAL_HELPER", helper);
    if let Some(browsers_dir) = runtime.browsers_dir {
        process.env("PLAYWRIGHT_BROWSERS_PATH", browsers_dir);
    }
    #[cfg(target_os = "windows")]
    process.creation_flags(CREATE_NO_WINDOW);
    Ok(process)
}

#[tauri::command]
// Runs on the blocking pool so long agent commands such as `authorize` cannot
// freeze the UI main thread while waiting for the Node child process to exit.
async fn agent_command(app: AppHandle, command: String, args: Vec<String>) -> Result<String, String> {
    let output = tauri::async_runtime::spawn_blocking(move || {
        agent_process(&app, &command, &args)?
            .output()
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())??;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Err(if stderr.is_empty() { stdout } else { stderr });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[tauri::command]
fn agent_command_detached(app: AppHandle, command: String, args: Vec<String>) -> Result<String, String> {
    let child = agent_process(&app, &command, &args)?
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| error.to_string())?;
    Ok(serde_json::json!({
        "status": "started",
        "command": command,
        "pid": child.id()
    })
    .to_string())
}

#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

fn start_agent_watch(app: &AppHandle) -> Result<(), String> {
    let child = agent_process(app, "watch", &["--interval-ms".to_string(), "3000".to_string()])?
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| error.to_string())?;
    startup_log("agent_watch.spawned", format!("pid={}", child.id()));
    *app.state::<AgentWatcher>().0.lock().map_err(|error| error.to_string())? = Some(child);
    Ok(())
}

fn main() {
    if let Some(exit_code) = run_credential_helper() {
        std::process::exit(exit_code);
    }

    let _instance_lock = match acquire_app_instance_lock() {
        Ok(lock) => lock,
        Err(error) => {
            eprintln!("{}", error);
            return;
        }
    };

    let tray_menu = SystemTrayMenu::new()
        .add_item(CustomMenuItem::new("show".to_string(), "显示智心AI桌面端"))
        .add_item(CustomMenuItem::new("quit".to_string(), "退出"));

    tauri::Builder::default()
        .manage(AgentWatcher::default())
        .invoke_handler(tauri::generate_handler![
            agent_command,
            agent_command_detached,
            app_version
        ])
        .setup(|app| {
            if let Err(error) = start_agent_watch(&app.handle()) {
                startup_log("agent_watch.failed", &error);
                eprintln!("failed to start desktop command watcher: {}", error);
            }
            Ok(())
        })
        .system_tray(SystemTray::new().with_menu(tray_menu))
        .on_system_tray_event(|app, event| {
            if let tauri::SystemTrayEvent::MenuItemClick { id, .. } = event {
                match id.as_str() {
                    "show" => {
                        if let Some(window) = app.get_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        app.state::<AgentWatcher>().stop();
                        app.exit(0);
                    },
                    _ => {}
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build Zhixin AI desktop")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<AgentWatcher>().stop();
            }
        });
}
#[cfg(test)]
mod tests {
    use super::command_compatible_path;
    use std::path::PathBuf;

    #[cfg(target_os = "windows")]
    #[test]
    fn stopping_owned_watcher_is_idempotent_and_preserves_other_processes() {
        use super::{AgentWatcher, Command, Mutex, Stdio};
        let spawn = || Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 60"])
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        let mut unrelated = spawn();
        let watcher = AgentWatcher(Mutex::new(Some(spawn())));
        watcher.stop();
        watcher.stop();
        assert!(watcher.0.lock().unwrap().is_none());
        let unrelated_alive = unrelated.try_wait().unwrap().is_none();
        let _ = unrelated.kill();
        let _ = unrelated.wait();
        assert!(unrelated_alive);
    }

    #[test]
    fn strips_windows_extended_path_prefix_for_external_processes() {
        let path = PathBuf::from(r"\\?\C:\zhixin\resources\agent\src\agent.mjs");
        assert_eq!(
            command_compatible_path(path),
            PathBuf::from(r"C:\zhixin\resources\agent\src\agent.mjs")
        );
    }

    #[test]
    fn converts_windows_extended_unc_path_for_external_processes() {
        let path = PathBuf::from(r"\\?\UNC\server\share\agent.mjs");
        assert_eq!(
            command_compatible_path(path),
            PathBuf::from(r"\\server\share\agent.mjs")
        );
    }
}

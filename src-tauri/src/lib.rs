use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::Emitter;
use tauri::Manager;

const MAX_READ_BYTES: u64 = 1_048_576;
const MAX_DEPTH: usize = 8;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileNode {
    name: String,
    path: String,
    kind: String,
    children: Option<Vec<FileNode>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ValidationResult {
    ok: bool,
    kind: String,
    message: String,
    line: Option<usize>,
    column: Option<usize>,
    detail: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupEntry {
    name: String,
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceDetect {
    path: Option<String>,
    source: String,
    exists: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteConnection {
    host: String,
    user: String,
    port: Option<u16>,
    identity_file: Option<String>,
    password: Option<String>,
}

fn is_target_file(path: &Path) -> bool {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some(ext) => matches!(
            ext.to_ascii_lowercase().as_str(),
            "yaml" | "yml" | "json" | "md"
        ),
        None => false,
    }
}

fn build_tree(path: &Path, depth: usize) -> Result<Option<FileNode>, String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if metadata.file_type().is_symlink() {
        return Ok(None);
    }

    if metadata.is_file() {
        if !is_target_file(path) {
            return Ok(None);
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string();
        return Ok(Some(FileNode {
            name,
            path: path.to_string_lossy().to_string(),
            kind: "file".to_string(),
            children: None,
        }));
    }

    if depth >= MAX_DEPTH {
        return Ok(None);
    }

    let mut children = Vec::new();
    let entries = fs::read_dir(path).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let child_path = entry.path();
        let node = match build_tree(&child_path, depth + 1) {
            Ok(node) => node,
            Err(_) => None,
        };
        if let Some(node) = node {
            children.push(node);
        }
    }

    if children.is_empty() {
        return Ok(None);
    }

    children.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string());

    Ok(Some(FileNode {
        name,
        path: path.to_string_lossy().to_string(),
        kind: "dir".to_string(),
        children: Some(children),
    }))
}

fn extension_kind(path: &Path) -> String {
    path.extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn extension_kind_from_name(path_hint: &str) -> String {
    extension_kind(Path::new(path_hint))
}

fn validate_content_by_kind(kind: String, content: &str) -> Result<ValidationResult, String> {
    if kind == "json" {
        match serde_json::from_str::<serde_json::Value>(content) {
            Ok(_) => Ok(ValidationResult {
                ok: true,
                kind,
                message: "JSON 校验通过".to_string(),
                line: None,
                column: None,
                detail: None,
            }),
            Err(err) => {
                let detail = err
                    .to_string()
                    .rsplit_once(" at line ")
                    .map(|(message, _)| message.to_string())
                    .unwrap_or_else(|| err.to_string());
                Ok(ValidationResult {
                    ok: false,
                    kind,
                    message: detail.clone(),
                    line: Some(err.line()),
                    column: Some(err.column()),
                    detail: Some(detail),
                })
            }
        }
    } else if kind == "yaml" || kind == "yml" {
        match serde_yaml::from_str::<serde_yaml::Value>(content) {
            Ok(_) => Ok(ValidationResult {
                ok: true,
                kind,
                message: "YAML 校验通过".to_string(),
                line: None,
                column: None,
                detail: None,
            }),
            Err(err) => {
                let location = err.location();
                Ok(ValidationResult {
                    ok: false,
                    kind,
                    message: err.to_string(),
                    line: location.as_ref().map(|marker| marker.line()),
                    column: location.as_ref().map(|marker| marker.column()),
                    detail: None,
                })
            }
        }
    } else if kind == "md" {
        Ok(ValidationResult {
            ok: true,
            kind,
            message: "Markdown 无需结构校验".to_string(),
            line: None,
            column: None,
            detail: None,
        })
    } else {
        Ok(ValidationResult {
            ok: false,
            kind,
            message: "未知文件类型".to_string(),
            line: None,
            column: None,
            detail: None,
        })
    }
}

fn parse_structured_by_kind(kind: String, content: &str) -> Result<serde_json::Value, String> {
    if kind == "json" {
        let value: serde_json::Value = serde_json::from_str(content).map_err(|e| e.to_string())?;
        return Ok(value);
    }

    if kind == "yaml" || kind == "yml" {
        let value: serde_yaml::Value = serde_yaml::from_str(content).map_err(|e| e.to_string())?;
        let json_value = serde_json::to_value(value).map_err(|e| e.to_string())?;
        return Ok(json_value);
    }

    Err("Unsupported file type for form view.".to_string())
}

fn expand_tilde(input: &str) -> String {
    if input.starts_with("~/") {
        if let Some(home) = dirs_next::home_dir() {
            if let Some(home_str) = home.to_str() {
                return format!("{}{}", home_str, &input[1..]);
            }
        }
    }
    input.to_string()
}

fn read_workspace_from_config(path: &Path) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    let value: serde_json::Value = json5::from_str(&content).ok()?;

    let candidates = [
        value
            .get("agents")
            .and_then(|v| v.get("defaults"))
            .and_then(|v| v.get("workspace")),
        value.get("agent").and_then(|v| v.get("workspace")),
        value.get("workspace"),
    ];

    for candidate in candidates {
        if let Some(path) = candidate.and_then(|v| v.as_str()) {
            return Some(expand_tilde(path));
        }
    }

    None
}

fn read_openclaw_workspace() -> Option<String> {
    let home = dirs_next::home_dir()?;
    let base = home.join(".openclaw");
    let primary = base.join("openclaw.json");
    let legacy = base.join("clawdbot.json");

    read_workspace_from_config(&primary).or_else(|| read_workspace_from_config(&legacy))
}

fn default_workspace_from_profile() -> Option<PathBuf> {
    let home = dirs_next::home_dir()?;
    let profile = env::var("OPENCLAW_PROFILE").ok();
    let base = home.join(".openclaw");

    let workspace = match profile.as_deref() {
        Some(profile) if profile != "default" => base.join(format!("workspace-{}", profile)),
        _ => base.join("workspace"),
    };

    Some(workspace)
}

fn scan_top_level_configs() -> Vec<FileNode> {
    let mut entries = Vec::new();
    let home = match dirs_next::home_dir() {
        Some(home) => home,
        None => return entries,
    };
    let config_dir = home.join(".openclaw");
    let read_dir = match fs::read_dir(config_dir) {
        Ok(read_dir) => read_dir,
        Err(_) => return entries,
    };

    for entry in read_dir.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if !is_target_file(&path) {
            continue;
        }
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(name) => name.to_string(),
            None => continue,
        };
        entries.push(FileNode {
            name,
            path: path.to_string_lossy().to_string(),
            kind: "file".to_string(),
            children: None,
        });
    }

    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    entries
}

fn sort_tree(node: &mut FileNode) {
    if let Some(children) = node.children.as_mut() {
        children.sort_by(|a, b| {
            if a.kind == b.kind {
                a.name.to_lowercase().cmp(&b.name.to_lowercase())
            } else if a.kind == "dir" {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            }
        });
        for child in children {
            sort_tree(child);
        }
    }
}

fn insert_remote_file(
    node: &mut FileNode,
    current_path: &Path,
    components: &[String],
    full_path: &str,
) {
    if components.is_empty() {
        return;
    }

    if components.len() == 1 {
        let children = node.children.get_or_insert_with(Vec::new);
        children.push(FileNode {
            name: components[0].clone(),
            path: full_path.to_string(),
            kind: "file".to_string(),
            children: None,
        });
        return;
    }

    let dir_name = &components[0];
    let dir_path = current_path.join(dir_name);
    let children = node.children.get_or_insert_with(Vec::new);
    let index = match children
        .iter()
        .position(|child| child.kind == "dir" && child.name == *dir_name)
    {
        Some(index) => index,
        None => {
            children.push(FileNode {
                name: dir_name.clone(),
                path: dir_path.to_string_lossy().to_string(),
                kind: "dir".to_string(),
                children: Some(Vec::new()),
            });
            children.len() - 1
        }
    };

    insert_remote_file(&mut children[index], &dir_path, &components[1..], full_path);
}

fn build_tree_from_file_paths(root_path: &str, files: Vec<String>) -> Result<FileNode, String> {
    let root = Path::new(root_path);
    let root_name = root
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or(root_path)
        .to_string();

    let mut tree = FileNode {
        name: root_name,
        path: root_path.to_string(),
        kind: "dir".to_string(),
        children: Some(Vec::new()),
    };

    for file in files {
        let relative = Path::new(&file)
            .strip_prefix(root)
            .map_err(|e| e.to_string())?;
        let components = relative
            .components()
            .filter_map(|component| component.as_os_str().to_str().map(|s| s.to_string()))
            .collect::<Vec<_>>();
        insert_remote_file(&mut tree, root, &components, &file);
    }

    sort_tree(&mut tree);
    Ok(tree)
}

#[tauri::command]
fn scan_workspace(path: String) -> Result<FileNode, String> {
    let root = Path::new(&path);
    if !root.exists() {
        return Err("Workspace path does not exist.".to_string());
    }
    build_tree(root, 0)?.ok_or_else(|| "No supported files found.".to_string())
}

#[tauri::command]
fn scan_workspace_with_config(path: String) -> Result<FileNode, String> {
    let root = Path::new(&path);
    if !root.exists() {
        return Err("Workspace path does not exist.".to_string());
    }

    let mut children = Vec::new();

    if let Some(workspace_node) = build_tree(root, 0)? {
        children.push(workspace_node);
    }

    let configs = scan_top_level_configs();
    if !configs.is_empty() {
        children.push(FileNode {
            name: "OPENCLAW CONFIG".to_string(),
            path: "~/.openclaw".to_string(),
            kind: "dir".to_string(),
            children: Some(configs),
        });
    }

    if children.is_empty() {
        return Err("No supported files found.".to_string());
    }

    Ok(FileNode {
        name: "ROOT".to_string(),
        path: path.to_string(),
        kind: "dir".to_string(),
        children: Some(children),
    })
}

fn ssh_target(connection: &RemoteConnection) -> String {
    format!("{}@{}", connection.user, connection.host)
}

struct AskpassScript {
    path: PathBuf,
}

impl Drop for AskpassScript {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn build_remote_command(script: &str, args: &[String]) -> String {
    if args.is_empty() {
        return script.to_string();
    }

    let quoted_args = args
        .iter()
        .map(|arg| shell_single_quote(arg))
        .collect::<Vec<_>>()
        .join(" ");
    format!("set -- {}; {}", quoted_args, script)
}

fn should_use_password(connection: &RemoteConnection) -> bool {
    connection
        .password
        .as_deref()
        .map(|password| !password.trim().is_empty())
        .unwrap_or(false)
}

fn create_askpass_script(password: &str) -> Result<AskpassScript, String> {
    let file_name = format!(
        "forclaw-askpass-{}-{}.sh",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos()
    );
    let path = env::temp_dir().join(file_name);
    let script = format!(
        "#!/bin/sh\nprintf '%s\\n' {}\n",
        shell_single_quote(password)
    );

    fs::write(&path, script).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        let permissions = fs::Permissions::from_mode(0o700);
        fs::set_permissions(&path, permissions).map_err(|e| e.to_string())?;
    }

    Ok(AskpassScript { path })
}

fn apply_ssh_args(command: &mut Command, connection: &RemoteConnection) {
    command.arg("-o").arg("ConnectTimeout=5");
    command.arg("-o").arg("ConnectionAttempts=1");
    command.arg("-o").arg("StrictHostKeyChecking=accept-new");
    if should_use_password(connection) {
        command
            .arg("-o")
            .arg("PreferredAuthentications=password,keyboard-interactive");
        command.arg("-o").arg("PubkeyAuthentication=no");
        command.arg("-o").arg("NumberOfPasswordPrompts=1");
    } else {
        command.arg("-o").arg("BatchMode=yes");
    }
    if let Some(port) = connection.port {
        command.arg("-p").arg(port.to_string());
    }
    if let Some(identity_file) = connection.identity_file.as_deref() {
        if !identity_file.trim().is_empty() {
            command.arg("-i").arg(identity_file);
        }
    }
}

fn configure_ssh_password_auth(
    command: &mut Command,
    connection: &RemoteConnection,
) -> Result<Option<AskpassScript>, String> {
    let Some(password) = connection.password.as_deref() else {
        return Ok(None);
    };
    if password.trim().is_empty() {
        return Ok(None);
    }

    let askpass = create_askpass_script(password)?;
    command.env("SSH_ASKPASS", &askpass.path);
    command.env("SSH_ASKPASS_REQUIRE", "force");
    command.env(
        "DISPLAY",
        env::var("DISPLAY").unwrap_or_else(|_| "forclaw:0".to_string()),
    );
    Ok(Some(askpass))
}

fn run_ssh_script(
    connection: &RemoteConnection,
    script: &str,
    args: &[String],
) -> Result<Output, String> {
    let mut command = Command::new("ssh");
    apply_ssh_args(&mut command, connection);
    let askpass = configure_ssh_password_auth(&mut command, connection)?;
    let remote_command = build_remote_command(script, args);
    command.arg(ssh_target(connection));
    command.arg(format!("sh -lc {}", shell_single_quote(&remote_command)));
    if should_use_password(connection) {
        command.stdin(Stdio::null());
    }
    let output = command.output().map_err(|e| e.to_string())?;
    drop(askpass);
    Ok(output)
}

fn run_ssh_script_with_input(
    connection: &RemoteConnection,
    script: &str,
    args: &[String],
    input: &[u8],
) -> Result<Output, String> {
    let mut command = Command::new("ssh");
    apply_ssh_args(&mut command, connection);
    let askpass = configure_ssh_password_auth(&mut command, connection)?;
    let remote_command = build_remote_command(script, args);
    command.arg(ssh_target(connection));
    command.arg(format!("sh -lc {}", shell_single_quote(&remote_command)));
    command.stdin(Stdio::piped());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    let mut child = command.spawn().map_err(|e| e.to_string())?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin.write_all(input).map_err(|e| e.to_string())?;
    }
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    drop(askpass);
    Ok(output)
}

fn ssh_stdout(output: Output) -> Result<String, String> {
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.is_empty() {
            Err(format!("ssh exited with status {}", output.status))
        } else {
            Err(stderr)
        }
    }
}

fn resolve_remote_workspace_path(
    connection: &RemoteConnection,
    remote_path: &str,
) -> Result<String, String> {
    let output = run_ssh_script(
        connection,
        r#"target="$1"
case "$target" in
  "~")
    target="$HOME"
    ;;
  "~/"*)
    target="$HOME/${target#~/}"
    ;;
esac
cd -- "$target" && pwd -P"#,
        &[remote_path.to_string()],
    )?;
    Ok(ssh_stdout(output)?.trim().to_string())
}

fn remote_backup_dir_and_name(path: &str) -> Result<(String, String), String> {
    let file_path = Path::new(path);
    let parent = file_path
        .parent()
        .and_then(|parent| parent.to_str())
        .ok_or_else(|| "Unable to locate parent directory.".to_string())?;
    let file_name = file_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Unable to locate file name.".to_string())?;
    Ok((format!("{}/.backup", parent), file_name.to_string()))
}

fn scan_remote_workspace_blocking(
    connection: RemoteConnection,
    path: String,
) -> Result<FileNode, String> {
    let resolved_root = resolve_remote_workspace_path(&connection, &path)?;
    let output = run_ssh_script(
        &connection,
        r#"cd -- "$1" &&
find . -type f \( -name '*.yaml' -o -name '*.yml' -o -name '*.json' -o -name '*.md' \) -print"#,
        std::slice::from_ref(&resolved_root),
    )?;
    let content = ssh_stdout(output)?;
    let files = content
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            let relative = line.trim_start_matches("./");
            if relative.is_empty() {
                return None;
            }
            Some(format!(
                "{}/{}",
                resolved_root.trim_end_matches('/'),
                relative
            ))
        })
        .collect::<Vec<_>>();

    if files.is_empty() {
        return Err("No supported files found.".to_string());
    }

    build_tree_from_file_paths(&resolved_root, files)
}

#[tauri::command]
async fn scan_remote_workspace(
    connection: RemoteConnection,
    path: String,
) -> Result<FileNode, String> {
    tauri::async_runtime::spawn_blocking(move || scan_remote_workspace_blocking(connection, path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn detect_workspace() -> Result<WorkspaceDetect, String> {
    if let Some(home) = dirs_next::home_dir() {
        let base = home.join(".openclaw");
        let path_str = base.to_string_lossy().to_string();
        if base.exists() {
            return Ok(WorkspaceDetect {
                path: Some(path_str),
                source: "default".to_string(),
                exists: true,
            });
        }
    }

    if let Some(path) = read_openclaw_workspace() {
        let exists = Path::new(&path).exists();
        return Ok(WorkspaceDetect {
            path: Some(path),
            source: "openclaw.json".to_string(),
            exists,
        });
    }

    if let Some(path) = default_workspace_from_profile() {
        let path_str = path.to_string_lossy().to_string();
        let exists = path.exists();
        return Ok(WorkspaceDetect {
            path: Some(path_str),
            source: "default".to_string(),
            exists,
        });
    }

    Ok(WorkspaceDetect {
        path: None,
        source: "not_found".to_string(),
        exists: false,
    })
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    let file_path = Path::new(&path);
    let metadata = fs::metadata(file_path).map_err(|e| e.to_string())?;
    if metadata.len() > MAX_READ_BYTES {
        return Err("File too large to preview.".to_string());
    }
    fs::read_to_string(file_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn parse_structured(path: String) -> Result<serde_json::Value, String> {
    let file_path = Path::new(&path);
    let content = fs::read_to_string(file_path).map_err(|e| e.to_string())?;
    let kind = extension_kind(file_path);
    parse_structured_by_kind(kind, &content)
}

#[tauri::command]
fn parse_structured_content(
    path_hint: String,
    content: String,
) -> Result<serde_json::Value, String> {
    let kind = extension_kind_from_name(&path_hint);
    parse_structured_by_kind(kind, &content)
}

#[tauri::command]
fn validate_file(path: String) -> Result<ValidationResult, String> {
    let file_path = Path::new(&path);
    let content = fs::read_to_string(file_path).map_err(|e| e.to_string())?;
    let kind = extension_kind(file_path);
    validate_content_by_kind(kind, &content)
}

#[tauri::command]
fn validate_content(path_hint: String, content: String) -> Result<ValidationResult, String> {
    let kind = extension_kind_from_name(&path_hint);
    validate_content_by_kind(kind, &content)
}

#[tauri::command]
fn validate_json_content(content: String) -> Result<ValidationResult, String> {
    validate_content_by_kind("json".to_string(), &content)
}

fn backup_dir_for(file_path: &Path) -> Result<std::path::PathBuf, String> {
    let parent = file_path
        .parent()
        .ok_or_else(|| "Unable to locate parent directory.".to_string())?;
    let backup_dir = parent.join(".backup");
    fs::create_dir_all(&backup_dir).map_err(|e| e.to_string())?;
    Ok(backup_dir)
}

fn backup_name(file_path: &Path, epoch: u64) -> String {
    let name = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    format!("{}.{}.bak", name, epoch)
}

#[tauri::command]
fn save_file(path: String, content: String) -> Result<(), String> {
    let file_path = Path::new(&path);
    if !file_path.exists() {
        return Err("File does not exist.".to_string());
    }

    let backup_dir = backup_dir_for(file_path)?;
    let epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    let backup_path = backup_dir.join(backup_name(file_path, epoch));

    let original = fs::read_to_string(file_path).map_err(|e| e.to_string())?;
    fs::write(backup_path, original).map_err(|e| e.to_string())?;
    fs::write(file_path, content).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn list_backups(path: String) -> Result<Vec<BackupEntry>, String> {
    let file_path = Path::new(&path);
    let backup_dir = backup_dir_for(file_path)?;
    let file_name = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    let mut entries = Vec::new();

    for entry in fs::read_dir(backup_dir).map_err(|e| e.to_string())? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let path = entry.path();
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(name) => name.to_string(),
            None => continue,
        };
        if !name.starts_with(file_name) {
            continue;
        }
        entries.push(BackupEntry {
            name,
            path: path.to_string_lossy().to_string(),
        });
    }

    entries.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(entries)
}

fn read_remote_file_blocking(connection: RemoteConnection, path: String) -> Result<String, String> {
    let output = run_ssh_script(
        &connection,
        &format!(
            r#"bytes=$(wc -c < "$1") || exit 1
if [ "$bytes" -gt {} ]; then
  echo "File too large to preview." >&2
  exit 1
fi
cat -- "$1""#,
            MAX_READ_BYTES
        ),
        &[path],
    )?;
    ssh_stdout(output)
}

#[tauri::command]
async fn read_remote_file(connection: RemoteConnection, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || read_remote_file_blocking(connection, path))
        .await
        .map_err(|e| e.to_string())?
}

fn save_remote_file_blocking(
    connection: RemoteConnection,
    path: String,
    content: String,
) -> Result<(), String> {
    let (backup_dir, file_name) = remote_backup_dir_and_name(&path)?;
    let epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    let backup_path = format!("{}/{}.{}.bak", backup_dir, file_name, epoch);
    let temp_path = format!("{}/.forclaw.tmp.{}.{}", backup_dir, epoch, file_name);

    let backup_output = run_ssh_script(
        &connection,
        r#"mkdir -p -- "$1" && cp -- "$2" "$3""#,
        &[backup_dir.clone(), path.clone(), backup_path],
    )?;
    ssh_stdout(backup_output)?;

    let temp_output = run_ssh_script_with_input(
        &connection,
        r#"cat > "$1""#,
        std::slice::from_ref(&temp_path),
        content.as_bytes(),
    )?;
    ssh_stdout(temp_output)?;

    let move_output = run_ssh_script(&connection, r#"mv -- "$1" "$2""#, &[temp_path, path])?;
    ssh_stdout(move_output)?;
    Ok(())
}

#[tauri::command]
async fn save_remote_file(
    connection: RemoteConnection,
    path: String,
    content: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        save_remote_file_blocking(connection, path, content)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn list_remote_backups_blocking(
    connection: RemoteConnection,
    path: String,
) -> Result<Vec<BackupEntry>, String> {
    let (backup_dir, file_name) = remote_backup_dir_and_name(&path)?;
    let output = run_ssh_script(
        &connection,
        r#"if [ ! -d "$1" ]; then
  exit 0
fi
pattern="${2}"'*.bak'
find "$1" -maxdepth 1 -type f -name "$pattern" -print"#,
        &[backup_dir, file_name],
    )?;
    let content = ssh_stdout(output)?;
    let mut entries = content
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            let name = Path::new(line)
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.to_string())?;
            Some(BackupEntry {
                name,
                path: line.to_string(),
            })
        })
        .collect::<Vec<_>>();

    entries.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(entries)
}

#[tauri::command]
async fn list_remote_backups(
    connection: RemoteConnection,
    path: String,
) -> Result<Vec<BackupEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || list_remote_backups_blocking(connection, path))
        .await
        .map_err(|e| e.to_string())?
}

fn is_backup_file(path: &Path) -> bool {
    let in_backup_dir = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .map(|n| n == ".backup")
        .unwrap_or(false);
    let has_bak_ext = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("bak"))
        .unwrap_or(false);
    in_backup_dir && has_bak_ext
}

#[tauri::command]
fn delete_backup(path: String) -> Result<(), String> {
    let backup_path = Path::new(&path);
    if !is_backup_file(backup_path) {
        return Err("Invalid backup file path.".to_string());
    }
    if !backup_path.exists() {
        return Ok(());
    }
    let metadata = fs::metadata(backup_path).map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err("Backup path is not a file.".to_string());
    }
    fs::remove_file(backup_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn clear_backups(path: String) -> Result<usize, String> {
    let file_path = Path::new(&path);
    let backup_dir = backup_dir_for(file_path)?;
    let file_name = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();

    let mut removed = 0usize;
    for entry in fs::read_dir(backup_dir).map_err(|e| e.to_string())? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let candidate = entry.path();
        let name = match candidate.file_name().and_then(|n| n.to_str()) {
            Some(name) => name,
            None => continue,
        };
        if !name.starts_with(file_name) || !is_backup_file(&candidate) {
            continue;
        }
        fs::remove_file(&candidate).map_err(|e| e.to_string())?;
        removed += 1;
    }

    Ok(removed)
}

fn delete_remote_backup_blocking(connection: RemoteConnection, path: String) -> Result<(), String> {
    let output = run_ssh_script(&connection, r#"rm -f -- "$1""#, &[path])?;
    ssh_stdout(output)?;
    Ok(())
}

#[tauri::command]
async fn delete_remote_backup(connection: RemoteConnection, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_remote_backup_blocking(connection, path))
        .await
        .map_err(|e| e.to_string())?
}

fn clear_remote_backups_blocking(
    connection: RemoteConnection,
    path: String,
) -> Result<usize, String> {
    let entries = list_remote_backups_blocking(connection.clone(), path)?;
    for entry in &entries {
        delete_remote_backup_blocking(connection.clone(), entry.path.clone())?;
    }
    Ok(entries.len())
}

#[tauri::command]
async fn clear_remote_backups(connection: RemoteConnection, path: String) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || clear_remote_backups_blocking(connection, path))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .menu(|app| {
            let app_name = app.package_info().name.clone();

            let about_item = MenuItem::with_id(
                app,
                "about-forclaw",
                "About Forclaw",
                true,
                None::<&str>,
            )?;
            let language_item = MenuItem::with_id(
                app,
                "open-language-settings",
                "Language...",
                true,
                None::<&str>,
            )?;
            let settings_menu = Submenu::with_items(app, "Settings", true, &[&language_item])?;
            let toggle_devtools_item = MenuItem::with_id(
                app,
                "toggle-devtools",
                "Toggle DevTools",
                true,
                Some("Alt+Cmd+I"),
            )?;

            #[cfg(target_os = "macos")]
            let app_menu = Submenu::with_items(
                app,
                app_name,
                true,
                &[
                    &about_item,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?;

            #[cfg(not(target_os = "macos"))]
            let file_menu = Submenu::with_items(
                app,
                "File",
                true,
                &[
                    &PredefinedMenuItem::close_window(app, None)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?;

            let edit_menu = Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?;

            let window_menu = Submenu::with_items(
                app,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::maximize(app, None)?,
                    #[cfg(target_os = "macos")]
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::close_window(app, None)?,
                ],
            )?;

            #[cfg(target_os = "macos")]
            let view_menu = Submenu::with_items(
                app,
                "View",
                true,
                &[
                    &toggle_devtools_item,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::fullscreen(app, None)?,
                ],
            )?;

            #[cfg(not(target_os = "macos"))]
            let help_menu = Submenu::with_items(app, "Help", true, &[&about_item])?;

            Menu::with_items(
                app,
                &[
                    #[cfg(target_os = "macos")]
                    &app_menu,
                    #[cfg(not(target_os = "macos"))]
                    &file_menu,
                    &edit_menu,
                    &settings_menu,
                    #[cfg(target_os = "macos")]
                    &view_menu,
                    &window_menu,
                    #[cfg(not(target_os = "macos"))]
                    &help_menu,
                ],
            )
        })
        .on_menu_event(|app, event| {
            if event.id() == "about-forclaw" {
                let _ = app.emit("about-forclaw", ());
            }
            if event.id() == "open-language-settings" {
                let _ = app.emit("open-language-settings", ());
            }
            if event.id() == "toggle-devtools" {
                if let Some(window) = app.get_webview_window("main") {
                    if window.is_devtools_open() {
                        window.close_devtools();
                    } else {
                        window.open_devtools();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            detect_workspace,
            scan_workspace,
            scan_workspace_with_config,
            scan_remote_workspace,
            read_file,
            read_remote_file,
            parse_structured,
            parse_structured_content,
            validate_file,
            validate_content,
            validate_json_content,
            save_file,
            save_remote_file,
            list_backups,
            list_remote_backups,
            delete_backup,
            delete_remote_backup,
            clear_backups,
            clear_remote_backups
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

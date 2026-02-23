use serde::Serialize;
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use std::{env, path::PathBuf};

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

#[tauri::command]
fn detect_workspace() -> Result<WorkspaceDetect, String> {
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

    if kind == "json" {
        let value: serde_json::Value =
            serde_json::from_str(&content).map_err(|e| e.to_string())?;
        return Ok(value);
    }

    if kind == "yaml" || kind == "yml" {
        let value: serde_yaml::Value =
            serde_yaml::from_str(&content).map_err(|e| e.to_string())?;
        let json_value = serde_json::to_value(value).map_err(|e| e.to_string())?;
        return Ok(json_value);
    }

    Err("Unsupported file type for form view.".to_string())
}

#[tauri::command]
fn validate_file(path: String) -> Result<ValidationResult, String> {
    let file_path = Path::new(&path);
    let content = fs::read_to_string(file_path).map_err(|e| e.to_string())?;
    let kind = extension_kind(file_path);

    if kind == "json" {
        match serde_json::from_str::<serde_json::Value>(&content) {
            Ok(_) => Ok(ValidationResult {
                ok: true,
                kind,
                message: "JSON 校验通过".to_string(),
            }),
            Err(err) => Ok(ValidationResult {
                ok: false,
                kind,
                message: err.to_string(),
            }),
        }
    } else if kind == "yaml" || kind == "yml" {
        match serde_yaml::from_str::<serde_yaml::Value>(&content) {
            Ok(_) => Ok(ValidationResult {
                ok: true,
                kind,
                message: "YAML 校验通过".to_string(),
            }),
            Err(err) => Ok(ValidationResult {
                ok: false,
                kind,
                message: err.to_string(),
            }),
        }
    } else if kind == "md" {
        Ok(ValidationResult {
            ok: true,
            kind,
            message: "Markdown 无需结构校验".to_string(),
        })
    } else {
        Ok(ValidationResult {
            ok: false,
            kind,
            message: "未知文件类型".to_string(),
        })
    }
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            detect_workspace,
            scan_workspace,
            scan_workspace_with_config,
            read_file,
            parse_structured,
            validate_file,
            save_file,
            list_backups
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

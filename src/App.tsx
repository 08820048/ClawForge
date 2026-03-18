import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { homeDir } from "@tauri-apps/api/path";
import { confirm, message, open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import ReactMarkdown from "react-markdown";
import CodeMirror from "@uiw/react-codemirror";
import { json as jsonLang } from "@codemirror/lang-json";
import { oneDark } from "@codemirror/theme-one-dark";
import type { EditorView } from "@codemirror/view";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark as prismOneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import ReactDiffViewer, { DiffMethod } from "react-diff-viewer-continued";
import { ArrowLeftRight, FileJson, Folder, Heading, LogOut, Settings } from "lucide-react";
import "./App.css";

type FileNode = {
  name: string;
  path: string;
  kind: "file" | "dir";
  children?: FileNode[];
};

type Status = {
  tone: "idle" | "loading" | "error" | "success";
  message: string;
};

type ValidationResult = {
  ok: boolean;
  kind: string;
  message: string;
  line?: number;
  column?: number;
  detail?: string;
};

type BackupEntry = {
  name: string;
  path: string;
};

type FlatEntry = {
  key: string;
  value: string;
};

type RemoteFormState = {
  host: string;
  user: string;
  port: string;
  workspacePath: string;
  identityFile: string;
  password: string;
};

type RemoteConnection = {
  host: string;
  user: string;
  port?: number;
  identityFile?: string;
  password?: string;
};

type Language = "zh" | "en";

const translations: Record<Language, Record<string, string>> = {
  zh: {
    lang_title: "选择语言",
    lang_subtitle: "请选择你要使用的界面语言",
    lang_zh: "中文",
    lang_en: "English",
    lang_settings_title: "语言设置",
    lang_settings_desc: "切换应用显示语言",
    confirm_unsaved: "当前文件有未保存的修改，是否保存？",
    status_auto_detect: "自动识别工作区...",
    status_auto_detected: "已自动识别：{source}",
    status_auto_detect_failed: "自动识别失败：{error}",
    status_path_missing: "检测到路径但不存在：{path}",
    status_detected_config: "已检测到配置目录：{path}",
    status_missing_config: "检测到配置目录但不存在：{path}",
    status_no_default: "未检测到默认工作区，请手动选择。",
    status_choose_dir: "选择目录...",
    status_cancel_choose: "已取消选择。",
    status_scan_done: "扫描完成。",
    status_config_updated: "已更新配置目录，切换后查看。",
    status_scan_failed: "扫描失败：{error}",
    status_remote_connecting: "连接远程工作区...",
    status_remote_connected: "远程连接成功。",
    status_remote_disconnected: "已断开远程连接。",
    status_remote_missing: "请先填写远程连接信息并连接。",
    status_remote_failed: "远程连接失败：{error}",
    remote_connecting_hint: "正在测试 SSH 连接并扫描远程目录...",
    remote_connecting_button: "连接中...",
    status_saving: "保存中...",
    status_saved: "已保存并创建备份",
    status_save_failed: "保存失败：{error}",
    status_read_backup: "读取历史版本...",
    status_reading_file: "读取文件...",
    file_loading_hint: "正在读取文件内容...",
    status_read_failed: "读取失败：{error}",
    status_diff_building: "生成差异对比...",
    status_diff_failed: "对比失败：{error}",
    json_empty: "JSON 为空",
    json_ok_live: "JSON 校验通过（实时）",
    yaml_ok_live: "YAML 校验通过（实时）",
    json_live_delayed: "JSON 校验通过（大文件延迟校验）",
    validation_error_with_location: "语法错误（第 {line} 行，第 {column} 列）：{error}",
    jump_to_error: "错误定位",
    json_large_mode: "大 JSON 文件已切换轻量编辑模式，以减少卡顿。",
    search_files: "搜索文件名或路径",
    search_empty: "没有匹配的文件。",
    context_reveal: "在文件夹中显示",
    empty_content: "(空文件或未加载)",
    meta_name: "名称",
    meta_type: "类型",
    meta_path: "路径",
    action_view: "查看",
    action_diff: "对比",
    action_delete: "删除",
    action_clear_history: "清空历史",
    dir_config: "配置目录",
    dir_work: "工作目录",
    dir_remote: "远程目录",
    toggle_to_config: "切换到配置目录",
    toggle_to_work: "切换到工作目录",
    source_local: "本地",
    source_remote: "远程",
    no_dir_selected: "尚未选择目录",
    choose_dir: "选择目录",
    connect_remote: "连接远程",
    edit_remote: "连接设置",
    close_remote_modal: "取消",
    disconnect_remote: "断开远程",
    empty_tree: "选择目录后显示文件树。",
    remote_empty: "点击右上角的“远程”打开连接面板。",
    remote_connect_title: "远程 SSH 连接",
    remote_connect_desc: "填写服务器信息后加载远程目录，并在保存时同步到远程。",
    remote_host: "主机",
    remote_user: "用户",
    remote_port: "端口",
    remote_path: "远程目录",
    remote_identity: "私钥文件（可选）",
    remote_password: "密码",
    clean_mode: "干净模式",
    clean_mode_desc: "仅显示文件",
    editor_title: "编辑区",
    editor_empty: "请选择文件进行编辑",
    mode_form: "表单视图",
    mode_source: "源码视图",
    mode_preview: "预览视图",
    exit_diff: "退出对比",
    save_hint: "使用 Ctrl+S 保存",
    no_file_selected: "尚未选择文件。",
    history_title: "历史版本",
    history_label: "历史版本: {label}",
    form_empty: "暂无结构化数据可展示。",
    inspector_title: "检查器",
    inspector_empty: "选择文件后显示属性。",
    history_empty: "暂无历史版本。",
    viewing_history: "正在查看历史版本。",
    confirm_clear_history: "确认清空该文件的所有历史版本吗？",
    confirm_delete_history: "确认删除该历史版本吗？",
    status_clearing_history: "清理历史版本...",
    status_deleting_history: "删除历史版本...",
    status_history_deleted: "历史版本已删除。",
    status_history_cleared: "已清理 {count} 条历史版本。",
    status_clear_history_failed: "清理历史失败：{error}",
    status_delete_history_failed: "删除历史失败：{error}",
    about_title: "About Forclaw",
    about_content: "Forclaw\n开发者：xuyi.dev\n开源地址：https://github.com/08820048/ClawForge",
  },
  en: {
    lang_title: "Choose Language",
    lang_subtitle: "Select the interface language",
    lang_zh: "中文",
    lang_en: "English",
    lang_settings_title: "Language",
    lang_settings_desc: "Switch app display language",
    confirm_unsaved: "You have unsaved changes. Save now?",
    status_auto_detect: "Detecting workspace...",
    status_auto_detected: "Auto detected: {source}",
    status_auto_detect_failed: "Auto detect failed: {error}",
    status_path_missing: "Detected path missing: {path}",
    status_detected_config: "Config directory detected: {path}",
    status_missing_config: "Config directory not found: {path}",
    status_no_default: "No default workspace detected. Please choose a directory.",
    status_choose_dir: "Choose directory...",
    status_cancel_choose: "Selection cancelled.",
    status_scan_done: "Scan completed.",
    status_config_updated: "Config directory updated. Switch to view.",
    status_scan_failed: "Scan failed: {error}",
    status_remote_connecting: "Connecting remote workspace...",
    status_remote_connected: "Remote connection established.",
    status_remote_disconnected: "Remote connection closed.",
    status_remote_missing: "Fill in the remote connection and connect first.",
    status_remote_failed: "Remote connection failed: {error}",
    remote_connecting_hint: "Testing the SSH connection and scanning the remote directory...",
    remote_connecting_button: "Connecting...",
    status_saving: "Saving...",
    status_saved: "Saved and backup created",
    status_save_failed: "Save failed: {error}",
    status_read_backup: "Loading backup...",
    status_reading_file: "Reading file...",
    file_loading_hint: "Loading file contents...",
    status_read_failed: "Read failed: {error}",
    status_diff_building: "Building diff...",
    status_diff_failed: "Diff failed: {error}",
    json_empty: "JSON is empty",
    json_ok_live: "JSON valid (live)",
    yaml_ok_live: "YAML valid (live)",
    json_live_delayed: "JSON valid (large file delayed check)",
    validation_error_with_location: "Syntax error at line {line}, column {column}: {error}",
    jump_to_error: "Locate error",
    json_large_mode: "Large JSON switched to lightweight editor to reduce lag.",
    search_files: "Search file name or path",
    search_empty: "No matching files.",
    context_reveal: "Show in folder",
    empty_content: "(empty or not loaded)",
    meta_name: "Name",
    meta_type: "Type",
    meta_path: "Path",
    action_view: "View",
    action_diff: "Diff",
    action_delete: "Delete",
    action_clear_history: "Clear history",
    dir_config: "Config Directory",
    dir_work: "Work Directory",
    dir_remote: "Remote Directory",
    toggle_to_config: "Switch to config directory",
    toggle_to_work: "Switch to work directory",
    source_local: "Local",
    source_remote: "Remote",
    no_dir_selected: "No directory selected",
    choose_dir: "Choose directory",
    connect_remote: "Connect remote",
    edit_remote: "Connection settings",
    close_remote_modal: "Cancel",
    disconnect_remote: "Disconnect",
    empty_tree: "Choose a directory to show files.",
    remote_empty: "Click \"Remote\" in the top-right corner to open the connection panel.",
    remote_connect_title: "Remote SSH Connection",
    remote_connect_desc:
      "Enter the server details to load the remote directory and sync saves back to the server.",
    remote_host: "Host",
    remote_user: "User",
    remote_port: "Port",
    remote_path: "Remote path",
    remote_identity: "Identity file (optional)",
    remote_password: "Password",
    clean_mode: "Clean mode",
    clean_mode_desc: "Files only",
    editor_title: "Editor",
    editor_empty: "Select a file to edit",
    mode_form: "Form",
    mode_source: "Source",
    mode_preview: "Preview",
    exit_diff: "Exit diff",
    save_hint: "Use Ctrl+S to save",
    no_file_selected: "No file selected.",
    history_title: "History",
    history_label: "History: {label}",
    form_empty: "No structured data available.",
    inspector_title: "Inspector",
    inspector_empty: "Select a file to view details.",
    history_empty: "No history available.",
    viewing_history: "Viewing a history version.",
    confirm_clear_history: "Clear all history versions for this file?",
    confirm_delete_history: "Delete this history version?",
    status_clearing_history: "Clearing history...",
    status_deleting_history: "Deleting history version...",
    status_history_deleted: "History version deleted.",
    status_history_cleared: "Cleared {count} history versions.",
    status_clear_history_failed: "Clear history failed: {error}",
    status_delete_history_failed: "Delete history failed: {error}",
    about_title: "About Forclaw",
    about_content: "Forclaw\nDeveloper: xuyi.dev\nSource: https://github.com/08820048/ClawForge",
  },
};

type ViewMode = "form" | "source" | "preview";
type SourceMode = "local" | "remote";

type WorkspaceDetect = {
  path: string | null;
  source: string;
  exists: boolean;
};

const LARGE_JSON_THRESHOLD = 300 * 1024;
const NORMAL_JSON_VALIDATE_DELAY = 300;
const LARGE_JSON_VALIDATE_DELAY = 1200;

function flattenValue(value: unknown, prefix = ""): FlatEntry[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      flattenValue(item, `${prefix}[${index}]`),
    );
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(
      ([key, val]) => flattenValue(val, prefix ? `${prefix}.${key}` : key),
    );
  }
  return [
    {
      key: prefix || "(root)",
      value:
        value === null
          ? "null"
          : value === undefined
          ? "undefined"
          : String(value),
    },
  ];
}

function isJsonFile(file: FileNode | null) {
  return file?.name.toLowerCase().endsWith(".json") ?? false;
}

function isMarkdownFile(file: FileNode | null) {
  return file?.name.toLowerCase().endsWith(".md") ?? false;
}

function isYamlFile(file: FileNode | null) {
  return file
    ? file.name.toLowerCase().endsWith(".yaml") || file.name.toLowerCase().endsWith(".yml")
    : false;
}

function supportsErrorJump(kind: string) {
  return kind === "json" || kind === "yaml" || kind === "yml";
}

function collectFiles(node: FileNode): FileNode[] {
  if (node.kind === "file") return [node];
  return (node.children ?? []).flatMap((child) => collectFiles(child));
}

function fileIconClass(name: string) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "tree-icon-yaml";
  return "tree-icon-file";
}

function renderFileIcon(name: string) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".json")) {
    return <FileJson className="tree-file-icon" size={14} strokeWidth={1.6} />;
  }
  if (lower.endsWith(".md")) {
    return <Heading className="tree-file-icon" size={14} strokeWidth={1.6} />;
  }
  return <span className={`tree-icon ${fileIconClass(name)}`} aria-hidden />;
}

function App() {
  const [language, setLanguage] = useState<Language>(() => {
    const stored = localStorage.getItem("clawforge.language");
    return stored === "en" || stored === "zh" ? stored : "zh";
  });
  const [showLanguageModal, setShowLanguageModal] = useState<boolean>(() => {
    return localStorage.getItem("clawforge.language") === null;
  });
  const [showRemoteModal, setShowRemoteModal] = useState<boolean>(false);
  const [remoteConnecting, setRemoteConnecting] = useState<boolean>(false);
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [configPath, setConfigPath] = useState<string | null>(null);
  const [workPath, setWorkPath] = useState<string | null>(null);
  const [sourceMode, setSourceMode] = useState<SourceMode>(() => {
    const stored = localStorage.getItem("clawforge.sourceMode");
    return stored === "remote" ? "remote" : "local";
  });
  const [dirMode, setDirMode] = useState<"config" | "work">("config");
  const [remoteForm, setRemoteForm] = useState<RemoteFormState>(() => {
    const stored = localStorage.getItem("clawforge.remoteForm");
    if (!stored) {
      return {
        host: "",
        user: "",
        port: "22",
        workspacePath: "",
        identityFile: "",
        password: "",
      };
    }
    try {
      const parsed = JSON.parse(stored) as Partial<RemoteFormState>;
      return {
        host: parsed.host ?? "",
        user: parsed.user ?? "",
        port: parsed.port ?? "22",
        workspacePath: parsed.workspacePath ?? "",
        identityFile: parsed.identityFile ?? "",
        password: parsed.password ?? "",
      };
    } catch {
      return {
        host: "",
        user: "",
        port: "22",
        workspacePath: "",
        identityFile: "",
        password: "",
      };
    }
  });
  const [remoteConnection, setRemoteConnection] = useState<RemoteConnection | null>(null);
  const [tree, setTree] = useState<FileNode | null>(null);
  const [selectedFile, setSelectedFile] = useState<FileNode | null>(null);
  const [loadingFilePath, setLoadingFilePath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>("");
  const [editedContent, setEditedContent] = useState<string>("");
  const [mode, setMode] = useState<ViewMode>("source");
  const [status, setStatus] = useState<Status>({
    tone: "idle",
    message: "",
  });
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [structured, setStructured] = useState<FlatEntry[]>([]);
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [viewingPath, setViewingPath] = useState<string | null>(null);
  const [diffBase, setDiffBase] = useState<string | null>(null);
  const [diffTarget, setDiffTarget] = useState<string | null>(null);
  const [diffLabel, setDiffLabel] = useState<string | null>(null);
  const [cleanMode, setCleanMode] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [collapsedDirs, setCollapsedDirs] = useState<Record<string, boolean>>(
    {},
  );
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    file: FileNode;
  } | null>(null);
  const codeMirrorViewRef = useRef<EditorView | null>(null);
  const editorTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const deferredSearchQuery = useDeferredValue(searchQuery);

  const fileMeta = useMemo(() => {
    if (!selectedFile) return null;
    const extension = selectedFile.name.split(".").pop() ?? "";
    return {
      name: selectedFile.name,
      path: selectedFile.path,
      extension: extension.toUpperCase(),
    };
  }, [selectedFile]);
  const isLargeJsonFile = useMemo(() => {
    return isJsonFile(selectedFile) && editedContent.length >= LARGE_JSON_THRESHOLD;
  }, [selectedFile, editedContent.length]);
  const flatFiles = useMemo(() => (tree ? collectFiles(tree) : []), [tree]);
  const normalizedSearchQuery = deferredSearchQuery.trim().toLowerCase();
  const visibleFiles = useMemo(() => {
    if (!normalizedSearchQuery) return flatFiles;
    return flatFiles.filter((file) => {
      const name = file.name.toLowerCase();
      const path = file.path.toLowerCase();
      return name.includes(normalizedSearchQuery) || path.includes(normalizedSearchQuery);
    });
  }, [flatFiles, normalizedSearchQuery]);
  const isRemoteSource = sourceMode === "remote";
  const isFileLoading = loadingFilePath !== null;
  const activeFilePath = loadingFilePath ?? selectedFile?.path ?? null;

  const activeContent = viewingPath ? fileContent : editedContent;
  const prevLanguageRef = useRef<Language>(language);
  const t = (key: string, params?: Record<string, string>) => {
    const template = translations[language][key] ?? key;
    if (!params) return template;
    return Object.keys(params).reduce(
      (acc, k) => acc.replace(`{${k}}`, params[k]),
      template,
    );
  };

  useEffect(() => {
    localStorage.setItem("clawforge.sourceMode", sourceMode);
  }, [sourceMode]);

  useEffect(() => {
    localStorage.setItem(
      "clawforge.remoteForm",
      JSON.stringify({
        host: remoteForm.host,
        user: remoteForm.user,
        port: remoteForm.port,
        workspacePath: remoteForm.workspacePath,
        identityFile: remoteForm.identityFile,
        password: remoteForm.password,
      }),
    );
  }, [remoteForm]);

  useEffect(() => {
    if (sourceMode === "remote" && !remoteConnection) {
      setShowRemoteModal(true);
    }
  }, []);

  useEffect(() => {
    const prev = prevLanguageRef.current;
    if (prev === language) return;
    prevLanguageRef.current = language;
  }, [language]);

  useEffect(() => {
    if (sourceMode === "remote") return;
    void restoreLocalWorkspace(true);
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    return () => {
      window.removeEventListener("click", close);
    };
  }, [contextMenu]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveCurrent();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let unlistenLang: (() => void) | null = null;
    const setup = async () => {
      unlisten = await listen("about-forclaw", () => {
        showAbout();
      });
      unlistenLang = await listen("open-language-settings", () => {
        setShowLanguageModal(true);
      });
    };
    setup();
    return () => {
      unlisten?.();
      unlistenLang?.();
    };
  }, []);

  const applyLanguage = (next: Language) => {
    setLanguage(next);
    localStorage.setItem("clawforge.language", next);
    setShowLanguageModal(false);
  };

  useEffect(() => {
    if (!selectedFile || (!isJsonFile(selectedFile) && !isYamlFile(selectedFile))) return;
    let cancelled = false;
    const isJson = isJsonFile(selectedFile);
    const isLarge = editedContent.length >= LARGE_JSON_THRESHOLD;
    const delay = isJson && isLarge ? LARGE_JSON_VALIDATE_DELAY : NORMAL_JSON_VALIDATE_DELAY;
    const handle = window.setTimeout(() => {
      if (isJson && editedContent.trim().length === 0) {
        setValidation({
          ok: false,
          kind: "json",
          message: t("json_empty"),
          line: undefined,
          column: undefined,
          detail: undefined,
        });
        return;
      }
      const validationRequest = isJson
        ? invoke<ValidationResult>("validate_json_content", {
            content: editedContent,
          })
        : invoke<ValidationResult>("validate_content", {
            pathHint: selectedFile.path,
            content: editedContent,
          });
      validationRequest
        .then((result) => {
          if (cancelled) return;
          if (result.ok) {
            setValidation({
              ok: true,
              kind: result.kind,
              message: isJson
                ? isLarge
                  ? t("json_live_delayed")
                  : t("json_ok_live")
                : t("yaml_ok_live"),
              line: undefined,
              column: undefined,
              detail: undefined,
            });
          } else {
            setValidation(result);
          }
        })
        .catch((error) => {
          if (cancelled) return;
          setValidation({
            ok: false,
            kind: isJson ? "json" : "yaml",
            message: String(error),
            line: undefined,
            column: undefined,
            detail: undefined,
          });
        });
    }, delay);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [editedContent, selectedFile, language]);

  useEffect(() => {
    if (diffBase === null) return;
    setDiffTarget(editedContent);
  }, [editedContent, diffBase]);

  function buildRemoteConnectionPayload(): RemoteConnection | null {
    const host = remoteForm.host.trim();
    const user = remoteForm.user.trim();
    const workspace = remoteForm.workspacePath.trim();
    if (!host || !user || !workspace) {
      return null;
    }

    const portValue = remoteForm.port.trim();
    const port = portValue ? Number(portValue) : undefined;
    return {
      host,
      user,
      port: port && Number.isFinite(port) ? port : undefined,
      identityFile: remoteForm.identityFile.trim() || undefined,
      password: remoteForm.password || undefined,
    };
  }

  async function analyzeContent(pathHint: string, content: string) {
    try {
      const result = await invoke<ValidationResult>("validate_content", {
        pathHint,
        content,
      });
      setValidation(result);
    } catch (error) {
      setValidation({ ok: false, kind: "unknown", message: String(error) });
    }

    try {
      const structuredValue = await invoke<unknown>("parse_structured_content", {
        pathHint,
        content,
      });
      setStructured(flattenValue(structuredValue));
    } catch {
      setStructured([]);
    }
  }

  function formatValidationMessage(result: ValidationResult) {
    if (!result.ok && supportsErrorJump(result.kind) && result.line !== undefined && result.column !== undefined) {
      return t("validation_error_with_location", {
        line: String(result.line),
        column: String(result.column),
        error: result.detail ?? result.message,
      });
    }
    return result.message;
  }

  const showJumpToValidationError = Boolean(
    validation
      && !validation.ok
      && supportsErrorJump(validation.kind)
      && validation.line !== undefined
      && validation.column !== undefined
      && selectedFile
      && mode === "source"
      && (isJsonFile(selectedFile) || isYamlFile(selectedFile)),
  );

  function getOffsetFromLineColumn(content: string, line: number, column: number) {
    const lines = content.split("\n");
    let offset = 0;
    for (let index = 0; index < lines.length; index += 1) {
      if (index + 1 === line) {
        return offset + Math.max(0, column - 1);
      }
      offset += lines[index].length + 1;
    }
    return content.length;
  }

  function focusValidationErrorAtLocation(line: number, column: number) {
    const offset = Math.min(
      getOffsetFromLineColumn(editedContent, line, column),
      editedContent.length,
    );
    const head = Math.min(offset + 1, editedContent.length);

    if (selectedFile && isJsonFile(selectedFile) && !isLargeJsonFile && codeMirrorViewRef.current) {
      codeMirrorViewRef.current.dispatch({
        selection: { anchor: offset, head },
        scrollIntoView: true,
      });
      codeMirrorViewRef.current.focus();
      return;
    }

    if (editorTextareaRef.current) {
      editorTextareaRef.current.focus();
      editorTextareaRef.current.setSelectionRange(offset, head);
    }
  }

  function jumpToValidationError() {
    if (
      !validation
      || validation.ok
      || !supportsErrorJump(validation.kind)
      || validation.line === undefined
      || validation.column === undefined
    ) {
      return;
    }

    if (mode !== "source") {
      setMode("source");
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          focusValidationErrorAtLocation(validation.line!, validation.column!);
        });
      });
      return;
    }

    focusValidationErrorAtLocation(validation.line, validation.column);
  }

  async function readCurrentFile(path: string) {
    if (isRemoteSource) {
      if (!remoteConnection) {
        throw new Error(t("status_remote_missing"));
      }
      return invoke<string>("read_remote_file", {
        connection: remoteConnection,
        path,
      });
    }

    return invoke<string>("read_file", { path });
  }

  async function readBackupFile(path: string) {
    return readCurrentFile(path);
  }

  async function refreshBackups(path: string) {
    try {
      const list = isRemoteSource
        ? await invoke<BackupEntry[]>("list_remote_backups", {
            connection: remoteConnection,
            path,
          })
        : await invoke<BackupEntry[]>("list_backups", { path });
      setBackups(list);
      return list;
    } catch {
      setBackups([]);
      return [];
    }
  }

  async function scanRemoteWorkspace(successMessage: string) {
    const connection = buildRemoteConnectionPayload();
    if (!connection) {
      setStatus({ tone: "error", message: t("status_remote_missing") });
      setTree(null);
      setWorkspacePath(null);
      return false;
    }

    setStatus({ tone: "loading", message: t("status_remote_connecting") });
    setRemoteConnecting(true);
    resetEditor();

    try {
      const result = await invoke<FileNode>("scan_remote_workspace", {
        connection,
        path: remoteForm.workspacePath.trim(),
      });
      setRemoteConnection(connection);
      setSourceMode("remote");
      setTree(result);
      setWorkspacePath(`${connection.user}@${connection.host}:${result.path}`);
      setStatus({ tone: "success", message: successMessage });
      return true;
    } catch (error) {
      setRemoteConnection(null);
      setTree(null);
      setWorkspacePath(null);
      setStatus({
        tone: "error",
        message: t("status_remote_failed", { error: String(error) }),
      });
      return false;
    } finally {
      setRemoteConnecting(false);
    }
  }

  async function switchSource(nextMode: SourceMode) {
    if (nextMode === sourceMode) return;
    setSourceMode(nextMode);
    if (nextMode === "local") {
      setShowRemoteModal(false);
    }
    resetEditor();
    setTree(null);
    setWorkspacePath(null);
    setBackups([]);

    if (nextMode === "remote") {
      setShowRemoteModal(true);
      return;
    }
    await restoreLocalWorkspace(true);
  }

  function disconnectRemote() {
    if (remoteConnecting) return;
    setRemoteConnection(null);
    setTree(null);
    setWorkspacePath(null);
    resetEditor();
    setStatus({ tone: "idle", message: t("status_remote_disconnected") });
  }

  async function openRemotePanel() {
    if (sourceMode !== "remote") {
      await switchSource("remote");
      return;
    }
    setShowRemoteModal(true);
  }

  async function connectRemote() {
    const connected = await scanRemoteWorkspace(t("status_remote_connected"));
    if (connected) {
      setShowRemoteModal(false);
    }
  }

  async function chooseWorkspace() {
    if (isRemoteSource) return;
    setStatus({ tone: "loading", message: t("status_choose_dir") });
    const selected = await open({ directory: true, multiple: false });
    if (!selected || typeof selected !== "string") {
      setStatus({ tone: "idle", message: t("status_cancel_choose") });
      return;
    }

    setConfigPath(selected);
    if (dirMode === "config") {
      await scanWorkspace(selected, t("status_scan_done"));
      return;
    }
    setStatus({ tone: "idle", message: t("status_config_updated") });
  }

  async function scanWorkspace(path: string, successMessage: string) {
    setWorkspacePath(path);
    resetEditor();

    try {
      const result = await invoke<FileNode>("scan_workspace_with_config", {
        path,
      });
      setTree(result);
      setStatus({ tone: "success", message: successMessage });
    } catch (error) {
      setTree(null);
      setStatus({
        tone: "error",
        message: t("status_scan_failed", { error: String(error) }),
      });
    }
  }

  async function restoreLocalWorkspace(useAutoDetectedMessage = false) {
    if (dirMode === "work") {
      const path = await resolveWorkPath();
      await scanWorkspace(path, t("status_scan_done"));
      return;
    }

    setStatus({ tone: "loading", message: t("status_auto_detect") });
    try {
      const result = await invoke<WorkspaceDetect>("detect_workspace");
      if (result.path && result.exists) {
        setConfigPath(result.path);
        await scanWorkspace(
          result.path,
          useAutoDetectedMessage
            ? t("status_auto_detected", { source: result.source })
            : t("status_scan_done"),
        );
        return;
      }

      if (result.path && !result.exists) {
        setConfigPath(result.path);
        setWorkspacePath(result.path);
        setTree(null);
        setStatus({
          tone: "error",
          message: t("status_path_missing", { path: result.path }),
        });
        return;
      }

      setWorkspacePath(null);
      setTree(null);
      setStatus({
        tone: "idle",
        message: t("status_no_default"),
      });
    } catch (error) {
      setStatus({
        tone: "error",
        message: t("status_auto_detect_failed", { error: String(error) }),
      });
    }
  }

  async function resolveWorkPath() {
    if (workPath) return workPath;
    const home = await homeDir();
    const normalized = home.replace(/[\\/]+$/, "");
    const resolved = `${normalized}/clawd`;
    setWorkPath(resolved);
    return resolved;
  }

  async function toggleDirectoryMode() {
    if (isRemoteSource) return;
    const nextMode = dirMode === "config" ? "work" : "config";
    setDirMode(nextMode);
    if (nextMode === "work") {
      const path = await resolveWorkPath();
      await scanWorkspace(path, t("status_scan_done"));
      return;
    }

    if (configPath) {
      await scanWorkspace(configPath, t("status_scan_done"));
      return;
    }

    setWorkspacePath(null);
    setTree(null);
    setStatus({ tone: "idle", message: t("status_no_default") });
  }

  async function showAbout() {
    await message(t("about_content"), {
      title: t("about_title"),
      kind: "info",
    });
  }

  function resetEditor() {
    setSelectedFile(null);
    setLoadingFilePath(null);
    setFileContent("");
    setEditedContent("");
    setBackups([]);
    setViewingPath(null);
    setDiffBase(null);
    setDiffTarget(null);
    setDiffLabel(null);
  }

  async function loadFile(node: FileNode) {
    if (node.kind !== "file") return;
    if (selectedFile && editedContent !== fileContent) {
      const shouldSave = await confirm(t("confirm_unsaved"));
      if (shouldSave) {
        const saved = await saveCurrent();
        if (!saved) {
          return;
        }
      }
    }
    setLoadingFilePath(node.path);
    setStatus({ tone: "loading", message: t("status_reading_file") });
    setViewingPath(null);

    try {
      const content = await readCurrentFile(node.path);
      setSelectedFile(node);
      setFileContent(content);
      setEditedContent(content);
      setStatus({ tone: "idle", message: "" });
      void analyzeContent(node.path, content);
      void refreshBackups(node.path);
    } catch (error) {
      setStatus({
        tone: "error",
        message: t("status_read_failed", { error: String(error) }),
      });
      setLoadingFilePath(null);
      return;
    }

    setLoadingFilePath(null);
    setDiffBase(null);
    setDiffTarget(null);
    setDiffLabel(null);
  }

  async function saveCurrent(): Promise<boolean> {
    if (!selectedFile) return false;
    setStatus({ tone: "loading", message: t("status_saving") });
    try {
      if (isRemoteSource) {
        await invoke("save_remote_file", {
          connection: remoteConnection,
          path: selectedFile.path,
          content: editedContent,
        });
      } else {
        await invoke("save_file", {
          path: selectedFile.path,
          content: editedContent,
        });
      }
      setFileContent(editedContent);
      await analyzeContent(selectedFile.path, editedContent);
      await refreshBackups(selectedFile.path);
      setStatus({ tone: "success", message: t("status_saved") });
      return true;
    } catch (error) {
      setStatus({
        tone: "error",
        message: t("status_save_failed", { error: String(error) }),
      });
      return false;
    }
  }

  async function viewBackup(entry: BackupEntry) {
    setStatus({ tone: "loading", message: t("status_read_backup") });
    try {
      const content = await readBackupFile(entry.path);
      setFileContent(content);
      setViewingPath(entry.path);
      setStatus({ tone: "idle", message: "" });
    } catch (error) {
      setStatus({
        tone: "error",
        message: t("status_read_failed", { error: String(error) }),
      });
    }
  }

  async function diffWithBackup(entry: BackupEntry) {
    if (!selectedFile) return;
    setStatus({ tone: "loading", message: t("status_diff_building") });
    try {
      const backupContent = await readBackupFile(entry.path);
      setDiffBase(backupContent);
      setDiffTarget(editedContent);
      setDiffLabel(entry.name);
      setMode("preview");
      setStatus({ tone: "idle", message: "" });
    } catch (error) {
      setStatus({
        tone: "error",
        message: t("status_diff_failed", { error: String(error) }),
      });
    }
  }

  async function deleteBackup(entry: BackupEntry) {
    if (!selectedFile) return;
    const shouldDelete = await confirm(t("confirm_delete_history"));
    if (!shouldDelete) return;

    setStatus({ tone: "loading", message: t("status_deleting_history") });
    try {
      if (isRemoteSource) {
        await invoke("delete_remote_backup", {
          connection: remoteConnection,
          path: entry.path,
        });
      } else {
        await invoke("delete_backup", { path: entry.path });
      }
      if (viewingPath === entry.path) {
        setViewingPath(null);
      }
      await refreshBackups(selectedFile.path);
      setStatus({ tone: "success", message: t("status_history_deleted") });
    } catch (error) {
      setStatus({
        tone: "error",
        message: t("status_delete_history_failed", { error: String(error) }),
      });
    }
  }

  async function clearHistory() {
    if (!selectedFile || backups.length === 0) return;
    const shouldClear = await confirm(t("confirm_clear_history"));
    if (!shouldClear) return;

    setStatus({ tone: "loading", message: t("status_clearing_history") });
    try {
      const removed = isRemoteSource
        ? await invoke<number>("clear_remote_backups", {
            connection: remoteConnection,
            path: selectedFile.path,
          })
        : await invoke<number>("clear_backups", {
            path: selectedFile.path,
          });
      if (viewingPath) {
        setViewingPath(null);
      }
      await refreshBackups(selectedFile.path);
      setStatus({
        tone: "success",
        message: t("status_history_cleared", { count: String(removed) }),
      });
    } catch (error) {
      setStatus({
        tone: "error",
        message: t("status_clear_history_failed", { error: String(error) }),
      });
    }
  }

  function clearDiff() {
    setDiffBase(null);
    setDiffTarget(null);
    setDiffLabel(null);
  }

  function toggleDir(path: string) {
    setCollapsedDirs((prev) => ({
      ...prev,
      [path]: !prev[path],
    }));
  }

  function renderFileButton(node: FileNode, showPath = false) {
    return (
      <button
        key={node.path}
        className={
          selectedFile?.path === node.path || loadingFilePath === node.path
            ? "tree-item tree-item-active"
            : "tree-item"
        }
        onClick={() => loadFile(node)}
        onContextMenu={(event) => {
          if (isRemoteSource) return;
          event.preventDefault();
          event.stopPropagation();
          setContextMenu({
            x: event.pageX,
            y: event.pageY,
            file: node,
          });
        }}
        type="button"
      >
        {renderFileIcon(node.name)}
        <span className="tree-label">{node.name}</span>
        {showPath && <span className="tree-path-label">{node.path}</span>}
      </button>
    );
  }

  function renderRemoteModal() {
    return (
      <div
        className="remote-modal"
        onClick={() => {
          if (!remoteConnecting) {
            setShowRemoteModal(false);
          }
        }}
      >
        <div className="remote-card" onClick={(event) => event.stopPropagation()}>
          <div className="remote-title">{t("remote_connect_title")}</div>
          <div className="remote-subtitle">{t("remote_connect_desc")}</div>
          <div className="remote-grid">
            <label className="remote-field">
              <span>{t("remote_host")}</span>
              <input
                className="remote-input"
                disabled={remoteConnecting}
                value={remoteForm.host}
                onChange={(event) =>
                  setRemoteForm((prev) => ({ ...prev, host: event.target.value }))
                }
                placeholder="example.com"
              />
            </label>
            <label className="remote-field">
              <span>{t("remote_user")}</span>
              <input
                className="remote-input"
                disabled={remoteConnecting}
                value={remoteForm.user}
                onChange={(event) =>
                  setRemoteForm((prev) => ({ ...prev, user: event.target.value }))
                }
                placeholder="root"
              />
            </label>
            <label className="remote-field">
              <span>{t("remote_port")}</span>
              <input
                className="remote-input"
                disabled={remoteConnecting}
                value={remoteForm.port}
                onChange={(event) =>
                  setRemoteForm((prev) => ({ ...prev, port: event.target.value }))
                }
                placeholder="22"
              />
            </label>
            <label className="remote-field">
              <span>{t("remote_password")}</span>
              <input
                className="remote-input"
                type="password"
                disabled={remoteConnecting}
                value={remoteForm.password}
                onChange={(event) =>
                  setRemoteForm((prev) => ({ ...prev, password: event.target.value }))
                }
                placeholder="••••••••"
              />
            </label>
            <label className="remote-field remote-field-wide">
              <span>{t("remote_path")}</span>
              <input
                className="remote-input"
                disabled={remoteConnecting}
                value={remoteForm.workspacePath}
                onChange={(event) =>
                  setRemoteForm((prev) => ({
                    ...prev,
                    workspacePath: event.target.value,
                  }))
                }
                placeholder="~/workspace"
              />
            </label>
            <label className="remote-field remote-field-wide">
              <span>{t("remote_identity")}</span>
              <input
                className="remote-input"
                disabled={remoteConnecting}
                value={remoteForm.identityFile}
                onChange={(event) =>
                  setRemoteForm((prev) => ({
                    ...prev,
                    identityFile: event.target.value,
                  }))
                }
                placeholder="~/.ssh/id_rsa"
              />
            </label>
          </div>
          <div className="remote-feedback" data-tone={status.tone}>
            {remoteConnecting ? (
              <>
                <span className="remote-spinner" aria-hidden />
                <span>{t("remote_connecting_hint")}</span>
              </>
            ) : (
              status.message
            )}
          </div>
          <div className="remote-actions">
            <button
              type="button"
              className="ghost"
              disabled={remoteConnecting}
              onClick={() => setShowRemoteModal(false)}
            >
              {t("close_remote_modal")}
            </button>
            <button
              type="button"
              className="primary remote-submit"
              onClick={connectRemote}
              disabled={remoteConnecting}
            >
              {remoteConnecting ? t("remote_connecting_button") : t("connect_remote")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  function renderCleanFileList() {
    if (!tree || flatFiles.length === 0) {
      return <div className="empty">{t("empty_tree")}</div>;
    }
    return flatFiles.map((file) => renderFileButton(file));
  }

  function renderTree(node: FileNode) {
    if (node.kind === "file") {
      return renderFileButton(node);
    }

    const isCollapsed = collapsedDirs[node.path] === true;

    return (
      <div key={node.path} className="tree-group">
        <button
          type="button"
          className="tree-group-title"
          onClick={() => toggleDir(node.path)}
        >
          <Folder className="tree-folder-icon" aria-hidden size={14} strokeWidth={1.5} />
          {node.name}
          <span className={`tree-caret ${isCollapsed ? "collapsed" : ""}`} />
        </button>
        {!isCollapsed && (
          <div className="tree-group-children">
            {node.children?.map((child) => renderTree(child))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="app">
      {showLanguageModal && (
        <div className="language-modal">
          <div className="language-card">
            <div className="language-title">{t("lang_title")}</div>
            <div className="language-subtitle">{t("lang_subtitle")}</div>
            <div className="language-options">
              <button
                type="button"
                className="language-button"
                onClick={() => applyLanguage("zh")}
              >
                {t("lang_zh")}
              </button>
              <button
                type="button"
                className="language-button"
                onClick={() => applyLanguage("en")}
              >
                {t("lang_en")}
              </button>
            </div>
          </div>
        </div>
      )}
      {showRemoteModal && renderRemoteModal()}
      <div className="titlebar">
        <div className="titlebar-spacer" data-tauri-drag-region />
        <div className="titlebar-actions">
          <div className="mode-switch titlebar-switch">
            <button
              type="button"
              className={sourceMode === "local" ? "mode active" : "mode"}
              onClick={() => switchSource("local")}
            >
              {t("source_local")}
            </button>
            <button
              type="button"
              className={sourceMode === "remote" ? "mode active" : "mode"}
              onClick={openRemotePanel}
            >
              {t("source_remote")}
            </button>
          </div>
          {isRemoteSource && (
            <div className="titlebar-icon-actions">
              <button
                type="button"
                className="titlebar-plain-icon"
                onClick={openRemotePanel}
                aria-label={remoteConnection ? t("edit_remote") : t("connect_remote")}
                title={remoteConnection ? t("edit_remote") : t("connect_remote")}
              >
                <Settings size={15} strokeWidth={1.7} />
              </button>
              {remoteConnection && (
                <button
                  type="button"
                  className="titlebar-plain-icon"
                  onClick={disconnectRemote}
                  aria-label={t("disconnect_remote")}
                  title={t("disconnect_remote")}
                >
                  <LogOut size={15} strokeWidth={1.7} />
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      {contextMenu && !isRemoteSource && (
        <div
          className="context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <button
            type="button"
            onClick={async () => {
              await revealItemInDir(contextMenu.file.path);
              setContextMenu(null);
            }}
          >
            {t("context_reveal")}
          </button>
        </div>
      )}
      <div className="layout">
        <aside className="sidebar">
          <div className="sidebar-header">
            <div>
              <div className="panel-title panel-title-toggle">
                {isRemoteSource
                  ? t("dir_remote")
                  : dirMode === "work"
                  ? t("dir_work")
                  : t("dir_config")}
                {!isRemoteSource && (
                  <button
                    type="button"
                    className="icon-button"
                    onClick={toggleDirectoryMode}
                    aria-label={
                      dirMode === "work" ? t("toggle_to_config") : t("toggle_to_work")
                    }
                    title={dirMode === "work" ? t("toggle_to_config") : t("toggle_to_work")}
                  >
                    <ArrowLeftRight size={14} strokeWidth={1.6} />
                  </button>
                )}
              </div>
              <div className="panel-subtitle">
                {workspacePath ?? t("no_dir_selected")}
              </div>
            </div>
            <div className="sidebar-actions">
              <div className="clean-mode-row">
                <span className="clean-mode-text">{t("clean_mode")}</span>
                <button
                  type="button"
                  className={cleanMode ? "clean-switch on" : "clean-switch"}
                  onClick={() => setCleanMode((prev) => !prev)}
                  aria-pressed={cleanMode}
                  aria-label={t("clean_mode")}
                >
                  <span className="clean-switch-knob" />
                </button>
              </div>
              {!isRemoteSource && (
                <button className="link-button" onClick={chooseWorkspace} type="button">
                  {t("choose_dir")}
                </button>
              )}
            </div>
          </div>
          <div className="sidebar-search">
            <input
              type="text"
              className="sidebar-search-input"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={t("search_files")}
              spellCheck={false}
            />
          </div>
          <div className="tree">
            {normalizedSearchQuery ? (
              visibleFiles.length === 0 ? (
                <div className="empty">{t("search_empty")}</div>
              ) : (
                visibleFiles.map((file) => renderFileButton(file, true))
              )
            ) : isRemoteSource && !remoteConnection ? (
              <div className="empty">{t("remote_empty")}</div>
            ) : cleanMode ? (
              renderCleanFileList()
            ) : tree ? (
              renderTree(tree)
            ) : (
              <div className="empty">{t("empty_tree")}</div>
            )}
          </div>
        </aside>

        <main className="content">
          <div className="content-header">
            <div>
              <div className="panel-title">{t("editor_title")}</div>
              <div className="panel-subtitle">
                {activeFilePath ?? t("editor_empty")}
              </div>
            </div>
            <div className="content-header-right">
              <div className="mode-switch">
                <button
                  type="button"
                  className={mode === "form" ? "mode active" : "mode"}
                  onClick={() => setMode("form")}
                  disabled={!selectedFile}
                >
                  {t("mode_form")}
                </button>
                <button
                  type="button"
                  className={mode === "source" ? "mode active" : "mode"}
                  onClick={() => setMode("source")}
                  disabled={!selectedFile}
                >
                  {t("mode_source")}
                </button>
                <button
                  type="button"
                  className={mode === "preview" ? "mode active" : "mode"}
                  onClick={() => setMode("preview")}
                  disabled={!selectedFile}
                >
                  {t("mode_preview")}
                </button>
              </div>
              {diffBase !== null && (
                <button type="button" className="ghost" onClick={clearDiff}>
                  {t("exit_diff")}
                </button>
              )}
            </div>
          </div>

          <div className="validation-row">
            {validation && (
              <div className={validation.ok ? "badge ok" : "badge error"}>
                {formatValidationMessage(validation)}
              </div>
            )}
            {selectedFile && isJsonFile(selectedFile) && isLargeJsonFile && (
              <div className="badge warn">{t("json_large_mode")}</div>
            )}
            <div className="validation-actions">
              <div className="save-hint">{t("save_hint")}</div>
              <div className="status" data-tone={status.tone}>
                {status.message}
              </div>
            </div>
          </div>

          <div className={isFileLoading ? "viewer viewer-loading" : "viewer"}>
            {showJumpToValidationError && (
              <button type="button" className="link-button jump-error-floating" onClick={jumpToValidationError}>
                {t("jump_to_error")}
              </button>
            )}
            {!selectedFile && <div className="empty">{t("no_file_selected")}</div>}
            {selectedFile && mode === "source" && isJsonFile(selectedFile) && (
              isLargeJsonFile ? (
                <textarea
                  ref={editorTextareaRef}
                  className="editor"
                  value={editedContent}
                  onChange={(event) => setEditedContent(event.target.value)}
                  spellCheck={false}
                />
              ) : (
                <CodeMirror
                  onCreateEditor={(view) => {
                    codeMirrorViewRef.current = view;
                  }}
                  value={editedContent}
                  height="100%"
                  theme={oneDark}
                  extensions={[jsonLang()]}
                  onChange={(value) => setEditedContent(value)}
                />
              )
            )}
            {selectedFile && mode === "source" && !isJsonFile(selectedFile) && (
              <textarea
                ref={editorTextareaRef}
                className="editor"
                value={editedContent}
                onChange={(event) => setEditedContent(event.target.value)}
                spellCheck={false}
              />
            )}
            {selectedFile && mode === "preview" && (
              <div className="preview">
                {diffBase !== null && diffTarget !== null ? (
                  <div className="diff-panel">
                    <div className="diff-title">
                      {diffLabel
                        ? t("history_label", { label: diffLabel })
                        : t("history_title")}
                    </div>
                    <ReactDiffViewer
                      oldValue={diffBase}
                      newValue={diffTarget}
                      splitView={true}
                      useDarkTheme={true}
                      compareMethod={DiffMethod.WORDS}
                    />
                  </div>
                ) : isMarkdownFile(selectedFile) ? (
                  <ReactMarkdown
                    components={{
                      code({ className, children }) {
                        const match = /language-(\w+)/.exec(className || "");
                        return match ? (
                          <SyntaxHighlighter
                            style={prismOneDark}
                            language={match[1]}
                            PreTag="div"
                          >
                            {String(children).replace(/\n$/, "")}
                          </SyntaxHighlighter>
                        ) : (
                          <code className={className}>{children}</code>
                        );
                      },
                    }}
                  >
                    {activeContent}
                  </ReactMarkdown>
                ) : isJsonFile(selectedFile) ? (
                  <SyntaxHighlighter
                    style={prismOneDark}
                    language="json"
                    PreTag="div"
                  >
                    {activeContent || "{}"}
                  </SyntaxHighlighter>
                ) : (
                  <pre>{activeContent || t("empty_content")}</pre>
                )}
              </div>
            )}
            {selectedFile && mode === "form" && (
              <div className="form-view">
                {structured.length === 0 ? (
                  <div className="empty">{t("form_empty")}</div>
                ) : (
                  structured.map((entry) => (
                    <div key={entry.key} className="form-row">
                      <span className="form-key">{entry.key}</span>
                      <span className="form-value">{entry.value}</span>
                    </div>
                  ))
                )}
              </div>
            )}
            {isFileLoading && (
              <div className="viewer-loading-overlay">
                <span className="remote-spinner viewer-spinner" aria-hidden />
                <span>{t("file_loading_hint")}</span>
              </div>
            )}
          </div>
        </main>

        <aside className="inspector">
          <div className="panel-title">{t("inspector_title")}</div>
          {fileMeta ? (
            <div className="meta">
              <div className="meta-row">
                <span className="meta-label">{t("meta_name")}</span>
                <span className="meta-value">{fileMeta.name}</span>
              </div>
              <div className="meta-row">
                <span className="meta-label">{t("meta_type")}</span>
                <span className="meta-value">{fileMeta.extension}</span>
              </div>
              <div className="meta-row">
                <span className="meta-label">{t("meta_path")}</span>
                <span className="meta-value">{fileMeta.path}</span>
              </div>
            </div>
          ) : (
            <div className="empty">{t("inspector_empty")}</div>
          )}
          <div className="divider" />
          <div className="inspector-section-header">
            <div className="panel-title">{t("history_title")}</div>
            <button
              className="link-button"
              onClick={clearHistory}
              type="button"
              disabled={!selectedFile || backups.length === 0}
            >
              {t("action_clear_history")}
            </button>
          </div>
          {backups.length === 0 && (
            <div className="empty">{t("history_empty")}</div>
          )}
          {backups.map((entry) => (
            <div key={entry.path} className="backup-row">
              <button
                className="backup-item"
                onClick={() => viewBackup(entry)}
                type="button"
              >
                {t("action_view")}
              </button>
              <button
                className="backup-item ghost"
                onClick={() => diffWithBackup(entry)}
                type="button"
              >
                {t("action_diff")}
              </button>
              <button
                className="backup-item ghost"
                onClick={() => deleteBackup(entry)}
                type="button"
              >
                {t("action_delete")}
              </button>
              <span className="backup-label">{entry.name}</span>
            </div>
          ))}
          {viewingPath && <div className="empty">{t("viewing_history")}</div>}
        </aside>
      </div>
      <div className="app-copyright">© 2026 Forclaw. Made with love by XuYi</div>
    </div>
  );
}

export default App;

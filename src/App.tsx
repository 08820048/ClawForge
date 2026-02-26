import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import ReactMarkdown from "react-markdown";
import CodeMirror from "@uiw/react-codemirror";
import { json as jsonLang } from "@codemirror/lang-json";
import { oneDark } from "@codemirror/theme-one-dark";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark as prismOneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import ReactDiffViewer, { DiffMethod } from "react-diff-viewer-continued";
import { ArrowLeftRight, FileJson, Folder, Heading } from "lucide-react";
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
};

type BackupEntry = {
  name: string;
  path: string;
};

type FlatEntry = {
  key: string;
  value: string;
};

type ViewMode = "form" | "source" | "preview";

type WorkspaceDetect = {
  path: string | null;
  source: string;
  exists: boolean;
};

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
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [configPath, setConfigPath] = useState<string | null>(null);
  const [workPath, setWorkPath] = useState<string | null>(null);
  const [dirMode, setDirMode] = useState<"config" | "work">("config");
  const [tree, setTree] = useState<FileNode | null>(null);
  const [selectedFile, setSelectedFile] = useState<FileNode | null>(null);
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
  const [collapsedDirs, setCollapsedDirs] = useState<Record<string, boolean>>(
    {},
  );
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    file: FileNode;
  } | null>(null);

  const fileMeta = useMemo(() => {
    if (!selectedFile) return null;
    const extension = selectedFile.name.split(".").pop() ?? "";
    return {
      name: selectedFile.name,
      path: selectedFile.path,
      extension: extension.toUpperCase(),
    };
  }, [selectedFile]);

  const activeContent = viewingPath ? fileContent : editedContent;

  useEffect(() => {
    const autoDetect = async () => {
      setStatus({ tone: "loading", message: "自动识别工作区..." });
      try {
        const result = await invoke<WorkspaceDetect>("detect_workspace");
        if (result.path && result.exists) {
          setConfigPath(result.path);
          if (dirMode === "config") {
            await scanWorkspace(result.path, `已自动识别：${result.source}`);
          } else {
            setStatus({
              tone: "success",
              message: `已检测到配置目录：${result.path}`,
            });
          }
        } else if (result.path && !result.exists) {
          setConfigPath(result.path);
          if (dirMode === "config") {
            setWorkspacePath(result.path);
            setTree(null);
            setStatus({
              tone: "error",
              message: `检测到路径但不存在：${result.path}`,
            });
          } else {
            setStatus({
              tone: "error",
              message: `检测到配置目录但不存在：${result.path}`,
            });
          }
        } else {
          setStatus({
            tone: "idle",
            message: "未检测到默认工作区，请手动选择。",
          });
        }
      } catch (error) {
        setStatus({
          tone: "error",
          message: `自动识别失败：${String(error)}`,
        });
      }
    };

    autoDetect();
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
    if (!selectedFile || !isJsonFile(selectedFile)) return;
    const handle = window.setTimeout(() => {
      if (editedContent.trim().length === 0) {
        setValidation({
          ok: false,
          kind: "json",
          message: "JSON 为空",
        });
        return;
      }
      try {
        JSON.parse(editedContent);
        setValidation({
          ok: true,
          kind: "json",
          message: "JSON 校验通过（实时）",
        });
      } catch (error) {
        setValidation({
          ok: false,
          kind: "json",
          message: String(error),
        });
      }
    }, 300);

    return () => window.clearTimeout(handle);
  }, [editedContent, selectedFile]);

  useEffect(() => {
    if (diffBase === null) return;
    setDiffTarget(editedContent);
  }, [editedContent, diffBase]);

  async function chooseWorkspace() {
    setStatus({ tone: "loading", message: "选择目录..." });
    const selected = await open({ directory: true, multiple: false });
    if (!selected || typeof selected !== "string") {
      setStatus({ tone: "idle", message: "已取消选择。" });
      return;
    }

    setConfigPath(selected);
    if (dirMode === "config") {
      await scanWorkspace(selected, "扫描完成。");
      return;
    }
    setStatus({ tone: "idle", message: "已更新配置目录，切换后查看。" });
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
        message: `扫描失败：${String(error)}`,
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
    const nextMode = dirMode === "config" ? "work" : "config";
    setDirMode(nextMode);
    if (nextMode === "work") {
      const path = await resolveWorkPath();
      await scanWorkspace(path, "扫描完成。");
      return;
    }

    if (configPath) {
      await scanWorkspace(configPath, "扫描完成。");
      return;
    }

    setWorkspacePath(null);
    setTree(null);
    setStatus({ tone: "idle", message: "未检测到默认工作区，请手动选择。" });
  }

  function resetEditor() {
    setSelectedFile(null);
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
    setSelectedFile(node);
    setStatus({ tone: "loading", message: "读取文件..." });
    setViewingPath(null);

    try {
      const content = await invoke<string>("read_file", { path: node.path });
      setFileContent(content);
      setEditedContent(content);
      setStatus({ tone: "idle", message: "" });
    } catch (error) {
      setFileContent("");
      setEditedContent("");
      setStatus({
        tone: "error",
        message: `读取失败：${String(error)}`,
      });
    }

    try {
      const result = await invoke<ValidationResult>("validate_file", {
        path: node.path,
      });
      setValidation(result);
    } catch (error) {
      setValidation({ ok: false, kind: "unknown", message: String(error) });
    }

    try {
      const structuredValue = await invoke<unknown>("parse_structured", {
        path: node.path,
      });
      setStructured(flattenValue(structuredValue));
    } catch {
      setStructured([]);
    }

    try {
      const list = await invoke<BackupEntry[]>("list_backups", {
        path: node.path,
      });
      setBackups(list);
    } catch {
      setBackups([]);
    }

    setDiffBase(null);
    setDiffTarget(null);
    setDiffLabel(null);
  }

  async function saveCurrent() {
    if (!selectedFile) return;
    setStatus({ tone: "loading", message: "保存中..." });
    try {
      await invoke("save_file", {
        path: selectedFile.path,
        content: editedContent,
      });
      setFileContent(editedContent);
      const list = await invoke<BackupEntry[]>("list_backups", {
        path: selectedFile.path,
      });
      setBackups(list);
      setStatus({ tone: "success", message: "已保存并创建备份" });
    } catch (error) {
      setStatus({
        tone: "error",
        message: `保存失败：${String(error)}`,
      });
    }
  }

  async function viewBackup(entry: BackupEntry) {
    setStatus({ tone: "loading", message: "读取历史版本..." });
    try {
      const content = await invoke<string>("read_file", { path: entry.path });
      setFileContent(content);
      setViewingPath(entry.path);
      setStatus({ tone: "idle", message: "" });
    } catch (error) {
      setStatus({
        tone: "error",
        message: `读取失败：${String(error)}`,
      });
    }
  }

  async function diffWithBackup(entry: BackupEntry) {
    if (!selectedFile) return;
    setStatus({ tone: "loading", message: "生成差异对比..." });
    try {
      const backupContent = await invoke<string>("read_file", {
        path: entry.path,
      });
      setDiffBase(backupContent);
      setDiffTarget(editedContent);
      setDiffLabel(entry.name);
      setMode("preview");
      setStatus({ tone: "idle", message: "" });
    } catch (error) {
      setStatus({
        tone: "error",
        message: `对比失败：${String(error)}`,
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

  function renderTree(node: FileNode) {
    if (node.kind === "file") {
      return (
        <button
          key={node.path}
          className={
            selectedFile?.path === node.path
              ? "tree-item tree-item-active"
              : "tree-item"
          }
          onClick={() => loadFile(node)}
          onContextMenu={(event) => {
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
        </button>
      );
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
      {contextMenu && (
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
            在文件夹中显示
          </button>
        </div>
      )}
      <div className="layout">
        <aside className="sidebar">
          <div className="sidebar-header">
            <div>
              <div className="panel-title panel-title-toggle">
                {dirMode === "work" ? "工作目录" : "配置目录"}
                <button
                  type="button"
                  className="icon-button"
                  onClick={toggleDirectoryMode}
                  aria-label={
                    dirMode === "work" ? "切换到配置目录" : "切换到工作目录"
                  }
                  title={dirMode === "work" ? "切换到配置目录" : "切换到工作目录"}
                >
                  <ArrowLeftRight size={14} strokeWidth={1.6} />
                </button>
              </div>
              <div className="panel-subtitle">
                {workspacePath ?? "尚未选择目录"}
              </div>
            </div>
            <button className="link-button" onClick={chooseWorkspace} type="button">
              选择目录
            </button>
          </div>
          <div className="tree">
            {tree ? (
              renderTree(tree)
            ) : (
              <div className="empty">选择目录后显示文件树。</div>
            )}
          </div>
        </aside>

        <main className="content">
          <div className="content-header">
            <div>
              <div className="panel-title">编辑区</div>
              <div className="panel-subtitle">
                {selectedFile ? selectedFile.path : "请选择文件进行编辑"}
              </div>
            </div>
            <div className="mode-switch">
              <button
                type="button"
                className={mode === "form" ? "mode active" : "mode"}
                onClick={() => setMode("form")}
                disabled={!selectedFile}
              >
                表单视图
              </button>
              <button
                type="button"
                className={mode === "source" ? "mode active" : "mode"}
                onClick={() => setMode("source")}
                disabled={!selectedFile}
              >
                源码视图
              </button>
              <button
                type="button"
                className={mode === "preview" ? "mode active" : "mode"}
                onClick={() => setMode("preview")}
                disabled={!selectedFile}
              >
                预览视图
              </button>
            </div>
            {diffBase !== null && (
              <button type="button" className="ghost" onClick={clearDiff}>
                退出对比
              </button>
            )}
          </div>

          <div className="validation-row">
            {validation && (
              <div className={validation.ok ? "badge ok" : "badge error"}>
                {validation.message}
              </div>
            )}
            <div className="validation-actions">
              <button
                className="ghost"
                onClick={saveCurrent}
                type="button"
                disabled={!selectedFile || mode !== "source"}
                title="Ctrl+S / Cmd+S"
              >
                保存
              </button>
              <div className="status" data-tone={status.tone}>
                {status.message}
              </div>
            </div>
          </div>

          <div className="viewer">
            {!selectedFile && <div className="empty">尚未选择文件。</div>}
            {selectedFile && mode === "source" && isJsonFile(selectedFile) && (
              <CodeMirror
                value={editedContent}
                height="100%"
                theme={oneDark}
                extensions={[jsonLang()]}
                onChange={(value) => setEditedContent(value)}
              />
            )}
            {selectedFile && mode === "source" && !isJsonFile(selectedFile) && (
              <textarea
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
                      {diffLabel ? `历史版本: ${diffLabel}` : "历史版本"}
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
                  <pre>{activeContent || "(空文件或未加载)"}</pre>
                )}
              </div>
            )}
            {selectedFile && mode === "form" && (
              <div className="form-view">
                {structured.length === 0 ? (
                  <div className="empty">暂无结构化数据可展示。</div>
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
          </div>
        </main>

        <aside className="inspector">
          <div className="panel-title">检查器</div>
          {fileMeta ? (
            <div className="meta">
              <div className="meta-row">
                <span className="meta-label">名称</span>
                <span className="meta-value">{fileMeta.name}</span>
              </div>
              <div className="meta-row">
                <span className="meta-label">类型</span>
                <span className="meta-value">{fileMeta.extension}</span>
              </div>
              <div className="meta-row">
                <span className="meta-label">路径</span>
                <span className="meta-value">{fileMeta.path}</span>
              </div>
            </div>
          ) : (
            <div className="empty">选择文件后显示属性。</div>
          )}
          <div className="divider" />
          <div className="panel-title">历史版本</div>
          {backups.length === 0 && (
            <div className="empty">暂无历史版本。</div>
          )}
          {backups.map((entry) => (
            <div key={entry.path} className="backup-row">
              <button
                className="backup-item"
                onClick={() => viewBackup(entry)}
                type="button"
              >
                查看
              </button>
              <button
                className="backup-item ghost"
                onClick={() => diffWithBackup(entry)}
                type="button"
              >
                对比
              </button>
              <span className="backup-label">{entry.name}</span>
            </div>
          ))}
          {viewingPath && <div className="empty">正在查看历史版本。</div>}
        </aside>
      </div>
    </div>
  );
}

export default App;

use crate::protocol::Diagnostic;
use anyhow::{Context, Result};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};
use url::Url;

#[derive(Debug)]
pub struct LspManager {
    client: Option<LspClient>,
    current_uri: Option<String>,
    status: String,
}

#[derive(Debug)]
struct LspClient {
    server: ServerSpec,
    child: Child,
    stdin: ChildStdin,
    rx: Receiver<Value>,
    next_id: u64,
    diagnostics: HashMap<String, Vec<Diagnostic>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ServerSpec {
    name: &'static str,
    command: &'static str,
    args: &'static [&'static str],
    language_id: &'static str,
}

impl LspManager {
    pub fn new() -> Self {
        Self {
            client: None,
            current_uri: None,
            status: "lsp: idle".to_owned(),
        }
    }

    pub fn refresh_for_file(&mut self, filename: Option<&str>, text: &str, version: u64) {
        self.shutdown_current();
        self.current_uri = filename.and_then(file_uri);

        let Some(filename) = filename else {
            self.status = "lsp: plain text".to_owned();
            return;
        };
        let Some(spec) = server_for(filename) else {
            self.status = "lsp: plain text".to_owned();
            return;
        };
        if !server_command_works(&spec) {
            self.status = format!("lsp: {} missing", spec.command);
            return;
        }

        match LspClient::start(spec.clone(), filename, text, version) {
            Ok(client) => {
                self.status = format!("lsp: {} ready", spec.name);
                self.client = Some(client);
            }
            Err(error) => {
                self.status = format!("lsp: {} failed: {error}", spec.name);
                self.client = None;
            }
        }
    }

    pub fn did_change(&mut self, filename: Option<&str>, text: &str, version: u64) {
        let Some(client) = self.client.as_mut() else {
            return;
        };
        let Some(uri) = filename.and_then(file_uri) else {
            return;
        };
        if self.current_uri.as_deref() != Some(uri.as_str()) {
            return;
        }
        client.drain();
        let version = version_i32(version);
        let _ = client.notify(
            "textDocument/didChange",
            json!({
                "textDocument": { "uri": uri, "version": version },
                "contentChanges": [{ "text": text }],
            }),
        );
    }

    pub fn did_save(&mut self, filename: Option<&str>, text: &str) {
        let Some(client) = self.client.as_mut() else {
            return;
        };
        let Some(uri) = filename.and_then(file_uri) else {
            return;
        };
        client.drain();
        let _ = client.notify(
            "textDocument/didSave",
            json!({
                "textDocument": { "uri": uri },
                "text": text,
            }),
        );
    }

    pub fn hover(&mut self, filename: Option<&str>, row: usize, col: usize) -> LspActionResult {
        self.position_request("textDocument/hover", "hover", filename, row, col)
    }

    pub fn definition(
        &mut self,
        filename: Option<&str>,
        row: usize,
        col: usize,
    ) -> LspActionResult {
        self.position_request("textDocument/definition", "definition", filename, row, col)
    }

    pub fn status_for(&mut self, _filename: Option<&str>) -> String {
        if let Some(client) = self.client.as_mut() {
            client.drain();
        }
        self.status.clone()
    }

    pub fn diagnostics_for(&mut self, filename: Option<&str>) -> Vec<Diagnostic> {
        let Some(client) = self.client.as_mut() else {
            return Vec::new();
        };
        client.drain();
        let Some(uri) = filename.and_then(file_uri) else {
            return Vec::new();
        };
        client.diagnostics.get(&uri).cloned().unwrap_or_default()
    }

    fn position_request(
        &mut self,
        method: &str,
        kind: &str,
        filename: Option<&str>,
        row: usize,
        col: usize,
    ) -> LspActionResult {
        let Some(client) = self.client.as_mut() else {
            return LspActionResult::unavailable(kind, &self.status);
        };
        let Some(uri) = filename.and_then(file_uri) else {
            return LspActionResult::unavailable(kind, "lsp: no file");
        };
        if self.current_uri.as_deref() != Some(uri.as_str()) {
            return LspActionResult::unavailable(kind, "lsp: inactive document");
        }

        let params = json!({
            "textDocument": { "uri": uri },
            "position": { "line": row, "character": col },
        });
        match client.request(method, params, Duration::from_millis(900)) {
            Ok(Some(result)) => LspActionResult {
                kind: kind.to_owned(),
                status: self.status.clone(),
                result: Some(normalize_lsp_result(kind, result)),
            },
            Ok(None) => LspActionResult {
                kind: kind.to_owned(),
                status: self.status.clone(),
                result: None,
            },
            Err(error) => LspActionResult {
                kind: kind.to_owned(),
                status: format!("lsp: {error}"),
                result: Some(json!({ "available": false, "message": error.to_string() })),
            },
        }
    }

    fn shutdown_current(&mut self) {
        if let Some(mut client) = self.client.take() {
            let _ = client.request("shutdown", json!(null), Duration::from_millis(200));
            let _ = client.notify("exit", json!(null));
            let _ = client.child.kill();
            let _ = client.child.wait();
        }
    }
}

impl Drop for LspManager {
    fn drop(&mut self) {
        self.shutdown_current();
    }
}

#[derive(Debug)]
pub struct LspActionResult {
    pub kind: String,
    pub status: String,
    pub result: Option<Value>,
}

impl LspActionResult {
    fn unavailable(kind: &str, status: &str) -> Self {
        Self {
            kind: kind.to_owned(),
            status: status.to_owned(),
            result: Some(json!({ "available": false, "message": status })),
        }
    }
}

impl LspClient {
    fn start(spec: ServerSpec, filename: &str, text: &str, version: u64) -> Result<Self> {
        let mut child = Command::new(spec.command)
            .args(spec.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .with_context(|| format!("spawning {}", spec.command))?;
        let stdin = child.stdin.take().context("missing LSP stdin")?;
        let stdout = child.stdout.take().context("missing LSP stdout")?;
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || read_lsp_stdout(stdout, tx));

        let mut client = Self {
            server: spec,
            child,
            stdin,
            rx,
            next_id: 1,
            diagnostics: HashMap::new(),
        };

        let root_uri = workspace_root_uri(filename);
        let init = client.request(
            "initialize",
            json!({
                "processId": null,
                "rootUri": root_uri,
                "capabilities": {
                    "textDocument": {
                        "synchronization": { "didSave": true },
                        "hover": { "dynamicRegistration": false },
                        "definition": { "dynamicRegistration": false },
                        "publishDiagnostics": { "relatedInformation": false }
                    }
                }
            }),
            Duration::from_secs(3),
        )?;
        if init.is_none() {
            anyhow::bail!("initialize timed out");
        }
        client.notify("initialized", json!({}))?;
        client.did_open(filename, text, version)?;
        Ok(client)
    }

    fn did_open(&mut self, filename: &str, text: &str, version: u64) -> Result<()> {
        let uri = file_uri(filename).context("invalid file URI")?;
        let version = version_i32(version);
        self.notify(
            "textDocument/didOpen",
            json!({
                "textDocument": {
                    "uri": uri,
                    "languageId": self.server.language_id,
                    "version": version,
                    "text": text,
                }
            }),
        )
    }

    fn request(&mut self, method: &str, params: Value, timeout: Duration) -> Result<Option<Value>> {
        let id = self.next_id;
        self.next_id += 1;
        self.write(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))?;

        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match self
                .rx
                .recv_timeout(remaining.min(Duration::from_millis(50)))
            {
                Ok(message) => {
                    if message.get("id").and_then(Value::as_u64) == Some(id) {
                        if let Some(error) = message.get("error") {
                            anyhow::bail!("{method} failed: {error}");
                        }
                        return Ok(message.get("result").cloned());
                    }
                    self.handle_message(message);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => anyhow::bail!("server disconnected"),
            }
        }
        anyhow::bail!("{method} timed out")
    }

    fn notify(&mut self, method: &str, params: Value) -> Result<()> {
        self.write(json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }))
    }

    fn write(&mut self, value: Value) -> Result<()> {
        let body = serde_json::to_vec(&value)?;
        write!(self.stdin, "Content-Length: {}\r\n\r\n", body.len())?;
        self.stdin.write_all(&body)?;
        self.stdin.flush()?;
        Ok(())
    }

    fn drain(&mut self) {
        while let Ok(message) = self.rx.try_recv() {
            self.handle_message(message);
        }
    }

    fn handle_message(&mut self, message: Value) {
        if let (Some(id), Some(_method)) = (
            message.get("id").cloned(),
            message.get("method").and_then(Value::as_str),
        ) {
            let _ = self.write(json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": null,
            }));
        }

        if message.get("method").and_then(Value::as_str) == Some("textDocument/publishDiagnostics")
            && let Some(params) = message.get("params")
        {
            let uri = params
                .get("uri")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            let diagnostics = params
                .get("diagnostics")
                .and_then(Value::as_array)
                .map(|items| items.iter().filter_map(parse_diagnostic).collect())
                .unwrap_or_default();
            if !uri.is_empty() {
                self.diagnostics.insert(uri, diagnostics);
            }
        }
    }
}

fn read_lsp_stdout(stdout: impl Read, tx: mpsc::Sender<Value>) {
    let mut reader = BufReader::new(stdout);
    while let Ok(Some(body)) = read_lsp_frame(&mut reader) {
        if let Ok(value) = serde_json::from_slice::<Value>(&body) {
            let _ = tx.send(value);
        }
    }
}

pub fn read_lsp_frame(reader: &mut impl BufRead) -> Result<Option<Vec<u8>>> {
    let mut content_length = None;
    loop {
        let mut line = String::new();
        let read = reader.read_line(&mut line)?;
        if read == 0 {
            return Ok(None);
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some((name, value)) = trimmed.split_once(':')
            && name.eq_ignore_ascii_case("content-length")
        {
            content_length = Some(value.trim().parse::<usize>()?);
        }
    }

    let Some(len) = content_length else {
        anyhow::bail!("missing Content-Length");
    };
    let mut body = vec![0; len];
    reader.read_exact(&mut body)?;
    Ok(Some(body))
}

fn parse_diagnostic(value: &Value) -> Option<Diagnostic> {
    let range = value.get("range")?;
    let start = range.get("start")?;
    let end = range.get("end")?;
    Some(Diagnostic {
        row: start.get("line")?.as_u64()? as usize,
        start_col: start.get("character")?.as_u64()? as usize,
        end_col: end.get("character")?.as_u64()? as usize,
        severity: severity_name(value.get("severity").and_then(Value::as_u64)),
        message: value.get("message")?.as_str()?.to_owned(),
        source: value
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or("lsp")
            .to_owned(),
    })
}

fn severity_name(severity: Option<u64>) -> String {
    match severity {
        Some(1) => "error",
        Some(2) => "warning",
        Some(3) => "info",
        Some(4) => "hint",
        _ => "info",
    }
    .to_owned()
}

fn normalize_lsp_result(kind: &str, result: Value) -> Value {
    if kind == "definition"
        && let Some(target) = first_location(&result)
    {
        return json!({ "available": true, "target": target, "raw": result });
    }
    if kind == "hover" {
        return json!({
            "available": !result.is_null(),
            "text": hover_text(&result),
            "raw": result,
        });
    }
    result
}

fn first_location(value: &Value) -> Option<Value> {
    if value.is_null() {
        return None;
    }
    let location = if let Some(items) = value.as_array() {
        items.first()?
    } else {
        value
    };
    let uri = location
        .get("uri")
        .or_else(|| location.pointer("/targetUri"))?
        .as_str()?;
    let range = location
        .get("range")
        .or_else(|| location.pointer("/targetSelectionRange"))?;
    let start = range.get("start")?;
    let path = uri_to_path(uri).unwrap_or_else(|| uri.to_owned());
    Some(json!({
        "uri": uri,
        "path": path,
        "row": start.get("line").and_then(Value::as_u64).unwrap_or(0),
        "col": start.get("character").and_then(Value::as_u64).unwrap_or(0),
    }))
}

fn hover_text(value: &Value) -> String {
    let Some(contents) = value.get("contents") else {
        return String::new();
    };
    markdown_text(contents)
}

fn markdown_text(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.to_owned();
    }
    if let Some(value_text) = value.get("value").and_then(Value::as_str) {
        return value_text.to_owned();
    }
    if let Some(items) = value.as_array() {
        return items
            .iter()
            .map(markdown_text)
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");
    }
    String::new()
}

fn server_for(filename: &str) -> Option<ServerSpec> {
    match Path::new(filename).extension().and_then(|ext| ext.to_str()) {
        Some("ts") => Some(ServerSpec {
            name: "typescript-language-server",
            command: "typescript-language-server",
            args: &["--stdio"],
            language_id: "typescript",
        }),
        Some("tsx") => Some(ServerSpec {
            name: "typescript-language-server",
            command: "typescript-language-server",
            args: &["--stdio"],
            language_id: "typescriptreact",
        }),
        Some("js" | "mjs" | "cjs") => Some(ServerSpec {
            name: "typescript-language-server",
            command: "typescript-language-server",
            args: &["--stdio"],
            language_id: "javascript",
        }),
        Some("jsx") => Some(ServerSpec {
            name: "typescript-language-server",
            command: "typescript-language-server",
            args: &["--stdio"],
            language_id: "javascriptreact",
        }),
        Some("rs") => Some(ServerSpec {
            name: "rust-analyzer",
            command: "rust-analyzer",
            args: &[],
            language_id: "rust",
        }),
        Some("py") => Some(ServerSpec {
            name: "pyright-langserver",
            command: "pyright-langserver",
            args: &["--stdio"],
            language_id: "python",
        }),
        _ => None,
    }
}

fn executable_exists(name: &str) -> bool {
    Command::new("sh")
        .arg("-lc")
        .arg(format!("command -v {}", shell_escape(name)))
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn server_command_works(spec: &ServerSpec) -> bool {
    if !executable_exists(spec.command) {
        return false;
    }

    Command::new(spec.command)
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn shell_escape(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn file_uri(filename: &str) -> Option<String> {
    let path = PathBuf::from(filename);
    let abs = if path.is_absolute() {
        path
    } else {
        std::env::current_dir().ok()?.join(path)
    };
    Url::from_file_path(abs).ok().map(|url| url.to_string())
}

fn workspace_root_uri(filename: &str) -> Option<String> {
    let path = PathBuf::from(filename);
    let abs = if path.is_absolute() {
        path
    } else {
        std::env::current_dir().ok()?.join(path)
    };
    let dir = abs.parent()?;
    Url::from_directory_path(dir)
        .ok()
        .map(|url| url.to_string())
}

fn uri_to_path(uri: &str) -> Option<String> {
    Url::parse(uri)
        .ok()?
        .to_file_path()
        .ok()
        .map(|path| path.to_string_lossy().to_string())
}

fn version_i32(version: u64) -> i32 {
    version.min(i32::MAX as u64) as i32
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn parses_content_length_frame_with_partial_body() {
        let mut input = Cursor::new(b"Content-Length: 15\r\n\r\n{\"jsonrpc\":\"2\"}".to_vec());
        let body = read_lsp_frame(&mut input).unwrap().unwrap();
        assert_eq!(body, br#"{"jsonrpc":"2"}"#);
    }

    #[test]
    fn selects_expected_language_servers() {
        assert_eq!(server_for("x.ts").unwrap().args, &["--stdio"] as &[&str]);
        assert_eq!(server_for("x.rs").unwrap().command, "rust-analyzer");
        assert_eq!(server_for("x.py").unwrap().language_id, "python");
    }

    #[test]
    fn parses_lsp_diagnostic() {
        let value = json!({
            "range": {
                "start": { "line": 2, "character": 4 },
                "end": { "line": 2, "character": 9 }
            },
            "severity": 1,
            "message": "broken",
            "source": "mock"
        });
        let diag = parse_diagnostic(&value).unwrap();
        assert_eq!(diag.row, 2);
        assert_eq!(diag.severity, "error");
        assert_eq!(diag.message, "broken");
    }

    #[test]
    fn normalizes_definition_location() {
        let value = json!([{
            "uri": file_uri("src/main.rs").unwrap(),
            "range": {
                "start": { "line": 7, "character": 3 },
                "end": { "line": 7, "character": 9 }
            }
        }]);
        let normalized = normalize_lsp_result("definition", value);
        assert_eq!(normalized["available"], true);
        assert_eq!(normalized["target"]["row"], 7);
    }
}

use crate::protocol::Diagnostic;
use std::path::Path;
use std::process::Command;

#[derive(Debug, Default)]
pub struct LspManager {
    status: String,
}

impl LspManager {
    pub fn new() -> Self {
        Self {
            status: "lsp: idle".to_owned(),
        }
    }

    pub fn refresh_for_file(&mut self, filename: Option<&str>) {
        self.status = match filename.and_then(language_server_for) {
            Some(server) if executable_exists(server) => format!("lsp: {server} available"),
            Some(server) => format!("lsp: {server} missing"),
            None => "lsp: plain text".to_owned(),
        };
    }

    pub fn status_for(&self, _filename: Option<&str>) -> String {
        self.status.clone()
    }

    pub fn diagnostics_for(&self, filename: Option<&str>, lines: &[String]) -> Vec<Diagnostic> {
        let mut diagnostics = Vec::new();
        let source = match filename.and_then(language_server_for) {
            Some(server) => format!("lsp/{server}"),
            None => "core".to_owned(),
        };

        for (row, line) in lines.iter().enumerate() {
            for needle in ["TODO", "FIXME"] {
                if let Some(col) = line.find(needle) {
                    diagnostics.push(Diagnostic {
                        row,
                        start_col: col,
                        end_col: col + needle.len(),
                        severity: "hint".to_owned(),
                        message: format!("{needle} marker"),
                        source: source.clone(),
                    });
                }
            }
        }

        diagnostics
    }
}

fn language_server_for(filename: &str) -> Option<&'static str> {
    match Path::new(filename).extension().and_then(|ext| ext.to_str()) {
        Some("ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs") => Some("typescript-language-server"),
        Some("rs") => Some("rust-analyzer"),
        Some("py") => Some("pyright-langserver"),
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

fn shell_escape(value: &str) -> String {
    value.replace('\'', "'\\''")
}

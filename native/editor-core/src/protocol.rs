use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct Cursor {
    pub row: usize,
    pub col: usize,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct Viewport {
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxToken {
    pub row: usize,
    pub start_col: usize,
    pub end_col: usize,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub row: usize,
    pub start_col: usize,
    pub end_col: usize,
    pub severity: String,
    pub message: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    #[serde(rename = "type")]
    pub type_: &'static str,
    pub protocol_version: u8,
    pub buffer_id: String,
    pub revision: u64,
    pub width: usize,
    pub height: usize,
    pub cursor: Cursor,
    pub lines: Vec<String>,
    pub dirty: bool,
    pub filename: Option<String>,
    pub status: String,
    pub total_lines: usize,
    pub viewport: Viewport,
    pub visible_lines: Vec<String>,
    pub tokens: Vec<SyntaxToken>,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum Command {
    #[serde(rename = "open")]
    Open { filename: String },
    #[serde(rename = "insert")]
    Insert { text: String },
    #[serde(rename = "deleteBackward")]
    DeleteBackward,
    #[serde(rename = "deleteForward")]
    DeleteForward,
    #[serde(rename = "deleteLine")]
    DeleteLine,
    #[serde(rename = "deleteRange", rename_all = "camelCase")]
    DeleteRange {
        start_row: usize,
        start_col: usize,
        end_row: usize,
        end_col: usize,
    },
    #[serde(rename = "move")]
    Move { direction: MoveDirection },
    #[serde(rename = "moveTo")]
    MoveTo { row: usize, col: usize },
    #[serde(rename = "save")]
    Save,
    #[serde(rename = "undo")]
    Undo,
    #[serde(rename = "redo")]
    Redo,
    #[serde(rename = "resize")]
    Resize { width: usize, height: usize },
    #[serde(rename = "setViewport")]
    SetViewport { start: usize, height: usize },
    #[serde(rename = "hover")]
    Hover { row: usize, col: usize },
    #[serde(rename = "goToDefinition")]
    GoToDefinition { row: usize, col: usize },
    #[serde(rename = "completion")]
    Completion { row: usize, col: usize },
    #[serde(rename = "format")]
    Format,
    #[serde(rename = "quit")]
    Quit,
}

#[derive(Debug, Clone, Copy, Deserialize)]
pub enum MoveDirection {
    #[serde(rename = "up")]
    Up,
    #[serde(rename = "down")]
    Down,
    #[serde(rename = "left")]
    Left,
    #[serde(rename = "right")]
    Right,
    #[serde(rename = "home")]
    Home,
    #[serde(rename = "end")]
    End,
    #[serde(rename = "wordForward")]
    WordForward,
    #[serde(rename = "wordBackward")]
    WordBackward,
    #[serde(rename = "fileStart")]
    FileStart,
    #[serde(rename = "fileEnd")]
    FileEnd,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum OutMessage {
    Ready {
        #[serde(rename = "type")]
        type_: &'static str,
    },
    Snapshot(Snapshot),
    Saved {
        #[serde(rename = "type")]
        type_: &'static str,
        filename: Option<String>,
    },
    Error {
        #[serde(rename = "type")]
        type_: &'static str,
        message: String,
    },
    LspResponse {
        #[serde(rename = "type")]
        type_: &'static str,
        kind: String,
        status: String,
        result: Option<serde_json::Value>,
    },
}

impl OutMessage {
    pub fn error(message: String) -> Self {
        Self::Error {
            type_: "error",
            message,
        }
    }
}

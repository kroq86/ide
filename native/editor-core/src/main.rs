mod buffer;
mod history;
mod lsp;
mod protocol;
mod syntax;

use anyhow::Result;
use buffer::EditorBuffer;
use protocol::{Command, OutMessage};
use std::io::{self, BufRead, Write};

fn emit(message: &OutMessage) -> Result<()> {
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, message)?;
    stdout.write_all(b"\n")?;
    stdout.flush()?;
    Ok(())
}

fn main() -> Result<()> {
    let mut buffer = EditorBuffer::new();
    let mut lsp = lsp::LspManager::new();

    if let Some(filename) = std::env::args().nth(1)
        && let Err(error) = buffer.open(&filename)
    {
        emit(&OutMessage::error(format!(
            "failed to open {filename}: {error}"
        )))?;
    }

    lsp.refresh_for_file(buffer.filename());
    emit(&OutMessage::Ready { type_: "ready" })?;
    emit(&OutMessage::Snapshot(buffer.snapshot(&lsp)))?;

    for line in io::stdin().lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }

        let command = match serde_json::from_str::<Command>(&line) {
            Ok(command) => command,
            Err(error) => {
                emit(&OutMessage::error(format!("invalid command JSON: {error}")))?;
                continue;
            }
        };

        match command {
            Command::Open { filename } => {
                match buffer.open(&filename) {
                    Ok(()) => lsp.refresh_for_file(buffer.filename()),
                    Err(error) => emit(&OutMessage::error(format!(
                        "failed to open {filename}: {error}"
                    )))?,
                }
                emit(&OutMessage::Snapshot(buffer.snapshot(&lsp)))?;
            }
            Command::Insert { text } => {
                buffer.insert(&text);
                emit(&OutMessage::Snapshot(buffer.snapshot(&lsp)))?;
            }
            Command::DeleteBackward => {
                buffer.delete_backward();
                emit(&OutMessage::Snapshot(buffer.snapshot(&lsp)))?;
            }
            Command::DeleteForward => {
                buffer.delete_forward();
                emit(&OutMessage::Snapshot(buffer.snapshot(&lsp)))?;
            }
            Command::DeleteLine => {
                buffer.delete_line();
                emit(&OutMessage::Snapshot(buffer.snapshot(&lsp)))?;
            }
            Command::DeleteRange {
                start_row,
                start_col,
                end_row,
                end_col,
            } => {
                buffer.delete_range(start_row, start_col, end_row, end_col);
                emit(&OutMessage::Snapshot(buffer.snapshot(&lsp)))?;
            }
            Command::Move { direction } => {
                buffer.move_cursor(direction);
                emit(&OutMessage::Snapshot(buffer.snapshot(&lsp)))?;
            }
            Command::MoveTo { row, col } => {
                buffer.move_to(row, col);
                emit(&OutMessage::Snapshot(buffer.snapshot(&lsp)))?;
            }
            Command::Save => {
                match buffer.save() {
                    Ok(()) => emit(&OutMessage::Saved {
                        type_: "saved",
                        filename: buffer.filename().map(str::to_owned),
                    })?,
                    Err(error) => emit(&OutMessage::error(format!("save failed: {error}")))?,
                }
                emit(&OutMessage::Snapshot(buffer.snapshot(&lsp)))?;
            }
            Command::Undo => {
                buffer.undo();
                emit(&OutMessage::Snapshot(buffer.snapshot(&lsp)))?;
            }
            Command::Redo => {
                buffer.redo();
                emit(&OutMessage::Snapshot(buffer.snapshot(&lsp)))?;
            }
            Command::Resize { width, height } => {
                buffer.resize(width, height);
                emit(&OutMessage::Snapshot(buffer.snapshot(&lsp)))?;
            }
            Command::SetViewport { start, height } => {
                buffer.set_viewport(start, height);
                emit(&OutMessage::Snapshot(buffer.snapshot(&lsp)))?;
            }
            Command::Hover { row, col } => {
                emit(&OutMessage::LspResponse {
                    type_: "lspResponse",
                    kind: "hover".to_owned(),
                    status: lsp.status_for(buffer.filename()),
                    result: Some(serde_json::json!({ "row": row, "col": col })),
                })?;
            }
            Command::GoToDefinition { row, col } => {
                emit(&OutMessage::LspResponse {
                    type_: "lspResponse",
                    kind: "definition".to_owned(),
                    status: lsp.status_for(buffer.filename()),
                    result: Some(serde_json::json!({ "row": row, "col": col, "target": null })),
                })?;
            }
            Command::Completion { row, col } => {
                emit(&OutMessage::LspResponse {
                    type_: "lspResponse",
                    kind: "completion".to_owned(),
                    status: lsp.status_for(buffer.filename()),
                    result: Some(serde_json::json!({ "row": row, "col": col, "items": [] })),
                })?;
            }
            Command::Format => {
                emit(&OutMessage::LspResponse {
                    type_: "lspResponse",
                    kind: "format".to_owned(),
                    status: lsp.status_for(buffer.filename()),
                    result: None,
                })?;
            }
            Command::Quit => break,
        }
    }

    Ok(())
}

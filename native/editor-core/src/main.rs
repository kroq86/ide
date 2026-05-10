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

fn sync_lsp(lsp: &mut lsp::LspManager, buffer: &EditorBuffer) {
    lsp.did_change(buffer.filename(), &buffer.text(), buffer.revision());
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

    lsp.refresh_for_file(buffer.filename(), &buffer.text(), buffer.revision());
    emit(&OutMessage::Ready { type_: "ready" })?;
    emit(&OutMessage::Snapshot(buffer.snapshot(&mut lsp)))?;

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
                    Ok(()) => {
                        lsp.refresh_for_file(buffer.filename(), &buffer.text(), buffer.revision())
                    }
                    Err(error) => emit(&OutMessage::error(format!(
                        "failed to open {filename}: {error}"
                    )))?,
                }
                emit(&OutMessage::Snapshot(buffer.snapshot(&mut lsp)))?;
            }
            Command::Insert { text } => {
                buffer.insert(&text);
                sync_lsp(&mut lsp, &buffer);
                emit(&OutMessage::Snapshot(buffer.snapshot(&mut lsp)))?;
            }
            Command::DeleteBackward => {
                buffer.delete_backward();
                sync_lsp(&mut lsp, &buffer);
                emit(&OutMessage::Snapshot(buffer.snapshot(&mut lsp)))?;
            }
            Command::DeleteForward => {
                buffer.delete_forward();
                sync_lsp(&mut lsp, &buffer);
                emit(&OutMessage::Snapshot(buffer.snapshot(&mut lsp)))?;
            }
            Command::DeleteLine => {
                buffer.delete_line();
                sync_lsp(&mut lsp, &buffer);
                emit(&OutMessage::Snapshot(buffer.snapshot(&mut lsp)))?;
            }
            Command::DeleteRange {
                start_row,
                start_col,
                end_row,
                end_col,
            } => {
                buffer.delete_range(start_row, start_col, end_row, end_col);
                sync_lsp(&mut lsp, &buffer);
                emit(&OutMessage::Snapshot(buffer.snapshot(&mut lsp)))?;
            }
            Command::Move { direction } => {
                buffer.move_cursor(direction);
                emit(&OutMessage::Snapshot(buffer.snapshot(&mut lsp)))?;
            }
            Command::MoveTo { row, col } => {
                buffer.move_to(row, col);
                emit(&OutMessage::Snapshot(buffer.snapshot(&mut lsp)))?;
            }
            Command::Save => {
                match buffer.save() {
                    Ok(()) => {
                        lsp.did_save(buffer.filename(), &buffer.text());
                        emit(&OutMessage::Saved {
                            type_: "saved",
                            filename: buffer.filename().map(str::to_owned),
                        })?
                    }
                    Err(error) => emit(&OutMessage::error(format!("save failed: {error}")))?,
                }
                emit(&OutMessage::Snapshot(buffer.snapshot(&mut lsp)))?;
            }
            Command::Undo => {
                buffer.undo();
                sync_lsp(&mut lsp, &buffer);
                emit(&OutMessage::Snapshot(buffer.snapshot(&mut lsp)))?;
            }
            Command::Redo => {
                buffer.redo();
                sync_lsp(&mut lsp, &buffer);
                emit(&OutMessage::Snapshot(buffer.snapshot(&mut lsp)))?;
            }
            Command::Resize { width, height } => {
                buffer.resize(width, height);
                emit(&OutMessage::Snapshot(buffer.snapshot(&mut lsp)))?;
            }
            Command::SetViewport { start, height } => {
                buffer.set_viewport(start, height);
                emit(&OutMessage::Snapshot(buffer.snapshot(&mut lsp)))?;
            }
            Command::Hover { row, col } => {
                let response = lsp.hover(buffer.filename(), row, col);
                emit(&OutMessage::LspResponse {
                    type_: "lspResponse",
                    kind: response.kind,
                    status: response.status,
                    result: response.result,
                })?;
            }
            Command::GoToDefinition { row, col } => {
                let response = lsp.definition(buffer.filename(), row, col);
                emit(&OutMessage::LspResponse {
                    type_: "lspResponse",
                    kind: response.kind,
                    status: response.status,
                    result: response.result,
                })?;
            }
            Command::Completion { row, col } => {
                let response = lsp.completion(buffer.filename(), row, col);
                emit(&OutMessage::LspResponse {
                    type_: "lspResponse",
                    kind: response.kind,
                    status: response.status,
                    result: response.result,
                })?;
            }
            Command::Format => {
                let edits = lsp.format_document(buffer.filename());
                let status = lsp.status_for(buffer.filename());
                if !edits.is_empty() {
                    buffer.apply_text_edits(&edits);
                    sync_lsp(&mut lsp, &buffer);
                    emit(&OutMessage::Snapshot(buffer.snapshot(&mut lsp)))?;
                } else {
                    emit(&OutMessage::LspResponse {
                        type_: "lspResponse",
                        kind: "format".to_owned(),
                        status,
                        result: Some(serde_json::json!({ "applied": 0 })),
                    })?;
                }
            }
            Command::Quit => break,
        }
    }

    Ok(())
}

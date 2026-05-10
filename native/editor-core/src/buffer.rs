use crate::history::{Edit, History, Transaction};
use crate::lsp::LspManager;
use crate::protocol::{Cursor, MoveDirection, Snapshot, Viewport};
use crate::syntax;
use anyhow::{Context, Result};
use ropey::Rope;
use std::fs;
use std::path::Path;
use uuid::Uuid;

#[derive(Debug)]
pub struct EditorBuffer {
    id: String,
    rope: Rope,
    saved_text: String,
    filename: Option<String>,
    cursor: Cursor,
    dirty: bool,
    status: String,
    width: usize,
    height: usize,
    viewport_start: usize,
    revision: u64,
    history: History,
}

impl EditorBuffer {
    pub fn new() -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            rope: Rope::from_str(""),
            saved_text: String::new(),
            filename: None,
            cursor: Cursor { row: 0, col: 0 },
            dirty: false,
            status: "scratch".to_owned(),
            width: 80,
            height: 24,
            viewport_start: 0,
            revision: 0,
            history: History::default(),
        }
    }

    pub fn filename(&self) -> Option<&str> {
        self.filename.as_deref()
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn text(&self) -> String {
        self.rope.to_string()
    }

    /// Apply LSP TextEdits (from textDocument/formatting). Edits must be sorted in
    /// reverse document order (last range first) so offsets don't shift during application.
    pub fn apply_text_edits(&mut self, edits: &[crate::lsp::TextEdit]) {
        if edits.is_empty() {
            return;
        }

        // Work on the full text string; rebuild rope at the end.
        // This avoids fiddly rope-offset bookkeeping across multiple edits.
        let mut text = self.rope.to_string();

        // Sorted in reverse: last edit first (callers should pre-sort, but we enforce here)
        let mut sorted: Vec<_> = edits.iter().collect();
        sorted.sort_by(|a, b| {
            b.start_line.cmp(&a.start_line)
                .then(b.start_char.cmp(&a.start_char))
        });

        for edit in sorted {
            let start = line_char_offset(&text, edit.start_line, edit.start_char);
            let end   = line_char_offset(&text, edit.end_line,   edit.end_char);
            if start <= end && end <= text.len() {
                text.replace_range(start..end, &edit.new_text);
            }
        }

        // Clamp cursor to valid position in the new text
        let saved_row = self.cursor.row;
        let saved_col = self.cursor.col;
        self.rope = ropey::Rope::from_str(&text);
        let last = self.last_row();
        let row = saved_row.min(last);
        let col = saved_col.min(self.line_len(row));
        self.cursor = crate::protocol::Cursor { row, col };
        self.revision += 1;
        self.changed("formatted".to_owned());
    }

    pub fn open(&mut self, filename: &str) -> Result<()> {
        let text = fs::read_to_string(filename).with_context(|| format!("reading {filename}"))?;
        self.rope = Rope::from_str(&text);
        self.saved_text = text;
        self.filename = Some(filename.to_owned());
        self.cursor = Cursor { row: 0, col: 0 };
        self.dirty = false;
        self.status = format!("opened {filename}");
        self.viewport_start = 0;
        self.revision += 1;
        self.history.clear();
        Ok(())
    }

    pub fn save(&mut self) -> Result<()> {
        let filename = self.filename.as_ref().context("no filename")?;
        let text = self.rope.to_string();
        fs::write(filename, &text).with_context(|| format!("writing {filename}"))?;
        self.saved_text = text;
        self.dirty = false;
        self.status = format!("saved {filename}");
        Ok(())
    }

    /// Write buffer to a new path (e.g. scratch → first save). Creates parent directories.
    pub fn save_as(&mut self, filename: &str) -> Result<()> {
        let path = Path::new(filename);
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent).with_context(|| format!("creating {}", parent.display()))?;
            }
        }
        let text = self.rope.to_string();
        fs::write(filename, &text).with_context(|| format!("writing {filename}"))?;
        self.filename = Some(filename.to_owned());
        self.saved_text = text;
        self.dirty = false;
        self.status = format!("saved {filename}");
        Ok(())
    }

    pub fn resize(&mut self, width: usize, height: usize) {
        self.width = width;
        self.height = height;
        self.ensure_cursor_visible();
    }

    pub fn set_viewport(&mut self, start: usize, height: usize) {
        self.viewport_start = start.min(self.last_row());
        self.height = height.max(1);
    }

    pub fn insert(&mut self, text: &str) {
        let start = self.cursor_char();
        let before = self.cursor;
        self.rope.insert(start, text);
        let after_char = start + text.chars().count();
        self.cursor = self.char_to_cursor(after_char);
        self.record(
            Edit {
                start,
                deleted: String::new(),
                inserted: text.to_owned(),
            },
            before,
            self.cursor,
        );
        self.changed(format!("inserted {} chars", text.chars().count()));
    }

    pub fn delete_backward(&mut self) {
        let pos = self.cursor_char();
        if pos == 0 {
            return;
        }
        self.delete_chars(pos - 1, pos, "deleted backward");
    }

    pub fn delete_forward(&mut self) {
        let pos = self.cursor_char();
        if pos >= self.rope.len_chars() {
            return;
        }
        self.delete_chars(pos, pos + 1, "deleted forward");
    }

    pub fn delete_line(&mut self) {
        let line_count = self.line_count();
        let row = self.cursor.row.min(line_count.saturating_sub(1));
        let start = self.line_to_char(row);
        let end = if row + 1 < line_count {
            self.line_to_char(row + 1)
        } else {
            self.rope.len_chars()
        };
        if start == end {
            return;
        }
        self.delete_chars(start, end, "deleted line");
    }

    pub fn delete_range(
        &mut self,
        start_row: usize,
        start_col: usize,
        end_row: usize,
        end_col: usize,
    ) {
        let (mut start, mut end) =
            self.inclusive_range_to_chars(start_row, start_col, end_row, end_col);
        if end < start {
            std::mem::swap(&mut start, &mut end);
        }
        if end > start {
            self.delete_chars(start, end, "deleted range");
        }
    }

    pub fn move_to(&mut self, row: usize, col: usize) {
        let row = row.min(self.last_row());
        let col = col.min(self.line_len(row));
        self.cursor = Cursor { row, col };
        self.ensure_cursor_visible();
    }

    pub fn move_cursor(&mut self, direction: MoveDirection) {
        match direction {
            MoveDirection::Up => self.move_to(self.cursor.row.saturating_sub(1), self.cursor.col),
            MoveDirection::Down => {
                self.move_to((self.cursor.row + 1).min(self.last_row()), self.cursor.col)
            }
            MoveDirection::Left => {
                if self.cursor.col > 0 {
                    self.move_to(self.cursor.row, self.cursor.col - 1);
                } else if self.cursor.row > 0 {
                    let row = self.cursor.row - 1;
                    self.move_to(row, self.line_len(row));
                }
            }
            MoveDirection::Right => {
                if self.cursor.col < self.line_len(self.cursor.row) {
                    self.move_to(self.cursor.row, self.cursor.col + 1);
                } else if self.cursor.row < self.last_row() {
                    self.move_to(self.cursor.row + 1, 0);
                }
            }
            MoveDirection::Home => self.move_to(self.cursor.row, 0),
            MoveDirection::End => self.move_to(self.cursor.row, self.line_len(self.cursor.row)),
            MoveDirection::FileStart => self.move_to(0, 0),
            MoveDirection::FileEnd => {
                let row = self.last_row();
                self.move_to(row, self.line_len(row));
            }
            MoveDirection::WordForward => self.word_forward(),
            MoveDirection::WordBackward => self.word_backward(),
        }
    }

    pub fn undo(&mut self) {
        let Some(transaction) = self.history.pop_undo() else {
            self.status = "nothing to undo".to_owned();
            return;
        };
        self.apply_inverse(&transaction);
        self.cursor = transaction.before;
        self.history.push_redo(transaction);
        self.changed_without_history("undo");
    }

    pub fn redo(&mut self) {
        let Some(transaction) = self.history.pop_redo() else {
            self.status = "nothing to redo".to_owned();
            return;
        };
        self.apply_transaction(&transaction);
        self.cursor = transaction.after;
        self.history.push_undo(transaction);
        self.changed_without_history("redo");
    }

    pub fn snapshot(&self, lsp: &mut LspManager) -> Snapshot {
        let total_lines = self.line_count();
        let visible_rows = self.visible_rows();
        let viewport_start = self.viewport_start.min(total_lines.saturating_sub(1));
        let viewport_end = (viewport_start + visible_rows).min(total_lines);
        let lines = self.all_lines();
        let visible_lines = lines[viewport_start..viewport_end].to_vec();
        let source = self.rope.to_string();
        let diagnostics = lsp.diagnostics_for(self.filename());
        let token_status = if self.filename.is_some() {
            "syntax"
        } else {
            "plain"
        };
        let tokens = syntax::highlight(self.filename(), &source, viewport_start, viewport_end);
        let status = format!(
            "{} | {} | {}",
            self.status,
            token_status,
            lsp.status_for(self.filename())
        );

        Snapshot {
            type_: "snapshot",
            protocol_version: 2,
            buffer_id: self.id.clone(),
            revision: self.revision,
            width: self.width,
            height: self.height,
            cursor: self.cursor,
            lines,
            dirty: self.dirty,
            filename: self.filename.clone(),
            status,
            total_lines,
            viewport: Viewport {
                start: viewport_start,
                end: viewport_end,
            },
            visible_lines,
            tokens,
            diagnostics,
        }
    }

    fn delete_chars(&mut self, start: usize, end: usize, status: &str) {
        let before = self.cursor;
        let deleted = self.rope.slice(start..end).to_string();
        self.rope.remove(start..end);
        self.cursor = self.char_to_cursor(start);
        self.record(
            Edit {
                start,
                deleted,
                inserted: String::new(),
            },
            before,
            self.cursor,
        );
        self.changed(status.to_owned());
    }

    fn record(&mut self, edit: Edit, before: Cursor, after: Cursor) {
        self.history.record(Transaction {
            edits: vec![edit],
            before,
            after,
        });
    }

    fn apply_inverse(&mut self, transaction: &Transaction) {
        for edit in transaction.edits.iter().rev() {
            let inserted_len = edit.inserted.chars().count();
            if inserted_len > 0 {
                self.rope.remove(edit.start..edit.start + inserted_len);
            }
            if !edit.deleted.is_empty() {
                self.rope.insert(edit.start, &edit.deleted);
            }
        }
    }

    fn apply_transaction(&mut self, transaction: &Transaction) {
        for edit in &transaction.edits {
            if !edit.deleted.is_empty() {
                self.rope
                    .remove(edit.start..edit.start + edit.deleted.chars().count());
            }
            if !edit.inserted.is_empty() {
                self.rope.insert(edit.start, &edit.inserted);
            }
        }
    }

    fn changed(&mut self, status: String) {
        self.refresh_dirty();
        self.status = status;
        self.revision += 1;
        self.ensure_cursor_visible();
    }

    fn changed_without_history(&mut self, status: &str) {
        self.refresh_dirty();
        self.status = status.to_owned();
        self.revision += 1;
        self.ensure_cursor_visible();
    }

    fn refresh_dirty(&mut self) {
        self.dirty = self.rope.len_chars() != self.saved_text.chars().count()
            || self.rope.chars().ne(self.saved_text.chars());
    }

    fn ensure_cursor_visible(&mut self) {
        let visible = self.visible_rows();
        if self.cursor.row < self.viewport_start {
            self.viewport_start = self.cursor.row;
        } else if self.cursor.row >= self.viewport_start + visible {
            self.viewport_start = self.cursor.row.saturating_sub(visible.saturating_sub(1));
        }
    }

    fn visible_rows(&self) -> usize {
        self.height.saturating_sub(8).max(1)
    }

    fn all_lines(&self) -> Vec<String> {
        let mut out = Vec::with_capacity(self.line_count());
        for row in 0..self.line_count() {
            out.push(self.line_text(row));
        }
        if out.is_empty() {
            out.push(String::new());
        }
        out
    }

    fn line_count(&self) -> usize {
        self.rope.len_lines().max(1)
    }

    fn last_row(&self) -> usize {
        self.line_count().saturating_sub(1)
    }

    fn line_to_char(&self, row: usize) -> usize {
        self.rope.line_to_char(row.min(self.last_row()))
    }

    fn cursor_char(&self) -> usize {
        self.cursor_to_char(self.cursor)
    }

    fn cursor_to_char(&self, cursor: Cursor) -> usize {
        let row = cursor.row.min(self.last_row());
        let col = cursor.col.min(self.line_len(row));
        self.line_to_char(row) + col
    }

    fn inclusive_range_to_chars(
        &self,
        start_row: usize,
        start_col: usize,
        end_row: usize,
        end_col: usize,
    ) -> (usize, usize) {
        let sr = start_row.min(self.last_row());
        let er = end_row.min(self.last_row());
        let start = self.line_to_char(sr) + start_col.min(self.line_len(sr));
        let end_line_len = self.line_len(er);
        let end = self.line_to_char(er)
            + if end_col >= end_line_len {
                end_line_len
            } else {
                end_col + 1
            };
        (start, end)
    }

    fn char_to_cursor(&self, char_idx: usize) -> Cursor {
        let idx = char_idx.min(self.rope.len_chars());
        let row = self.rope.char_to_line(idx);
        let col = idx.saturating_sub(self.rope.line_to_char(row));
        Cursor {
            row,
            col: col.min(self.line_len(row)),
        }
    }

    fn line_text(&self, row: usize) -> String {
        self.rope
            .line(row.min(self.last_row()))
            .to_string()
            .trim_end_matches(['\n', '\r'])
            .to_owned()
    }

    fn line_len(&self, row: usize) -> usize {
        self.line_text(row).chars().count()
    }

    fn word_forward(&mut self) {
        let chars: Vec<char> = self.rope.chars().collect();
        let mut idx = self.cursor_char();
        while idx < chars.len() && chars[idx].is_alphanumeric() {
            idx += 1;
        }
        while idx < chars.len() && !chars[idx].is_alphanumeric() {
            idx += 1;
        }
        self.cursor = self.char_to_cursor(idx);
        self.ensure_cursor_visible();
    }

    fn word_backward(&mut self) {
        let chars: Vec<char> = self.rope.chars().collect();
        let mut idx = self.cursor_char().saturating_sub(1);
        while idx > 0 && !chars[idx].is_alphanumeric() {
            idx -= 1;
        }
        while idx > 0 && chars[idx - 1].is_alphanumeric() {
            idx -= 1;
        }
        self.cursor = self.char_to_cursor(idx);
        self.ensure_cursor_visible();
    }
}

/// Convert (line, character) LSP position to a byte offset in a UTF-8 string.
fn line_char_offset(text: &str, line: usize, character: usize) -> usize {
    let mut current_line = 0;
    let mut byte_offset = 0;
    for ch in text.chars() {
        if current_line == line {
            break;
        }
        if ch == '\n' {
            current_line += 1;
        }
        byte_offset += ch.len_utf8();
    }
    // Now advance by `character` UTF-16 code units (LSP uses UTF-16)
    // For ASCII content (common case) this is the same as char count.
    let mut col = 0usize;
    for ch in text[byte_offset..].chars() {
        if col >= character || ch == '\n' {
            break;
        }
        col += if ch as u32 > 0xFFFF { 2 } else { 1 };
        byte_offset += ch.len_utf8();
    }
    byte_offset
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn unicode_insert_delete_and_undo() {
        let mut b = EditorBuffer::new();
        b.insert("hé\n世界");
        assert_eq!(b.cursor, Cursor { row: 1, col: 2 });
        b.delete_backward();
        assert_eq!(b.line_text(1), "世");
        b.undo();
        assert_eq!(b.line_text(1), "世界");
        b.redo();
        assert_eq!(b.line_text(1), "世");
    }

    #[test]
    fn save_open_roundtrip() {
        let mut tmp = tempfile::NamedTempFile::new().unwrap();
        write!(tmp, "alpha\nbeta\n").unwrap();
        let path = tmp.path().to_string_lossy().to_string();
        let mut b = EditorBuffer::new();
        b.open(&path).unwrap();
        b.move_to(0, 5);
        b.insert("!");
        b.save().unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), "alpha!\nbeta\n");
    }

    #[test]
    fn viewport_tracks_cursor() {
        let mut b = EditorBuffer::new();
        b.resize(80, 12);
        b.insert(&(0..30).map(|i| format!("{i}\n")).collect::<String>());
        b.move_to(20, 0);
        assert!(b.viewport_start > 0);
    }

    #[test]
    fn delete_range_matches_inclusive_protocol() {
        let mut b = EditorBuffer::new();
        b.insert("abc\ndef");
        b.delete_range(0, 1, 0, 1);
        assert_eq!(b.line_text(0), "ac");
        b.undo();
        b.delete_range(0, 1, 1, 0);
        assert_eq!(b.line_text(0), "aef");
    }

    #[test]
    fn tree_sitter_tokens_for_typescript() {
        let mut tmp = tempfile::Builder::new().suffix(".ts").tempfile().unwrap();
        write!(tmp, "const answer: number = 42\n").unwrap();
        let path = tmp.path().to_string_lossy().to_string();
        let mut b = EditorBuffer::new();
        let mut lsp = LspManager::new();
        b.open(&path).unwrap();
        let snapshot = b.snapshot(&mut lsp);
        assert!(snapshot.tokens.iter().any(|token| token.kind == "keyword"));
        assert!(snapshot.tokens.iter().any(|token| token.kind == "number"));
    }

    #[test]
    fn undo_to_saved_text_clears_dirty() {
        let mut tmp = tempfile::NamedTempFile::new().unwrap();
        write!(tmp, "saved\n").unwrap();
        let path = tmp.path().to_string_lossy().to_string();
        let mut b = EditorBuffer::new();
        b.open(&path).unwrap();
        b.insert("!");
        assert!(b.dirty);
        b.undo();
        assert!(!b.dirty);
    }

    #[test]
    fn save_as_sets_filename_and_writes_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path_buf = dir.path().join("scratch.txt");
        let path = path_buf.to_string_lossy().to_string();
        let mut b = EditorBuffer::new();
        b.insert("hello");
        assert!(b.filename().is_none());
        b.save_as(&path).unwrap();
        assert_eq!(b.filename().map(str::to_owned), Some(path.clone()));
        assert_eq!(fs::read_to_string(&path).unwrap(), "hello");
        assert!(!b.dirty);
    }
}

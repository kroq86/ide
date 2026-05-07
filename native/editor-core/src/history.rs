use crate::protocol::Cursor;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Edit {
    pub start: usize,
    pub deleted: String,
    pub inserted: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Transaction {
    pub edits: Vec<Edit>,
    pub before: Cursor,
    pub after: Cursor,
}

#[derive(Debug, Default)]
pub struct History {
    undo: Vec<Transaction>,
    redo: Vec<Transaction>,
}

impl History {
    pub fn record(&mut self, transaction: Transaction) {
        if transaction.edits.is_empty() {
            return;
        }
        self.undo.push(transaction);
        self.redo.clear();
    }

    pub fn pop_undo(&mut self) -> Option<Transaction> {
        self.undo.pop()
    }

    pub fn push_redo(&mut self, transaction: Transaction) {
        self.redo.push(transaction);
    }

    pub fn pop_redo(&mut self) -> Option<Transaction> {
        self.redo.pop()
    }

    pub fn push_undo(&mut self, transaction: Transaction) {
        self.undo.push(transaction);
    }

    pub fn clear(&mut self) {
        self.undo.clear();
        self.redo.clear();
    }
}

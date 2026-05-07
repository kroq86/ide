use crate::protocol::SyntaxToken;
use std::path::Path;
use tree_sitter::{Language, Node, Parser};

pub fn highlight(
    filename: Option<&str>,
    source: &str,
    viewport_start: usize,
    viewport_end: usize,
) -> Vec<SyntaxToken> {
    let Some(language) = filename.and_then(language_for) else {
        return Vec::new();
    };

    let mut parser = Parser::new();
    if parser.set_language(&language).is_err() {
        return Vec::new();
    }

    let Some(tree) = parser.parse(source, None) else {
        return Vec::new();
    };

    let mut tokens = Vec::new();
    collect(tree.root_node(), viewport_start, viewport_end, &mut tokens);
    tokens
}

fn language_for(filename: &str) -> Option<Language> {
    match Path::new(filename).extension().and_then(|ext| ext.to_str()) {
        Some("ts") => Some(tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()),
        Some("tsx") => Some(tree_sitter_typescript::LANGUAGE_TSX.into()),
        Some("js" | "jsx" | "mjs" | "cjs") => Some(tree_sitter_javascript::LANGUAGE.into()),
        Some("rs") => Some(tree_sitter_rust::LANGUAGE.into()),
        Some("py") => Some(tree_sitter_python::LANGUAGE.into()),
        _ => None,
    }
}

fn collect(node: Node<'_>, start_row: usize, end_row: usize, out: &mut Vec<SyntaxToken>) {
    let node_start = node.start_position();
    let node_end = node.end_position();
    if node_end.row < start_row || node_start.row >= end_row {
        return;
    }

    if node.child_count() == 0 {
        if let Some(kind) = classify(node.kind()) {
            out.push(SyntaxToken {
                row: node_start.row,
                start_col: node_start.column,
                end_col: node_end.column,
                kind: kind.to_owned(),
            });
        }
        return;
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect(child, start_row, end_row, out);
    }
}

fn classify(kind: &str) -> Option<&'static str> {
    match kind {
        "identifier" | "property_identifier" | "shorthand_property_identifier" => {
            Some("identifier")
        }
        "type_identifier" | "primitive_type" | "predefined_type" => Some("type"),
        "string" | "string_fragment" | "template_string" => Some("string"),
        "number" | "integer" | "float" => Some("number"),
        "line_comment" | "block_comment" | "comment" => Some("comment"),
        "true" | "false" | "null" | "undefined" | "None" => Some("constant"),
        "function" | "fn" | "class" | "interface" | "type" | "let" | "const" | "var" | "if"
        | "else" | "for" | "while" | "return" | "use" | "pub" | "struct" | "enum" | "impl"
        | "def" | "import" | "from" | "as" => Some("keyword"),
        _ => None,
    }
}

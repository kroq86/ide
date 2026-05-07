/*
 * qe-protocol: small JSONL sidecar for the qe-react-editor prototype.
 *
 * This file is new prototype glue. The surrounding QEmacs source tree remains
 * under the GNU Lesser General Public License terms included in COPYING.
 */
#include <ctype.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct Buffer {
    char **lines;
    int line_count;
    int line_cap;
    int cursor_row;
    int cursor_col;
    int width;
    int height;
    int dirty;
    char *filename;
    char status[256];
} Buffer;

typedef struct BufferSnapshot {
    char **lines;
    int line_count;
    int cursor_row;
    int cursor_col;
    int dirty;
    char *filename;
    char status[256];
} BufferSnapshot;

typedef struct History {
    BufferSnapshot undo[100];
    int undo_count;
    BufferSnapshot redo[100];
    int redo_count;
} History;

static void ensure_one_line(Buffer *b);
static void clamp_cursor(Buffer *b);

static char *xstrdup(const char *s) {
    size_t len = strlen(s);
    char *out = malloc(len + 1);
    if (!out) {
        perror("malloc");
        exit(2);
    }
    memcpy(out, s, len + 1);
    return out;
}

static void ensure_lines(Buffer *b, int needed) {
    if (b->line_cap >= needed) {
        return;
    }
    while (b->line_cap < needed) {
        b->line_cap = b->line_cap ? b->line_cap * 2 : 16;
    }
    b->lines = realloc(b->lines, sizeof(char *) * b->line_cap);
    if (!b->lines) {
        perror("realloc");
        exit(2);
    }
}

static void clear_buffer(Buffer *b) {
    for (int i = 0; i < b->line_count; i++) {
        free(b->lines[i]);
    }
    b->line_count = 0;
    b->cursor_row = 0;
    b->cursor_col = 0;
    b->dirty = 0;
}

static void append_line(Buffer *b, const char *line) {
    ensure_lines(b, b->line_count + 1);
    b->lines[b->line_count++] = xstrdup(line);
}

static void free_snapshot(BufferSnapshot *s) {
    for (int i = 0; i < s->line_count; i++) {
        free(s->lines[i]);
    }
    free(s->lines);
    free(s->filename);
    memset(s, 0, sizeof(*s));
}

static BufferSnapshot snapshot_buffer(Buffer *b) {
    ensure_one_line(b);
    BufferSnapshot s;
    memset(&s, 0, sizeof(s));
    s.line_count = b->line_count;
    s.cursor_row = b->cursor_row;
    s.cursor_col = b->cursor_col;
    s.dirty = b->dirty;
    s.filename = b->filename ? xstrdup(b->filename) : NULL;
    snprintf(s.status, sizeof(s.status), "%s", b->status);
    s.lines = malloc(sizeof(char *) * (size_t)s.line_count);
    if (!s.lines) {
        perror("malloc");
        exit(2);
    }
    for (int i = 0; i < s.line_count; i++) {
        s.lines[i] = xstrdup(b->lines[i]);
    }
    return s;
}

static void restore_snapshot(Buffer *b, BufferSnapshot *s) {
    clear_buffer(b);
    free(b->filename);
    b->filename = s->filename ? xstrdup(s->filename) : NULL;
    ensure_lines(b, s->line_count > 0 ? s->line_count : 1);
    for (int i = 0; i < s->line_count; i++) {
        append_line(b, s->lines[i]);
    }
    ensure_one_line(b);
    b->cursor_row = s->cursor_row;
    b->cursor_col = s->cursor_col;
    b->dirty = s->dirty;
    snprintf(b->status, sizeof(b->status), "%s", s->status);
    clamp_cursor(b);
}

static void history_push(BufferSnapshot stack[100], int *count, BufferSnapshot s) {
    if (*count == 100) {
        free_snapshot(&stack[0]);
        memmove(&stack[0], &stack[1], sizeof(BufferSnapshot) * 99);
        *count = 99;
    }
    stack[(*count)++] = s;
}

static int history_pop(BufferSnapshot stack[100], int *count, BufferSnapshot *out) {
    if (*count <= 0) return 0;
    *out = stack[--(*count)];
    memset(&stack[*count], 0, sizeof(stack[*count]));
    return 1;
}

static void history_clear_stack(BufferSnapshot stack[100], int *count) {
    for (int i = 0; i < *count; i++) {
        free_snapshot(&stack[i]);
    }
    *count = 0;
}

static void history_clear(History *h) {
    history_clear_stack(h->undo, &h->undo_count);
    history_clear_stack(h->redo, &h->redo_count);
}

static void history_record_mutation(History *h, Buffer *b) {
    history_push(h->undo, &h->undo_count, snapshot_buffer(b));
    history_clear_stack(h->redo, &h->redo_count);
}

static void ensure_one_line(Buffer *b) {
    if (b->line_count == 0) {
        append_line(b, "");
    }
}

static void set_status(Buffer *b, const char *status) {
    snprintf(b->status, sizeof(b->status), "%s", status);
}

static void json_string(FILE *out, const char *s) {
    fputc('"', out);
    for (; *s; s++) {
        unsigned char c = (unsigned char)*s;
        switch (c) {
        case '"': fputs("\\\"", out); break;
        case '\\': fputs("\\\\", out); break;
        case '\b': fputs("\\b", out); break;
        case '\f': fputs("\\f", out); break;
        case '\n': fputs("\\n", out); break;
        case '\r': fputs("\\r", out); break;
        case '\t': fputs("\\t", out); break;
        default:
            if (c < 32) {
                fprintf(out, "\\u%04x", c);
            } else {
                fputc(c, out);
            }
        }
    }
    fputc('"', out);
}

static void emit_snapshot(Buffer *b) {
    ensure_one_line(b);
    printf("{\"type\":\"snapshot\",\"width\":%d,\"height\":%d,\"cursor\":{\"row\":%d,\"col\":%d},\"lines\":[",
           b->width, b->height, b->cursor_row, b->cursor_col);
    for (int i = 0; i < b->line_count; i++) {
        if (i) {
            fputc(',', stdout);
        }
        json_string(stdout, b->lines[i]);
    }
    fputs("],\"dirty\":", stdout);
    fputs(b->dirty ? "true" : "false", stdout);
    fputs(",\"filename\":", stdout);
    if (b->filename) {
        json_string(stdout, b->filename);
    } else {
        fputs("null", stdout);
    }
    fputs(",\"status\":", stdout);
    json_string(stdout, b->status);
    fputs("}\n", stdout);
    fflush(stdout);
}

static void emit_simple(const char *type) {
    printf("{\"type\":\"%s\"}\n", type);
    fflush(stdout);
}

static void emit_error(const char *message) {
    fputs("{\"type\":\"error\",\"message\":", stdout);
    json_string(stdout, message);
    fputs("}\n", stdout);
    fflush(stdout);
}

static int load_file(Buffer *b, const char *filename) {
    FILE *f = fopen(filename, "rb");
    if (!f) {
        if (errno == ENOENT) {
            clear_buffer(b);
            free(b->filename);
            b->filename = xstrdup(filename);
            ensure_one_line(b);
            set_status(b, "new file");
            return 0;
        }

        char message[512];
        snprintf(message, sizeof(message), "open failed: %s", strerror(errno));
        emit_error(message);
        return -1;
    }

    clear_buffer(b);
    free(b->filename);
    b->filename = xstrdup(filename);

    char *line = NULL;
    size_t cap = 0;
    ssize_t nread;
    while ((nread = getline(&line, &cap, f)) != -1) {
        while (nread > 0 && (line[nread - 1] == '\n' || line[nread - 1] == '\r')) {
            line[--nread] = '\0';
        }
        append_line(b, line);
    }
    free(line);
    fclose(f);
    ensure_one_line(b);
    set_status(b, "opened");
    return 0;
}

static int save_file(Buffer *b) {
    if (!b->filename) {
        emit_error("no filename");
        return -1;
    }

    FILE *f = fopen(b->filename, "wb");
    if (!f) {
        char message[512];
        snprintf(message, sizeof(message), "save failed: %s", strerror(errno));
        emit_error(message);
        return -1;
    }

    for (int i = 0; i < b->line_count; i++) {
        fputs(b->lines[i], f);
        if (i + 1 < b->line_count) {
            fputc('\n', f);
        }
    }
    fputc('\n', f);
    fclose(f);
    b->dirty = 0;
    set_status(b, "saved");
    fputs("{\"type\":\"saved\",\"filename\":", stdout);
    json_string(stdout, b->filename);
    fputs("}\n", stdout);
    fflush(stdout);
    return 0;
}

static void clamp_cursor(Buffer *b) {
    ensure_one_line(b);
    if (b->cursor_row < 0) b->cursor_row = 0;
    if (b->cursor_row >= b->line_count) b->cursor_row = b->line_count - 1;
    int len = (int)strlen(b->lines[b->cursor_row]);
    if (b->cursor_col < 0) b->cursor_col = 0;
    if (b->cursor_col > len) b->cursor_col = len;
}

static void insert_char(Buffer *b, char ch) {
    clamp_cursor(b);
    char *line = b->lines[b->cursor_row];
    int len = (int)strlen(line);
    char *next = malloc((size_t)len + 2);
    if (!next) {
        perror("malloc");
        exit(2);
    }
    memcpy(next, line, (size_t)b->cursor_col);
    next[b->cursor_col] = ch;
    memcpy(next + b->cursor_col + 1, line + b->cursor_col, (size_t)(len - b->cursor_col + 1));
    free(line);
    b->lines[b->cursor_row] = next;
    b->cursor_col++;
    b->dirty = 1;
}

static void insert_newline(Buffer *b) {
    clamp_cursor(b);
    char *line = b->lines[b->cursor_row];
    char *left = xstrdup(line);
    left[b->cursor_col] = '\0';
    char *right = xstrdup(line + b->cursor_col);

    ensure_lines(b, b->line_count + 1);
    memmove(&b->lines[b->cursor_row + 2], &b->lines[b->cursor_row + 1],
            sizeof(char *) * (size_t)(b->line_count - b->cursor_row - 1));
    free(line);
    b->lines[b->cursor_row] = left;
    b->lines[b->cursor_row + 1] = right;
    b->line_count++;
    b->cursor_row++;
    b->cursor_col = 0;
    b->dirty = 1;
}

static void insert_text(Buffer *b, const char *text) {
    for (const char *p = text; *p; p++) {
        if (*p == '\n') {
            insert_newline(b);
        } else if (*p != '\r') {
            insert_char(b, *p);
        }
    }
    set_status(b, "edited");
}

static void delete_backward(Buffer *b) {
    clamp_cursor(b);
    if (b->cursor_col > 0) {
        char *line = b->lines[b->cursor_row];
        int len = (int)strlen(line);
        memmove(line + b->cursor_col - 1, line + b->cursor_col,
                (size_t)(len - b->cursor_col + 1));
        b->cursor_col--;
        b->dirty = 1;
    } else if (b->cursor_row > 0) {
        int prev_len = (int)strlen(b->lines[b->cursor_row - 1]);
        int len = (int)strlen(b->lines[b->cursor_row]);
        char *joined = malloc((size_t)prev_len + (size_t)len + 1);
        if (!joined) {
            perror("malloc");
            exit(2);
        }
        strcpy(joined, b->lines[b->cursor_row - 1]);
        strcat(joined, b->lines[b->cursor_row]);
        free(b->lines[b->cursor_row - 1]);
        free(b->lines[b->cursor_row]);
        b->lines[b->cursor_row - 1] = joined;
        memmove(&b->lines[b->cursor_row], &b->lines[b->cursor_row + 1],
                sizeof(char *) * (size_t)(b->line_count - b->cursor_row - 1));
        b->line_count--;
        b->cursor_row--;
        b->cursor_col = prev_len;
        b->dirty = 1;
    }
    set_status(b, "edited");
}

static void delete_forward(Buffer *b) {
    clamp_cursor(b);
    char *line = b->lines[b->cursor_row];
    int len = (int)strlen(line);
    if (b->cursor_col < len) {
        memmove(line + b->cursor_col, line + b->cursor_col + 1,
                (size_t)(len - b->cursor_col));
        b->dirty = 1;
    }
    set_status(b, "edited");
}

static void move_to(Buffer *b, int row, int col) {
    b->cursor_row = row;
    b->cursor_col = col;
    clamp_cursor(b);
    set_status(b, "ready");
}

static void delete_range(Buffer *b, int sr, int sc, int er, int ec) {
    ensure_one_line(b);
    if (sr < 0) sr = 0;
    if (er >= b->line_count) er = b->line_count - 1;
    if (sr > er) goto done;

    if (sr == er) {
        char *line = b->lines[sr];
        int len = (int)strlen(line);
        if (sc > len) sc = len;
        if (ec >= len) ec = len - 1;
        if (sc > ec) goto done;
        memmove(line + sc, line + ec + 1, (size_t)(len - ec));
    } else {
        /* truncate start line */
        char *sl = b->lines[sr];
        int sl_len = (int)strlen(sl);
        if (sc > sl_len) sc = sl_len;
        sl[sc] = '\0';
        /* get remainder of end line */
        char *el = b->lines[er];
        int el_len = (int)strlen(el);
        char *rem = (ec + 1 >= el_len) ? xstrdup("") : xstrdup(el + ec + 1);
        /* free intermediate rows */
        for (int i = sr + 1; i <= er; i++) free(b->lines[i]);
        /* join */
        size_t jl = (size_t)sc + strlen(rem);
        char *joined = malloc(jl + 1);
        if (!joined) { perror("malloc"); exit(2); }
        strcpy(joined, sl);
        strcat(joined, rem);
        free(b->lines[sr]);
        free(rem);
        b->lines[sr] = joined;
        int removed = er - sr;
        memmove(&b->lines[sr + 1], &b->lines[er + 1],
                sizeof(char *) * (size_t)(b->line_count - er - 1));
        b->line_count -= removed;
    }

done:
    b->cursor_row = sr;
    b->cursor_col = sc;
    clamp_cursor(b);
    b->dirty = 1;
    set_status(b, "edited");
}

static void delete_line(Buffer *b) {
    ensure_one_line(b);
    clamp_cursor(b);
    if (b->line_count == 1) {
        free(b->lines[0]);
        b->lines[0] = xstrdup("");
        b->cursor_col = 0;
    } else {
        free(b->lines[b->cursor_row]);
        memmove(&b->lines[b->cursor_row], &b->lines[b->cursor_row + 1],
                sizeof(char *) * (size_t)(b->line_count - b->cursor_row - 1));
        b->line_count--;
        if (b->cursor_row >= b->line_count)
            b->cursor_row = b->line_count - 1;
        b->cursor_col = 0;
    }
    b->dirty = 1;
    set_status(b, "edited");
}

static void move_cursor(Buffer *b, const char *direction) {
    if (!strcmp(direction, "up")) {
        b->cursor_row--;
    } else if (!strcmp(direction, "down")) {
        b->cursor_row++;
    } else if (!strcmp(direction, "left")) {
        if (b->cursor_col > 0) {
            b->cursor_col--;
        } else if (b->cursor_row > 0) {
            b->cursor_row--;
            b->cursor_col = (int)strlen(b->lines[b->cursor_row]);
        }
    } else if (!strcmp(direction, "right")) {
        int len = (int)strlen(b->lines[b->cursor_row]);
        if (b->cursor_col < len) {
            b->cursor_col++;
        } else if (b->cursor_row + 1 < b->line_count) {
            b->cursor_row++;
            b->cursor_col = 0;
        }
    } else if (!strcmp(direction, "home")) {
        b->cursor_col = 0;
    } else if (!strcmp(direction, "end")) {
        b->cursor_col = (int)strlen(b->lines[b->cursor_row]);
    } else if (!strcmp(direction, "wordForward")) {
        clamp_cursor(b);
        char *line = b->lines[b->cursor_row];
        int len = (int)strlen(line);
        int col = b->cursor_col;
        while (col < len && !isspace((unsigned char)line[col])) col++;
        while (col < len && isspace((unsigned char)line[col])) col++;
        if (col >= len && b->cursor_row + 1 < b->line_count) {
            b->cursor_row++;
            b->cursor_col = 0;
        } else {
            b->cursor_col = col;
        }
    } else if (!strcmp(direction, "wordBackward")) {
        clamp_cursor(b);
        if (b->cursor_col == 0) {
            if (b->cursor_row > 0) {
                b->cursor_row--;
                b->cursor_col = (int)strlen(b->lines[b->cursor_row]);
            }
        } else {
            char *line = b->lines[b->cursor_row];
            int col = b->cursor_col - 1;
            while (col > 0 && isspace((unsigned char)line[col])) col--;
            while (col > 0 && !isspace((unsigned char)line[col - 1])) col--;
            b->cursor_col = col;
        }
    } else if (!strcmp(direction, "fileStart")) {
        b->cursor_row = 0;
        b->cursor_col = 0;
    } else if (!strcmp(direction, "fileEnd")) {
        ensure_one_line(b);
        b->cursor_row = b->line_count - 1;
        b->cursor_col = (int)strlen(b->lines[b->cursor_row]);
    }
    clamp_cursor(b);
    set_status(b, "ready");
}

/* Advance past a JSON string starting at the opening '"'.
   Returns pointer after the closing '"', or NULL on malformed input. */
static const char *json_skip_string(const char *p) {
    if (*p != '"') return NULL;
    for (p++; *p; p++) {
        if (*p == '\\') {
            if (!*++p) return NULL;
        } else if (*p == '"') {
            return p + 1;
        }
    }
    return NULL;
}

/* Decode a JSON string starting at the opening '"' into a malloc'd buffer.
   Returns NULL on malformed input. */
static char *json_read_string(const char *p) {
    if (*p != '"') return NULL;
    p++;
    char *out = malloc(strlen(p) + 1);
    if (!out) { perror("malloc"); exit(2); }
    char *w = out;
    while (*p && *p != '"') {
        if (*p == '\\') {
            p++;
            switch (*p) {
            case 'n': *w++ = '\n'; break;
            case 'r': *w++ = '\r'; break;
            case 't': *w++ = '\t'; break;
            case '"': *w++ = '"'; break;
            case '\\': *w++ = '\\'; break;
            case 'u': {
                unsigned val = 0;
                int i;
                for (i = 0; i < 4 && isxdigit((unsigned char)p[1]); i++) {
                    p++;
                    val = val * 16 + (isdigit((unsigned char)*p)
                                      ? *p - '0'
                                      : tolower((unsigned char)*p) - 'a' + 10);
                }
                if (val < 0x80) {
                    *w++ = (char)val;
                } else if (val < 0x800) {
                    *w++ = (char)(0xC0 | (val >> 6));
                    *w++ = (char)(0x80 | (val & 0x3F));
                } else {
                    *w++ = (char)(0xE0 | (val >> 12));
                    *w++ = (char)(0x80 | ((val >> 6) & 0x3F));
                    *w++ = (char)(0x80 | (val & 0x3F));
                }
                break;
            }
            default: if (*p) *w++ = *p; break;
            }
            if (*p) p++;
        } else {
            *w++ = *p++;
        }
    }
    *w = '\0';
    return out;
}

/* Advance past a JSON value (string, number, bool, null).
   Nested objects/arrays are not needed by this protocol. */
static const char *json_skip_value(const char *p) {
    while (isspace((unsigned char)*p)) p++;
    if (*p == '"') return json_skip_string(p);
    while (*p && *p != ',' && *p != '}') p++;
    return p;
}

/* Walk key-value pairs in order to avoid false matches inside string values. */
static char *json_get_string(const char *json, const char *key) {
    size_t klen = strlen(key);
    const char *p = json;
    while (*p) {
        while (*p && *p != '{' && *p != ',') p++;
        if (!*p) break;
        p++;
        while (isspace((unsigned char)*p)) p++;
        if (*p != '"') continue;
        if (strncmp(p + 1, key, klen) == 0 && p[1 + klen] == '"') {
            p += 1 + klen + 1;
            while (isspace((unsigned char)*p)) p++;
            if (*p++ != ':') return NULL;
            while (isspace((unsigned char)*p)) p++;
            return json_read_string(p);
        }
        p = json_skip_string(p);
        if (!p) return NULL;
        while (isspace((unsigned char)*p)) p++;
        if (*p++ != ':') return NULL;
        p = json_skip_value(p);
        if (!p) return NULL;
    }
    return NULL;
}

static int json_get_int(const char *json, const char *key, int fallback) {
    size_t klen = strlen(key);
    const char *p = json;
    while (*p) {
        while (*p && *p != '{' && *p != ',') p++;
        if (!*p) break;
        p++;
        while (isspace((unsigned char)*p)) p++;
        if (*p != '"') continue;
        if (strncmp(p + 1, key, klen) == 0 && p[1 + klen] == '"') {
            p += 1 + klen + 1;
            while (isspace((unsigned char)*p)) p++;
            if (*p++ != ':') return fallback;
            while (isspace((unsigned char)*p)) p++;
            return atoi(p);
        }
        p = json_skip_string(p);
        if (!p) return fallback;
        while (isspace((unsigned char)*p)) p++;
        if (*p++ != ':') return fallback;
        p = json_skip_value(p);
        if (!p) return fallback;
    }
    return fallback;
}

static void undo(Buffer *b, History *h) {
    BufferSnapshot prev;
    if (!history_pop(h->undo, &h->undo_count, &prev)) {
        set_status(b, "nothing to undo");
        return;
    }
    history_push(h->redo, &h->redo_count, snapshot_buffer(b));
    restore_snapshot(b, &prev);
    set_status(b, "undo");
    free_snapshot(&prev);
}

static void redo(Buffer *b, History *h) {
    BufferSnapshot next;
    if (!history_pop(h->redo, &h->redo_count, &next)) {
        set_status(b, "nothing to redo");
        return;
    }
    history_push(h->undo, &h->undo_count, snapshot_buffer(b));
    restore_snapshot(b, &next);
    set_status(b, "redo");
    free_snapshot(&next);
}

static void handle_command(Buffer *b, History *h, const char *line) {
    char *type = json_get_string(line, "type");
    if (!type) {
        emit_error("missing command type");
        return;
    }

    if (!strcmp(type, "open")) {
        char *filename = json_get_string(line, "filename");
        if (filename) {
            load_file(b, filename);
            history_clear(h);
            free(filename);
        } else {
            emit_error("open requires filename");
        }
    } else if (!strcmp(type, "insert")) {
        char *text = json_get_string(line, "text");
        if (text) {
            history_record_mutation(h, b);
            insert_text(b, text);
            free(text);
        }
    } else if (!strcmp(type, "deleteBackward")) {
        history_record_mutation(h, b);
        delete_backward(b);
    } else if (!strcmp(type, "deleteForward")) {
        history_record_mutation(h, b);
        delete_forward(b);
    } else if (!strcmp(type, "deleteLine")) {
        history_record_mutation(h, b);
        delete_line(b);
    } else if (!strcmp(type, "moveTo")) {
        int row = json_get_int(line, "row", b->cursor_row);
        int col = json_get_int(line, "col", b->cursor_col);
        move_to(b, row, col);
    } else if (!strcmp(type, "deleteRange")) {
        int sr = json_get_int(line, "startRow", b->cursor_row);
        int sc = json_get_int(line, "startCol", 0);
        int er = json_get_int(line, "endRow", b->cursor_row);
        int ec = json_get_int(line, "endCol", 0);
        history_record_mutation(h, b);
        delete_range(b, sr, sc, er, ec);
    } else if (!strcmp(type, "move")) {
        char *direction = json_get_string(line, "direction");
        if (direction) {
            move_cursor(b, direction);
            free(direction);
        }
    } else if (!strcmp(type, "save")) {
        save_file(b);
    } else if (!strcmp(type, "undo")) {
        undo(b, h);
    } else if (!strcmp(type, "redo")) {
        redo(b, h);
    } else if (!strcmp(type, "resize")) {
        b->width = json_get_int(line, "width", b->width);
        b->height = json_get_int(line, "height", b->height);
    } else if (!strcmp(type, "quit")) {
        emit_simple("exit");
        free(type);
        exit(0);
    } else {
        emit_error("unknown command");
    }

    free(type);
    emit_snapshot(b);
}

int main(int argc, char **argv) {
    Buffer b;
    History history;
    memset(&b, 0, sizeof(b));
    memset(&history, 0, sizeof(history));
    b.width = 80;
    b.height = 24;
    set_status(&b, "ready");
    append_line(&b, "");

    if (argc > 1) {
        load_file(&b, argv[1]);
    }

    emit_simple("ready");
    emit_snapshot(&b);

    char *line = NULL;
    size_t cap = 0;
    while (getline(&line, &cap, stdin) != -1) {
        handle_command(&b, &history, line);
    }
    free(line);
    history_clear(&history);
    emit_simple("exit");
    return 0;
}

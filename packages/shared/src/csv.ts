// A small, dependency-free CSV reader for operator-supplied files (the Upload
// page's bulk import of historical recordings).
//
// It replaces a `line.split(',')` that silently mangled any real export: a
// quoted field containing a comma ("Webb, Marcus") was split into two cells, so
// every column after it shifted and the recording link, phone and date all
// landed in the wrong place — and the operator saw no error, just wrong rows.
//
// It lives here rather than in the web app because it is tested (packages/web
// has no test runner) and because what the file is allowed to contain is part
// of the bulk-import contract the API validates, not a detail of one page.
//
// What it handles: quoted fields, embedded commas, escaped `""` quotes,
// embedded newlines inside quotes, CRLF and LF endings, a UTF-8 BOM, blank
// lines, and short rows (missing trailing cells read as empty).
//
// Line numbers are the file's own: `line` is the physical line the record
// starts on, counting blank lines and the header, so a problem reported against
// a row points at the line the operator can see in their spreadsheet.

export interface CsvRecord {
  /** 1-based physical line in the file where this record starts. */
  line: number;
  cells: string[];
}

export interface CsvRow {
  /** 1-based physical line in the file where this row starts. */
  line: number;
  /** Cell values keyed by lower-cased, trimmed header name. */
  values: Record<string, string>;
}

export interface ParsedCsv {
  /** Header names, lower-cased and trimmed. Empty when the text held no rows. */
  headers: string[];
  rows: CsvRow[];
}

/**
 * Split CSV text into records, keeping the line each record started on.
 * Blank lines are dropped (a line of only separators is not blank — it is a
 * row of empty cells, and the caller's per-row checks should say so).
 */
export function parseCsvRecords(text: string): CsvRecord[] {
  // A BOM would otherwise become part of the first header name.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let cell = '';
  let inQuotes = false;
  // True until something has been consumed in the current cell, so only a
  // leading quote opens a quoted field (`a"b` keeps its quote verbatim).
  let cellStart = true;
  let line = 1;
  let recordLine = 1;

  const endCell = () => {
    cells.push(cell);
    cell = '';
    cellStart = true;
  };

  const endRecord = () => {
    endCell();
    const blank = cells.length === 1 && cells[0]!.trim() === '';
    if (!blank) records.push({ line: recordLine, cells });
    cells = [];
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
      continue;
    }

    if (ch === '"' && cellStart) {
      inQuotes = true;
      cellStart = false;
      continue;
    }
    if (ch === ',') {
      endCell();
      continue;
    }
    // CRLF: the \r belongs to the line ending, which the \n below closes.
    if (ch === '\r') continue;
    if (ch === '\n') {
      endRecord();
      line++;
      recordLine = line;
      continue;
    }
    cell += ch;
    cellStart = false;
  }

  // A final record with no trailing newline.
  if (cell !== '' || cells.length > 0) endRecord();

  return records;
}

/**
 * Parse CSV text with a header row into rows keyed by header name. Values are
 * trimmed; headers are lower-cased and trimmed so `Audio_URL` and `audio_url`
 * are the same column.
 */
export function parseCsv(text: string): ParsedCsv {
  const records = parseCsvRecords(text);
  const header = records[0];
  if (!header) return { headers: [], rows: [] };

  const headers = header.cells.map((h) => h.trim().toLowerCase());
  const rows = records.slice(1).map((record) => {
    const values: Record<string, string> = {};
    headers.forEach((name, i) => {
      if (!name) return;
      values[name] = (record.cells[i] ?? '').trim();
    });
    return { line: record.line, values };
  });

  return { headers, rows };
}

/**
 * CSV reading and writing, shared by every surface that imports or exports a
 * firm's QA manual.
 *
 * A QA manual is a spreadsheet export, and spreadsheet exports contain the two
 * things a split-on-comma parser gets wrong: commas inside quoted fields
 * ("Confirmed the customer's name, address and date of birth") and line breaks
 * inside quoted fields (a multi-line rubric). Splitting on `,` silently shifts
 * every later column of that row by one, so a rubric lands in the severity
 * column and the row imports as a checkpoint with no severity and a mangled
 * label — with nothing to tell anyone it happened.
 */

/**
 * Read a CSV document into rows of raw cell values.
 *
 * Handles quoted fields, commas and newlines inside quotes, `""` as an escaped
 * quote, CRLF and CR line endings, and a leading byte-order mark. Cells are
 * returned exactly as written (no trimming) — trimming is a decision for the
 * caller, which knows whether leading space is meaningful.
 *
 * Rows that are entirely empty are dropped, so a trailing newline or a blank
 * separator line never becomes a row of empty checkpoints.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  // Strip a byte-order mark: Excel writes one, and it would otherwise become
  // part of the first header name ("﻿label"), which then matches nothing.
  const input = text.replace(/^﻿/, '');

  const endCell = () => {
    row.push(cell);
    cell = '';
  };
  const endRow = () => {
    endCell();
    // A row of nothing but empty cells carries no data in any CSV we accept.
    if (row.some((c) => c.trim() !== '')) rows.push(row);
    row = [];
  };

  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          // "" inside a quoted field is a literal quote.
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      endCell();
    } else if (char === '\n') {
      endRow();
    } else if (char === '\r') {
      // CRLF or a lone CR (old Mac exports) — the \n, if any, is consumed here.
      if (input[i + 1] === '\n') i++;
      endRow();
    } else {
      cell += char;
    }
  }

  // Whatever is left after the last line ending, when the file doesn't end in one.
  if (cell !== '' || row.length > 0) endRow();

  return rows;
}

/**
 * Quote a single value for writing into a CSV, only where quoting is needed —
 * a field containing a comma, a quote, a line break, or leading/trailing space
 * that a reader would otherwise be free to drop.
 */
export function csvEscape(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str === '') return '';
  const needsQuotes = /[",\r\n]/.test(str) || str !== str.trim();
  if (!needsQuotes) return str;
  return `"${str.replace(/"/g, '""')}"`;
}

/**
 * Write rows out as a CSV document, CRLF-terminated — the line ending Excel
 * and Numbers both open without prompting.
 */
export function toCsv(rows: (string | number | boolean | null | undefined)[][]): string {
  return rows.map((row) => row.map(csvEscape).join(',')).join('\r\n');
}

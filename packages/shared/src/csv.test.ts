import { describe, it, expect } from 'vitest';
import { parseCsv, parseCsvRecords, csvEscape, toCsv } from './csv.js';

describe('parseCsvRecords', () => {
  it('reads plain rows and numbers them by file line', () => {
    expect(parseCsvRecords('a,b\n1,2\n3,4')).toEqual([
      { line: 1, cells: ['a', 'b'] },
      { line: 2, cells: ['1', '2'] },
      { line: 3, cells: ['3', '4'] },
    ]);
  });

  it('keeps a comma inside a quoted field in one cell', () => {
    expect(parseCsvRecords('"Webb, Marcus",2')).toEqual([
      { line: 1, cells: ['Webb, Marcus', '2'] },
    ]);
  });

  it('unescapes a doubled quote inside a quoted field', () => {
    expect(parseCsvRecords('"say ""hello""",b')).toEqual([
      { line: 1, cells: ['say "hello"', 'b'] },
    ]);
  });

  it('only treats a leading quote as opening a quoted field', () => {
    expect(parseCsvRecords('a"b,c')).toEqual([{ line: 1, cells: ['a"b', 'c'] }]);
  });

  it('handles CRLF line endings', () => {
    expect(parseCsvRecords('a,b\r\n1,2\r\n')).toEqual([
      { line: 1, cells: ['a', 'b'] },
      { line: 2, cells: ['1', '2'] },
    ]);
  });

  it('skips blank lines but still counts them in line numbers', () => {
    expect(parseCsvRecords('a,b\n\n1,2\n   \n3,4\n')).toEqual([
      { line: 1, cells: ['a', 'b'] },
      { line: 3, cells: ['1', '2'] },
      { line: 5, cells: ['3', '4'] },
    ]);
  });

  it('keeps a row of empty cells, which is not a blank line', () => {
    expect(parseCsvRecords('a,b\n,\n')).toEqual([
      { line: 1, cells: ['a', 'b'] },
      { line: 2, cells: ['', ''] },
    ]);
  });

  it('keeps a newline inside a quoted field, and numbers the next record after it', () => {
    expect(parseCsvRecords('a,b\n"two\nlines",2\n3,4')).toEqual([
      { line: 1, cells: ['a', 'b'] },
      { line: 2, cells: ['two\nlines', '2'] },
      { line: 4, cells: ['3', '4'] },
    ]);
  });

  it('reads a final record with no trailing newline', () => {
    expect(parseCsvRecords('a,')).toEqual([{ line: 1, cells: ['a', ''] }]);
  });

  it('returns nothing for empty or whitespace-only text', () => {
    expect(parseCsvRecords('')).toEqual([]);
    expect(parseCsvRecords('\n\n')).toEqual([]);
  });

  it('strips a UTF-8 BOM from the first cell', () => {
    expect(parseCsvRecords('﻿audio_url,agent_name')).toEqual([
      { line: 1, cells: ['audio_url', 'agent_name'] },
    ]);
  });
});

describe('parseCsv', () => {
  it('keys values by lower-cased header name and trims them', () => {
    const parsed = parseCsv('Audio_URL, Agent_Name \nhttps://x/a.mp3, Marcus Webb ');
    expect(parsed.headers).toEqual(['audio_url', 'agent_name']);
    expect(parsed.rows).toEqual([
      { line: 2, values: { audio_url: 'https://x/a.mp3', agent_name: 'Marcus Webb' } },
    ]);
  });

  it('reads missing trailing cells as empty', () => {
    const parsed = parseCsv('audio_url,agent_name,call_date\nhttps://x/a.mp3');
    expect(parsed.rows[0]!.values).toEqual({
      audio_url: 'https://x/a.mp3',
      agent_name: '',
      call_date: '',
    });
  });

  it('reports each row against its own line in the file', () => {
    const parsed = parseCsv('audio_url\n\nhttps://x/a.mp3\nhttps://x/b.mp3');
    expect(parsed.rows.map((r) => r.line)).toEqual([3, 4]);
  });

  it('ignores an unnamed column', () => {
    const parsed = parseCsv('audio_url,,agent_name\nhttps://x/a.mp3,junk,Marcus Webb');
    expect(parsed.rows[0]!.values).toEqual({
      audio_url: 'https://x/a.mp3',
      agent_name: 'Marcus Webb',
    });
  });

  it('returns no rows for empty text', () => {
    expect(parseCsv('')).toEqual({ headers: [], rows: [] });
  });
});

describe('csvEscape / toCsv — what we write back out', () => {
  it('leaves a plain value alone', () => {
    expect(csvEscape('Greeted the customer')).toBe('Greeted the customer');
  });

  it('quotes a value containing a comma', () => {
    expect(csvEscape('name, address')).toBe('"name, address"');
  });

  it('doubles an embedded quote', () => {
    expect(csvEscape('Said "hello"')).toBe('"Said ""hello"""');
  });

  it('quotes a value containing a line break', () => {
    expect(csvEscape('one\ntwo')).toBe('"one\ntwo"');
  });

  it('quotes a value whose spacing would otherwise be lost', () => {
    expect(csvEscape('  padded  ')).toBe('"  padded  "');
  });

  it('writes null and undefined as an empty cell', () => {
    expect(csvEscape(null)).toBe('');
    expect(csvEscape(undefined)).toBe('');
  });

  it('writes numbers and booleans as themselves', () => {
    expect(csvEscape(1.5)).toBe('1.5');
    expect(csvEscape(false)).toBe('false');
  });

  it('round-trips a document through toCsv and the reader unchanged', () => {
    const rows = [
      ['label', 'description', 'weight'],
      ['Confirmed name, address and DOB', 'Line one\nLine two', 2],
      ['Said "authorised and regulated"', '', 1],
    ];
    expect(parseCsvRecords(toCsv(rows)).map((r) => r.cells)).toEqual([
      ['label', 'description', 'weight'],
      ['Confirmed name, address and DOB', 'Line one\nLine two', '2'],
      ['Said "authorised and regulated"', '', '1'],
    ]);
  });
});

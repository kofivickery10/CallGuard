import { describe, it, expect } from 'vitest';
import { parseCsv, csvEscape, toCsv } from './csv.js';

// The reason this module exists: a firm's QA manual is a spreadsheet export,
// and the checkpoints in one routinely contain commas and line breaks. Under a
// split-on-comma reader those rows import with the columns shifted — a rubric
// in the severity column, a truncated label, and no error to say so.

describe('parseCsv — the shapes a real QA manual arrives in', () => {
  it('reads a plain header and row', () => {
    expect(parseCsv('label,severity\nGreeted the customer,low')).toEqual([
      ['label', 'severity'],
      ['Greeted the customer', 'low'],
    ]);
  });

  it('keeps a comma that sits inside a quoted field', () => {
    const rows = parseCsv('label,severity\n"Confirmed name, address and date of birth",high');
    expect(rows[1]).toEqual(['Confirmed name, address and date of birth', 'high']);
  });

  it('keeps a line break that sits inside a quoted field', () => {
    const rows = parseCsv('label,description\nX,"Line one\nLine two"');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual(['X', 'Line one\nLine two']);
  });

  it('reads a doubled quote as one literal quote', () => {
    const rows = parseCsv('label\n"Said ""authorised and regulated by the FCA"""');
    expect(rows[1]).toEqual(['Said "authorised and regulated by the FCA"']);
  });

  it('strips a byte-order mark so the first header still matches', () => {
    const rows = parseCsv('﻿label,weight\nX,2');
    expect(rows[0]).toEqual(['label', 'weight']);
  });

  it('handles CRLF line endings', () => {
    expect(parseCsv('a,b\r\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('handles a lone CR line ending', () => {
    expect(parseCsv('a,b\rc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('drops blank and trailing-newline rows rather than importing empty checkpoints', () => {
    expect(parseCsv('a,b\n\nc,d\n\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('keeps empty cells inside a row that has content', () => {
    expect(parseCsv('a,b,c\n1,,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '', '3'],
    ]);
  });

  it('does not trim cells — that is the caller’s decision', () => {
    expect(parseCsv('a, b\n1, 2')).toEqual([
      ['a', ' b'],
      ['1', ' 2'],
    ]);
  });

  it('reads a final row with no trailing newline', () => {
    expect(parseCsv('a\nb')).toEqual([['a'], ['b']]);
  });

  it('returns nothing for an empty document', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('\n\n')).toEqual([]);
  });

  it('keeps a quote that appears in an unquoted field', () => {
    expect(parseCsv('a\n5" of rain')).toEqual([['a'], ['5 of rain']]);
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

  it('round-trips a document through toCsv and parseCsv unchanged', () => {
    const rows = [
      ['label', 'description', 'weight'],
      ['Confirmed name, address and DOB', 'Line one\nLine two', 2],
      ['Said "authorised and regulated"', '', 1],
    ];
    expect(parseCsv(toCsv(rows))).toEqual([
      ['label', 'description', 'weight'],
      ['Confirmed name, address and DOB', 'Line one\nLine two', '2'],
      ['Said "authorised and regulated"', '', '1'],
    ]);
  });
});

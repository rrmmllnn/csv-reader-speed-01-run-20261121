// Fast drop-in for csv-reader 1.0.0 (make.fun's own CSV reader).
//
// Returns exactly what csv-reader returns for {text, header}: {columns, rows, errors}.
// Same broken-row policy, byte for byte:
//   - a U+FEFF at the very start is dropped;
//   - a record ends at LF or CRLF; a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field opening with a quote runs to the next quote that is not doubled, "" inside
//     it is one quote, each CRLF or lone CR inside it is read as LF; what follows its
//     closing quote, up to the next comma or line break, is appended as it stands
//     (quote_junk, when the field ends); a quote that never closes is a literal
//     character and the text after it is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings;
//   - columns is the first record when header is true, else null; rows are the records
//     after it (every record when header is false), padded with "" (short_row, with
//     fields: its field count) or cut (long_row, with extra: the cut fields) to the
//     first record's width; each error is {code, line, row} in the order met, line the
//     1-based line its record starts on, row its record's index in rows (null for the
//     header).
//
// Speed: the reference reads one character at a time and builds every field a
// character at a time. This reader instead takes the fast path wherever the text
// allows it. The text is split into physical lines once, and each line is read
// by the cheapest reader that can take it:
//   - a line holding no quote and no stray CR is split in one native
//     String.split(',') call;
//   - a line whose quoted fields are simple (no line break inside, nothing after
//     a closing quote but a comma or the line's end) is read field by field with
//     indexOf jumps and slices, doubled quotes collapsed as they are met;
//   - only lines that actually hold a doubled quote spanning nothing (handled
//     above), a quoted field running over lines, junk after a closing quote, a
//     stray CR, or a quote that never closes fall to the careful field-by-field
//     reader, which still works on slices.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to the next.

const COMMA = 0;
const LINE = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // Reads an unquoted field starting at pos: up to the next comma, line break or end
  // of the text. A CR not followed by LF is dropped (stray_cr). `init` is the field's
  // text so far ('' normally; the value of a quoted field whose junk follows it, or
  // '"' for a quote that never closes). Returns {value, ended, added}: `added` counts
  // the characters this scan kept, so a caller can tell junk from nothing.
  function readUnquoted(init) {
    const ci = text.indexOf(',', pos);
    const li = text.indexOf('\n', pos);
    let end = n;
    let kind = END;
    if (ci !== -1 && ci < end) {
      end = ci;
      kind = COMMA;
    }
    if (li !== -1 && li < end) {
      end = li;
      kind = LINE;
    }
    const seg = text.slice(pos, end);
    let lim = seg.length;
    // A CR as the segment's last character before a LF is the CRLF line break.
    if (kind === LINE && lim > 0 && seg.charCodeAt(lim - 1) === 13) lim -= 1;
    let value = init;
    let added = 0;
    const ri = seg.indexOf('\r');
    if (ri === -1 || ri >= lim) {
      if (lim > 0) {
        value += seg.slice(0, lim);
        added = lim;
      }
    } else {
      // Stray CRs inside the field: each is dropped and reported, the rest kept.
      let start = 0;
      for (let i = ri; i < lim; i++) {
        if (seg.charCodeAt(i) === 13) {
          if (i > start) {
            value += seg.slice(start, i);
            added += i - start;
          }
          errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          start = i + 1;
        }
      }
      if (lim > start) {
        value += seg.slice(start, lim);
        added += lim - start;
      }
    }
    if (kind === END) {
      pos = n;
      return { value, ended: END, added };
    }
    if (kind === COMMA) {
      pos = end + 1;
      return { value, ended: COMMA, added };
    }
    pos = end + 1;
    line += 1;
    return { value, ended: LINE, added };
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;

    // Fast: the closing quote, with no doubled quote and no line break before it.
    const q = text.indexOf('"', pos);
    if (q !== -1) {
      const nl = text.indexOf('\n', pos);
      const cr = text.indexOf('\r', pos);
      let firstBreak = -1;
      if (nl !== -1) firstBreak = nl;
      if (cr !== -1 && (firstBreak === -1 || cr < firstBreak)) firstBreak = cr;
      if ((firstBreak === -1 || firstBreak >= q) && text.charCodeAt(q + 1) !== 34) {
        const value = text.slice(pos, q);
        pos = q + 1;
        if (pos >= n) return { value, ended: END };
        const c = text.charCodeAt(pos);
        if (c === 44) {
          pos += 1;
          return { value, ended: COMMA };
        }
        if (c === 10) {
          pos += 1;
          line += 1;
          return { value, ended: LINE };
        }
        if (c === 13 && text.charCodeAt(pos + 1) === 10) {
          pos += 2;
          line += 1;
          return { value, ended: LINE };
        }
        // What follows the closing quote is appended as it stands.
        const junk = readUnquoted(value);
        if (junk.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
        return junk;
      }
    } else {
      // No quote anywhere after the opening one: it never closes.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      return readUnquoted('"');
    }

    // Slow: doubled quotes, line breaks inside the quotes, or both.
    let value = '';
    let seg = pos;
    let closed = false;
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 34) {
        if (text.charCodeAt(pos + 1) === 34) {
          value += text.slice(seg, pos) + '"';
          pos += 2;
          seg = pos;
          continue;
        }
        value += text.slice(seg, pos);
        pos += 1;
        closed = true;
        break;
      }
      if (c === 13) {
        // CRLF and a lone CR inside quotes are each one LF.
        value += text.slice(seg, pos) + '\n';
        line += 1;
        pos += text.charCodeAt(pos + 1) === 10 ? 2 : 1;
        seg = pos;
        continue;
      }
      if (c === 10) line += 1;
      pos += 1;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text after it is
      // read again as an unquoted field.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      return readUnquoted('"');
    }
    if (pos >= n) return { value, ended: END };
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return { value, ended: COMMA };
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return { value, ended: LINE };
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: LINE };
    }
    const junk = readUnquoted(value);
    if (junk.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return junk;
  }

  // Tries to read one record from text[start..end), one physical line with no CR
  // in it (a trailing CRLF CR is already outside the range). Returns true when
  // the record is read and finished; false when it holds something this path
  // cannot read -- a quoted field running over lines, junk after a closing quote,
  // or a quote that never closes -- in which case the caller falls back to the
  // field-by-field reader, which starts again from the record's first character.
  // Nothing is mutated on a bail, so the fallback sees the record untouched.
  function parseLine(start, end) {
    const fields = [];
    let i = start;
    let quoted = false;
    while (true) {
      if (text.charCodeAt(i) === 34) {
        // Quoted field: runs to the next quote that is not doubled; "" inside it
        // is one quote. No closing quote on this line means the field runs over
        // lines (or never closes): the slow path reads it.
        let value = '';
        let s = i + 1;
        let q = text.indexOf('"', s);
        while (q !== -1 && q < end && text.charCodeAt(q + 1) === 34) {
          value += text.slice(s, q) + '"';
          s = q + 2;
          q = text.indexOf('"', s);
        }
        if (q === -1 || q >= end) return false;
        value += text.slice(s, q);
        fields.push(value);
        quoted = true;
        i = q + 1;
        if (i >= end) break;
        if (text.charCodeAt(i) !== 44) return false;
        i += 1;
        continue;
      }
      const c = text.indexOf(',', i);
      if (c === -1 || c >= end) {
        fields.push(text.slice(i, end));
        quoted = false;
        break;
      }
      fields.push(text.slice(i, c));
      quoted = false;
      i = c + 1;
    }
    finishRecord(fields, quoted);
    return true;
  }

  // Finishes one record: a line left with no characters is no record; the first
  // record sets the width (and is the header when header is true); the rest are
  // padded or cut to it.
  function finishRecord(fields, quoted) {
    if (fields.length === 1 && fields[0] === '' && !quoted) return;
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  // The text's physical lines, split once. li/off track the line being read and
  // its start in the text; the slow path reads from the text by pos and the loop
  // resyncs li/off to it afterwards (a multi-line quoted field consumes lines).
  const lines = text.split('\n');
  let li = 0;
  let off = pos;
  if (pos === 1) lines[0] = lines[0].slice(1);

  while (li < lines.length) {
    const raw = lines[li];
    const isLast = li === lines.length - 1;
    let end = raw.length;
    // A CR at the end of a line that a LF follows is the CRLF line break.
    if (!isLast && end > 0 && raw.charCodeAt(end - 1) === 13) end -= 1;
    if (end === 0) {
      // A line left with no characters is no record.
      li += 1;
      off += raw.length + 1;
      line += 1;
      continue;
    }

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const start = off;
    const stop = off + end;
    const hasQuote = raw.indexOf('"') !== -1;
    // A CR in the line that is not the CRLF break already stripped: a stray CR,
    // or one inside a quoted field. Either way the slow path reads the record.
    const crAt = raw.indexOf('\r');
    const hasCR = crAt !== -1 && (isLast || crAt !== raw.length - 1);

    if (!hasQuote && !hasCR) {
      // One physical line, no quote, no stray CR: one native split.
      const fields = text.slice(start, stop).split(',');
      li += 1;
      off += raw.length + 1;
      line += 1;
      finishRecord(fields, false);
      continue;
    }
    if (!hasCR && parseLine(start, stop)) {
      li += 1;
      off += raw.length + 1;
      line += 1;
      continue;
    }

    // Slow path: the record holds a quoted field running over lines, junk after
    // a closing quote, a stray CR, or a quote that never closes.
    pos = start;
    const fields = [];
    let field;
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field.value);
    } while (field.ended === COMMA);
    finishRecord(fields, quoted);
    // Resync the line index to where the slow path stopped.
    while (off < pos && li < lines.length) {
      off += lines[li].length + 1;
      li += 1;
    }
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}

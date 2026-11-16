// =====================================================================
// PlantUML for GitHub - Review-comment notes
// =====================================================================
// Pure functions (no DOM access) that turn a PlantUML source plus a list
// of PR review threads into an annotated PlantUML source where each
// thread is rendered as a note next to the line it was written on.
//
// Loaded as a content script before content.js; exposed on
// globalThis.PUML4GH_NOTES. Also exported via module.exports so it can be
// unit-tested in Node.
//
// Placement strategy, per thread (target = 1-based line in the file):
//   1. Find the *statement* containing the target line. Multi-line
//      constructs (note...end note, class X { ... }, skinparam {...},
//      legend, !procedure, block comments, ...) count as one statement,
//      so a note is never inserted in the middle of one.
//   2. Classify the statement and pick an attached note:
//        sequence message / C4 Rel  -> "note right"   (attaches to message)
//        sequence participant       -> "note over X"
//        activity action ":...;"     -> "note right"
//        element declaration        -> "note right of X"
//        graph arrow / C4 Rel       -> "note on link"
//   3. Anything else is "floating": collected and appended at the end as
//      `note across` (sequence), floating notes (graphs) or a legend.
// The caller renders the result; if PlantUML reports a syntax error on a
// line we inserted, it calls demote() to turn that one note into a
// floating one and re-renders (see content.js).
// =====================================================================

(function (root) {
  'use strict';

  // PlantUML's dark mode draws note text light, so the fill must follow.
  const NOTE_COLOR_LIGHT = '#FFF4C2';
  const NOTE_COLOR_DARK = '#5C4813';
  let NOTE_COLOR = NOTE_COLOR_LIGHT;
  const WRAP = 56;          // characters per note line
  const MAX_BODY = 280;     // characters per comment body on the diagram (the side panel shows all)

  // ------------------------------------------------------------------
  // Text sanitising. Comment bodies are untrusted text that we splice
  // into PlantUML source, which then goes through PlantUML's
  // preprocessor. Neutralise everything that could change the meaning
  // of the surrounding diagram or reach the network.
  // ------------------------------------------------------------------
  const ZWSP = '​';

  function stripMarkdown(md) {
    return String(md || '')
      .replace(/\r\n?/g, '\n')
      .replace(/```suggestion[\s\S]*?```/g, '[suggested change]')
      .replace(/```[\w-]*\n?([\s\S]*?)```/g, '$1')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '[image$1]')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<\/?[a-zA-Z][^>]*>/g, '')
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/(^|[\s(])([*_])(?=\S)(.+?)(\S)\2(?=[\s).,:;!?]|$)/gm, '$1$3$4')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s{0,3}>\s?/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function sanitizeLine(s) {
    return s
      // Creole/HTML-ish markup: <img:...>, <&icon>, <size:..>, <color> etc.
      .replace(/</g, '‹').replace(/>/g, '›')
      // Preprocessor: $variables, %functions, macro calls Foo( ...
      .replace(/([$%])(?=\w)/g, '$1' + ZWSP)
      .replace(/(\w)\(/g, '$1' + ZWSP + '(')
      // Creole links [[...]] and escape char.
      .replace(/\[\[/g, '[' + ZWSP + '[')
      .replace(/~/g, '∼')
      // Line-leading characters that PlantUML treats specially:
      // ' comment, ! directive, @ start/end, / for /' block comments,
      // and words that would terminate the note block.
      .replace(/^\s*(['!@/]|end\s*note\b|endnote\b|end\s*legend\b|endlegend\b)/i, ZWSP + '$1');
  }

  function wrapText(text, width) {
    const out = [];
    for (const para of text.split('\n')) {
      const words = para.split(/[ \t]+/).filter(Boolean);
      if (!words.length) { out.push(''); continue; }
      let line = '';
      for (let w of words) {
        while (w.length > width) {            // hard-break very long tokens
          if (line) { out.push(line); line = ''; }
          out.push(w.slice(0, width));
          w = w.slice(width);
        }
        if (!line) line = w;
        else if (line.length + 1 + w.length <= width) line += ' ' + w;
        else { out.push(line); line = w; }
      }
      if (line) out.push(line);
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    return out;
  }

  // One thread -> array of note body lines (already sanitised).
  function threadToLines(thread, opts) {
    const lines = [];
    const prefix = opts && opts.withLine ? 'L' + thread.line + ' ' : '';
    thread.comments.forEach((c, i) => {
      let body = stripMarkdown(c.body);
      if (body.length > MAX_BODY) body = body.slice(0, MAX_BODY - 1).trimEnd() + '…';
      const head = (i === 0 ? '💬 ' + prefix : '↳ ') + '**' + sanitizeLine(c.author || 'unknown') + '**';
      lines.push(head);
      for (const l of wrapText(body, WRAP)) lines.push(sanitizeLine(l));
    });
    return lines;
  }

  // ------------------------------------------------------------------
  // Diagram-type detection (only needs to be good enough to choose a
  // note syntax; mistakes are caught by the error-retry loop).
  // ------------------------------------------------------------------
  const SEQ_DECL_RE = /^\s*(participant|actor|boundary|control|entity|database|collections|queue)\b/i;
  const ARROW_RE = /(<?-+>{1,2}|<{1,2}-+|-+\\\\|\\\\-+|-+\/\/?|<?\.+>|<\.+|-\[[^\]]*\]->?|<?-+o|<?-+x\b|-+\*|\*-+|\|>|<\|)/;

  function detectType(lines) {
    let seq = 0, act = 0, graph = 0;
    for (const raw of lines) {
      const l = raw.trim();
      if (!l || l.startsWith("'")) continue;
      if (/C4_Sequence/.test(l)) seq += 10;
      if (/C4_(Context|Container|Component|Deployment|Dynamic)/.test(l)) graph += 10;
      // "actor" also appears in use-case diagrams, so it is not evidence.
      if (SEQ_DECL_RE.test(l) && !/^actor\b/i.test(l)) seq += 2;
      if (/^(autonumber|activate|deactivate|destroy|return)\b/.test(l)) seq += 3;
      if (/^(alt|loop|opt|par|critical|break|group|ref over)\b/.test(l)) seq += 2;
      if (/^(==.*==|\.\.\.|\|\|\|)$/.test(l)) seq += 2;
      if (/^[\w"]+\s*-+>+\s*[\w"]+\s*(\+\+|--|\*\*|!!)?\s*:/.test(l)) seq += 1;
      if (/^:.*[;|<>/\]}]$/.test(l) || /^(start|stop|end|endif|endwhile|fork|end fork|repeat)$/.test(l) || /^(if|while|elseif)\s*\(/.test(l)) act += 2;
      if (/^(abstract\s+class|class|interface|enum|annotation|component|node|package|rectangle|cloud|folder|frame|usecase|state|object|artifact|storage|card|namespace)\b/.test(l)) graph += 2;
      if (/^\[[^\]]+\]/.test(l) || /^\([^)]+\)\s*(as\b|$)/.test(l)) graph += 2;
      if (/^usecase\b|^:[^:]+:/.test(l)) graph += 2;
    }
    if (seq === 0 && act === 0 && graph === 0) return 'unknown';
    if (seq >= act && seq >= graph) return seq >= 2 ? 'sequence' : 'unknown';
    if (act >= graph) return 'activity';
    return 'graph';
  }

  // ------------------------------------------------------------------
  // Statement segmentation.
  // Returns an array (index = 0-based line) -> { start, end, kind } where
  // start/end are 0-based inclusive indexes of the enclosing statement.
  // ------------------------------------------------------------------
  function segment(lines) {
    const stmt = new Array(lines.length);
    let i = 0;
    const set = (s, e, kind) => { for (let k = s; k <= e; k++) stmt[k] = { start: s, end: e, kind }; };
    const findEnd = (from, re) => {
      for (let k = from; k < lines.length; k++) if (re.test(lines[k])) return k;
      return lines.length - 1;
    };
    while (i < lines.length) {
      const l = lines[i];
      const t = l.trim();
      let m;
      if (/^\/'/.test(t) && !/'\/\s*$/.test(t.slice(2))) {
        const e = findEnd(i + 1, /'\/\s*$/); set(i, e, 'comment'); i = e + 1; continue;
      }
      // Multi-line notes: "note left", "note over A", "note right of X", "note as N1",
      // "note on link", "hnote", "rnote" -- without ":" text on the same line.
      if (isMultiLineNoteStart(t)) {
        const e = findEnd(i + 1, /^\s*end\s*[hr]?note\b|^\s*endnote\b/i); set(i, e, 'note'); i = e + 1; continue;
      }
      if (/^legend\b/i.test(t)) { const e = findEnd(i + 1, /^\s*end\s*legend\b|^\s*endlegend\b/i); set(i, e, 'legend'); i = e + 1; continue; }
      if (/^(title|header|footer|caption)$/i.test(t)) { const e = findEnd(i + 1, /^\s*end\s*(title|header|footer|caption)\b/i); set(i, e, 'meta'); i = e + 1; continue; }
      if (/^<style>/i.test(t)) { const e = findEnd(i, /<\/style>/i); set(i, e, 'style'); i = e + 1; continue; }
      if (/^!(procedure|function|unquoted|definelong)\b/i.test(t)) { const e = findEnd(i + 1, /^\s*!(end\s*procedure|endprocedure|end\s*function|endfunction|enddefinelong)\b/i); set(i, e, 'preproc'); i = e + 1; continue; }
      if (/^skinparam\b.*\{\s*$/i.test(t)) { const e = findBrace(lines, i); set(i, e, 'skinparam'); i = e + 1; continue; }
      // Class-like bodies: "class Foo {", "enum X {", "state S {" are
      // NOT closed here for state/package (those contain statements),
      // only for member-list bodies.
      if ((m = /^(abstract\s+class|abstract|class|interface|enum|annotation|entity|struct|protocol|object|map|json)\b.*\{\s*$/i.exec(t))) {
        const e = findBrace(lines, i); set(i, e, 'decl'); i = e + 1; continue;
      }
      // Multi-line activity action ":foo" ... "bar;"
      if (/^:/.test(t) && !/[;|<>/\]}]\s*$/.test(t)) {
        const e = findEnd(i + 1, /[;|<>/\]}]\s*$/); set(i, e, 'action'); i = e + 1; continue;
      }
      // Macro call spanning multiple lines (unbalanced parentheses).
      if (/^\$?\w+\s*\(/.test(t) && parenBalance(t) > 0) {
        let e = i, bal = parenBalance(t);
        while (bal > 0 && e + 1 < lines.length) { e++; bal += parenBalance(lines[e]); }
        set(i, e, 'line'); i = e + 1; continue;
      }
      set(i, i, 'line');
      i++;
    }
    return stmt;
  }

  // "note left", "note over A", "note right of X #color", "note as N1",
  // "note on link", "hnote over A", "floating note left" open a block that
  // runs until "end note". Single-line forms carry their text after ":"
  // (outside quotes) or are `note "text" as N1`.
  function isMultiLineNoteStart(t) {
    const m = /^(?:floating\s+)?[hr]?note\b(.*)$/i.exec(t);
    if (!m) return false;
    const rest = m[1].replace(/"[^"]*"/g, '""');
    if (rest.includes(':')) return false;
    if (/^\s*""/.test(rest)) return false;   // note "text" as N1
    return true;
  }

  function parenBalance(s) {
    let b = 0, q = false;
    for (const ch of s) {
      if (ch === '"') q = !q;
      else if (!q && ch === '(') b++;
      else if (!q && ch === ')') b--;
    }
    return b;
  }

  function findBrace(lines, from) {
    let depth = 0;
    for (let k = from; k < lines.length; k++) {
      for (const ch of lines[k]) {
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) return k; }
      }
    }
    return lines.length - 1;
  }

  // ------------------------------------------------------------------
  // Alias extraction from a declaration statement.
  // ------------------------------------------------------------------
  const C4_NON_ELEMENT = /^(Rel|BiRel|Rel_\w+|BiRel_\w+|Lay_\w+|Add\w+|Update\w+|SHOW_\w+|HIDE_\w+|LAYOUT_\w+|SET_\w+|WithoutPropertyHeader|AddProperty|RelIndex\w*|Increment|SetIndex|LastIndex|Index)$/;

  function aliasOf(text) {
    const t = text.trim();
    let m;
    // C4 / stdlib element macro: Container(api, "API", ...)
    if ((m = /^(\$?[A-Za-z_]\w*)\s*\(\s*([A-Za-z_][\w.]*)\s*[,)]/.exec(t)) && !C4_NON_ELEMENT.test(m[1])) {
      return m[2];
    }
    // "... as Alias" (keyword, [Comp], (UC), :Actor:, "Quoted" forms)
    if ((m = /\bas\s+([A-Za-z_][\w.]*)/.exec(t))) return m[1];
    // keyword Name  (unquoted, no alias)
    if ((m = /^(?:abstract\s+class|abstract|class|interface|enum|annotation|entity|component|node|database|actor|usecase|package|rectangle|cloud|folder|frame|queue|artifact|storage|file|card|agent|boundary|control|collections|participant|state|object|map|json|struct|protocol)\s+([A-Za-z_][\w.]*)/i.exec(t))) return m[1];
    // [Component] / (Use case) / :Actor: with simple names
    if ((m = /^\[([A-Za-z_]\w*)\]/.exec(t)) || (m = /^\(([A-Za-z_]\w*)\)/.exec(t)) || (m = /^:([A-Za-z_]\w*):/.exec(t))) {
      return t[0] === '[' ? '[' + m[1] + ']' : t[0] === '(' ? '(' + m[1] + ')' : ':' + m[1] + ':';
    }
    return null;
  }

  function isSeqDecl(t) {
    return SEQ_DECL_RE.test(t) && !ARROW_RE.test(t.replace(/"[^"]*"/g, ''));
  }

  function isArrowLine(t) {
    const noStr = t.replace(/"[^"]*"/g, '""');
    const beforeColon = noStr.split(':')[0];
    return ARROW_RE.test(beforeColon);
  }

  const C4_REL = /^(Rel|BiRel|Rel_[A-Za-z]+|BiRel_[A-Za-z]+|RelIndex\w*)\s*\(/;
  const SEQ_GROUP = /^(alt|else|opt|loop|par|par2|critical|break|group|end|ref)\b/i;

  // Decide how to attach a note to the statement [s.start..s.end].
  // Returns { kind: 'after', header } or null (=> floating).
  function placement(type, lines, s) {
    if (s.kind === 'comment' || s.kind === 'note' || s.kind === 'legend' ||
        s.kind === 'meta' || s.kind === 'style' || s.kind === 'preproc' || s.kind === 'skinparam') {
      return null;
    }
    const t = lines[s.start].trim();
    if (!t || /^@(start|end)\w+/i.test(t) || /^(skinparam|title|header|footer|caption|scale|hide|show|left to right|top to bottom|!|'|autonumber|allowmixing|set\s|newpage|LAYOUT_|SHOW_|HIDE_|Update|Add\w*Tag|AddProperty)/i.test(t)) {
      return null;
    }
    if (type === 'sequence') {
      // Fragments, activations, separators, delays: no single thing to
      // attach to, but the *position in time* matters, so span the
      // diagram right there.
      if (SEQ_GROUP.test(t) || /^(activate|deactivate|destroy|create|return)\b/i.test(t) ||
          /^(==.*==|\.\.\..*|\|\|\d*\|\|?)$/.test(t)) {
        return { header: 'note across ' + NOTE_COLOR };
      }
      if (C4_REL.test(t)) return { header: 'note right ' + NOTE_COLOR };
      if (isSeqDecl(t)) {
        const a = aliasOf(t);
        return a ? { header: 'note over ' + a + ' ' + NOTE_COLOR } : null;
      }
      if (isArrowLine(t)) return { header: 'note right ' + NOTE_COLOR };
      // C4_Sequence element macros: Container(alias, ...)
      const a = aliasOf(t);
      if (a && /^\$?\w+\s*\(/.test(t)) return { header: 'note over ' + a + ' ' + NOTE_COLOR };
      return null;
    }
    if (type === 'activity') {
      if (/^:/.test(t)) return { header: 'note right ' + NOTE_COLOR };
      return null;
    }
    if (type === 'graph' || type === 'unknown') {
      if (C4_REL.test(t)) return { header: 'note on link ' + NOTE_COLOR };
      if (isArrowLine(t) && !/^\$?\w+\s*\(/.test(t)) return { header: 'note on link ' + NOTE_COLOR };
      const a = aliasOf(t);
      if (a) {
        // Boundary/package blocks: put the note after the closing brace
        // handled by caller via s.end; for "X {" one-liners s.end is the
        // same line, so the note would land inside the block -- that is
        // fine for PlantUML (notes are allowed inside packages).
        return { header: 'note right of ' + a + ' ' + NOTE_COLOR };
      }
      return null;
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Main entry point.
  //
  // threads: [{ line: <1-based line in source>, comments: [{author, body}] }]
  // forceFloating: Set of thread indexes that must not be attached
  //                (populated by the caller's error-retry loop).
  //
  // Returns {
  //   source,            // annotated PlantUML source
  //   type,              // detected diagram type
  //   placements: [ { thread: i, mode: 'attached'|'floating'|'unplaced', startLine, endLine } ]
  //                      // startLine/endLine = 1-based lines of the inserted text in `source`
  // }
  // ------------------------------------------------------------------
  function annotate(source, threads, opts) {
    const forceFloating = (opts && opts.forceFloating) || new Set();
    const floatingStyle = opts && opts.floatingStyle; // override: 'legend'
    NOTE_COLOR = opts && opts.dark ? NOTE_COLOR_DARK : NOTE_COLOR_LIGHT;
    const lines = source.replace(/\r\n?/g, '\n').split('\n');

    // Restrict to the first @startuml ... @enduml block.
    let begin = lines.findIndex((l) => /^\s*@startuml\b/i.test(l));
    let finish = -1;
    if (begin >= 0) {
      for (let k = begin + 1; k < lines.length; k++) {
        if (/^\s*@enduml\b/i.test(lines[k])) { finish = k; break; }
      }
    }
    const placements = threads.map((_, i) => ({ thread: i, mode: 'unplaced' }));
    if (begin < 0 || finish < 0) {
      return { source, type: 'unknown', placements };
    }
    const body = lines.slice(begin + 1, finish);
    const type = detectType(body);
    const stmts = segment(body);

    const inserts = new Map(); // body index (insert after) -> [{thread, text[]}]
    const floating = [];
    threads.forEach((th, i) => {
      const idx = th.line - 1 - (begin + 1);       // index into body
      if (!(idx >= 0 && idx < body.length)) {     // @startuml/@enduml or outside the block
        floating.push(i);
        return;
      }
      const s = stmts[idx];
      const p = forceFloating.has(i) ? null : placement(type, body, s);
      if (p) {
        const text = [p.header].concat(threadToLines(th), ['end note']);
        if (!inserts.has(s.end)) inserts.set(s.end, []);
        inserts.get(s.end).push({ thread: i, text });
      } else {
        floating.push(i);
      }
    });

    // Assemble, tracking output line numbers of every inserted block.
    const out = lines.slice(0, begin + 1);
    body.forEach((l, k) => {
      out.push(l);
      const list = inserts.get(k);
      if (!list) return;
      for (const ins of list) {
        const startLine = out.length + 1;
        out.push(...ins.text);
        Object.assign(placements[ins.thread], { mode: 'attached', startLine, endLine: out.length });
      }
    });

    if (floating.length) {
      const style = floatingStyle || (type === 'sequence' ? 'across' : type === 'graph' ? 'float' : 'legend');
      if (style === 'legend') {
        const startLine = out.length + 1;
        out.push('legend right');
        floating.forEach((i, n) => {
          if (n) out.push('----');
          out.push(...threadToLines(threads[i], { withLine: true }));
        });
        out.push('endlegend');
        floating.forEach((i) => Object.assign(placements[i], { mode: 'floating', startLine, endLine: out.length }));
      } else {
        floating.forEach((i, n) => {
          const startLine = out.length + 1;
          out.push(style === 'across' ? 'note across ' + NOTE_COLOR : 'note as PUML4GH_REVIEW_' + (n + 1) + ' ' + NOTE_COLOR);
          out.push(...threadToLines(threads[i], { withLine: true }));
          out.push('end note');
          Object.assign(placements[i], { mode: 'floating', startLine, endLine: out.length });
        });
      }
    }
    out.push(...lines.slice(finish));
    return { source: out.join('\n'), type, placements };
  }

  // Given the result of annotate() and the 1-based line PlantUML blamed
  // for a syntax error, return the index of the thread whose inserted
  // text contains that line, or -1.
  function threadAtLine(result, errorLine) {
    for (const p of result.placements) {
      if (p.startLine && errorLine >= p.startLine && errorLine <= p.endLine) return p.thread;
    }
    return -1;
  }

  // ------------------------------------------------------------------
  // Annotate, render, and recover from notes that PlantUML rejects.
  //
  // render(src) -> Promise<{ syntaxError: boolean, errorLine: number|null }>
  // opts: { dark, maxAttempts }
  //
  // Each failed attempt demotes exactly the note PlantUML blamed:
  // attached -> floating; a broken floating note switches all floating
  // notes to a legend. If the error is not on a line we inserted (the
  // diagram itself is broken) or the attempts run out, the original
  // source is rendered without notes. Every attempt is a real render, so
  // the attempt cap bounds the worst-case latency.
  // ------------------------------------------------------------------
  async function renderWithNotes(source, threads, render, opts) {
    const limit = (opts && opts.maxAttempts) || 6;
    const dark = !!(opts && opts.dark);
    const forceFloating = new Set();
    let floatingStyle;
    let type = 'unknown';
    for (let attempt = 0; attempt < limit && threads.length; attempt++) {
      const r = annotate(source, threads, { forceFloating, floatingStyle, dark });
      type = r.type;
      const res = await render(r.source);
      if (!res.syntaxError) return Object.assign(r, { result: res, attempts: attempt + 1, notesDropped: false });
      const t = threadAtLine(r, res.errorLine);
      const anyAttached = r.placements.some((p) => p.mode === 'attached');
      if (t >= 0 && r.placements[t].mode === 'attached') {
        forceFloating.add(t);
      } else if (t < 0 && anyAttached) {
        // Blamed an original line. An attached note can still be the
        // cause (e.g. a sequence-style note pushes PlantUML into the
        // wrong diagram type), so detach everything before giving up.
        threads.forEach((_, i) => forceFloating.add(i));
      } else if (!floatingStyle) {
        floatingStyle = 'legend';
      } else {
        break;   // the diagram is broken without our help
      }
    }
    const res = await render(source);
    return {
      source, type, result: res, attempts: -1, notesDropped: threads.length > 0,
      placements: threads.map((_, i) => ({ thread: i, mode: 'unplaced' }))
    };
  }

  const api = { annotate, renderWithNotes, threadAtLine, stripMarkdown, sanitizeLine, detectType, segment, aliasOf };
  root.PUML4GH_NOTES = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

// mend: one patch tool for every AI edit format, to SPEC.md version 1.
// Reads unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON tool
// calls, finds the lines an edit names at three match tiers, and changes
// every file or none. Node 22, standard library alone.
// Run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and then this file hands over to runner.ts (the last lines below): keep
// that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ------------------------------------------------------------------ */
/* Files: lines, break style and final break (SPEC section 3)          */
/* ------------------------------------------------------------------ */

interface FileParts {
  lines: string[];
  br: string;
  eol: boolean;
}

function splitFile(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', eol: false };
  const firstNl = text.indexOf('\n');
  const br = firstNl > 0 && text[firstNl - 1] === '\r' ? '\r\n' : '\n';
  const eol = text.endsWith(br);
  const body = eol ? text.slice(0, -br.length) : text;
  return { lines: body.split(br), br, eol };
}

function joinFile(p: FileParts): string {
  if (p.lines.length === 0) return '';
  return p.lines.join(p.br) + (p.eol ? p.br : '');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

/* ------------------------------------------------------------------ */
/* Matching lines at three tiers (SPEC section 5)                      */
/* ------------------------------------------------------------------ */

const TIER_NORM: ((s: string) => string)[] = [
  (s) => s,
  (s) => s.replace(/[ \t]+$/, ''),
  (s) => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''),
];

interface Occurrence {
  tier: number;
  positions: number[];
}

/** First tier at which O occurs at least once, with every position. */
function occurrences(lines: string[], o: string[], from: number, strict: boolean): Occurrence | null {
  if (o.length === 0) return null;
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t++) {
    const norm = TIER_NORM[t]!;
    const positions: number[] = [];
    for (let i = Math.max(0, from); i + o.length <= lines.length; i++) {
      let ok = true;
      for (let j = 0; j < o.length; j++) {
        if (norm(lines[i + j]!) !== norm(o[j]!)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

/** First tier at which a single line occurs at or after `from`, first position. */
function singleOccurrence(lines: string[], anchor: string, from: number, strict: boolean): { tier: number; pos: number } | null {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t++) {
    const norm = TIER_NORM[t]!;
    for (let i = Math.max(0, from); i < lines.length; i++) {
      if (norm(lines[i]!) === norm(anchor)) return { tier: t, pos: i };
    }
  }
  return null;
}

interface NLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/** Build the replacement segment for O matched at `at`, tier `tier`. */
function buildNew(fileLines: string[], at: number, o: string[], n: NLine[], tier: number): string[] {
  const out: string[] = [];
  const f = o.length > 0 ? leadingWs(fileLines[at]!) : '';
  const p = o.length > 0 ? leadingWs(o[0]!) : '';
  for (const nl of n) {
    if (nl.ctx) {
      out.push(fileLines[at + nl.oIdx]!);
    } else if (tier === 2) {
      if (nl.text === '' || /^[ \t]+$/.test(nl.text)) out.push(nl.text);
      else if (nl.text.startsWith(p)) out.push(f + nl.text.slice(p.length));
      else out.push(nl.text);
    } else {
      out.push(nl.text);
    }
  }
  return out;
}

/** Apply O -> N at `at` to a file's parts, keeping its final break. */
function applyAt(parts: FileParts, at: number, o: string[], n: NLine[], tier: number): void {
  const seg = buildNew(parts.lines, at, o, n, tier);
  parts.lines.splice(at, o.length, ...seg);
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC section 9)                                         */
/* ------------------------------------------------------------------ */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC section 6)                                      */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number;
  o: string[];
  n: NLine[];
  /** a `\` line follows the hunk's last context or `+` line */
  noEol: boolean;
  /** a `\` line follows the hunk's last `+` line (and that line is its last context/`+` line) */
  plusNoEol: boolean;
  hasPlus: boolean;
}

function buildHunk(body: string[]): { o: string[]; n: NLine[]; noEol: boolean; plusNoEol: boolean; hasPlus: boolean } {
  const o: string[] = [];
  const n: NLine[] = [];
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let i = 0; i < body.length; i++) {
    const l = body[i]!;
    if (l.startsWith('\\')) continue;
    if (l === '' || l[0] === ' ') {
      const text = l === '' ? '' : l.slice(1);
      n.push({ text, ctx: true, oIdx: o.length });
      o.push(text);
      lastCtxPlus = i;
    } else if (l[0] === '-') {
      o.push(l.slice(1));
    } else if (l[0] === '+') {
      n.push({ text: l.slice(1), ctx: false, oIdx: -1 });
      lastCtxPlus = i;
      lastPlus = i;
    }
  }
  const noEol = lastCtxPlus >= 0 && body[lastCtxPlus + 1] !== undefined && body[lastCtxPlus + 1]!.startsWith('\\');
  const plusNoEol = lastPlus >= 0 && lastPlus === lastCtxPlus && body[lastPlus + 1] !== undefined && body[lastPlus + 1]!.startsWith('\\');
  return { o, n, noEol, plusNoEol, hasPlus: lastPlus >= 0 };
}

function headerPath(line: string): string {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

function parseUnified(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  // Working state for the section being read.
  let diffOld: string | undefined;
  let diffNew: string | undefined;
  let headOld: string | null | undefined;
  let headNew: string | null | undefined;
  let renOld: string | undefined;
  let renNew: string | undefined;
  let newFile = false;
  let delFile = false;
  let hunks: Hunk[] = [];
  let started = false;
  let inHeader = true;

  const flush = (): void => {
    if (!started) return;
    const oldPath = headOld !== undefined ? headOld : renOld !== undefined ? renOld : diffOld !== undefined ? diffOld : null;
    const newPath = headNew !== undefined ? headNew : renNew !== undefined ? renNew : diffNew !== undefined ? diffNew : null;
    sections.push({
      oldPath: oldPath === undefined ? null : oldPath,
      newPath: newPath === undefined ? null : newPath,
      create: newFile || oldPath === null,
      del: delFile || newPath === null,
      hunks,
    });
    diffOld = undefined;
    diffNew = undefined;
    headOld = undefined;
    headNew = undefined;
    renOld = undefined;
    renNew = undefined;
    newFile = false;
    delFile = false;
    hunks = [];
    started = false;
    inHeader = true;
  };

  const startDiff = (line: string, idx: number): void => {
    const parts = line.split(' ');
    if (parts.length !== 4 || !parts[2]!.startsWith('a/') || !parts[3]!.startsWith('b/')) {
      throw new Exit2(`error: parse ${idx + 1}`);
    }
    flush();
    diffOld = parts[2]!.slice(2);
    diffNew = parts[3]!.slice(2);
    started = true;
    inHeader = true;
  };

  const parseHunkAt = (idx: number): number => {
    const line = lines[idx]!;
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (m === null) throw new Exit2(`error: parse ${idx + 1}`);
    const a = Number(m[1]);
    let j = idx + 1;
    const body: string[] = [];
    while (j < lines.length) {
      const l = lines[j]!;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
      if (l.startsWith('@@')) break;
      if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
        body.push(l);
        j++;
        continue;
      }
      break;
    }
    while (body.length > 0 && body[body.length - 1] === '') body.pop();
    const built = buildHunk(body);
    hunks.push({ a, o: built.o, n: built.n, noEol: built.noEol, plusNoEol: built.plusNoEol, hasPlus: built.hasPlus });
    inHeader = false;
    return j;
  };

  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      startDiff(l, i);
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      // In a section's header this pair names its paths; anywhere else
      // (no section yet, after a hunk, or a header that already has a
      // pair) it starts a new bare section.
      if (!started || !inHeader || headOld !== undefined) flush();
      headOld = (() => {
        const p = headerPath(lines[i]!);
        return p === '/dev/null' ? null : p;
      })();
      headNew = (() => {
        const p = headerPath(lines[i + 1]!);
        return p === '/dev/null' ? null : p;
      })();
      started = true;
      inHeader = true;
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      if (!started) throw new Exit2(`error: parse ${i + 1}`);
      i = parseHunkAt(i);
      continue;
    }
    if (!started) {
      i++;
      continue;
    }
    if (inHeader) {
      if (l.startsWith('--- ')) {
        // Not followed by +++, and inside a section's header.
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (l.startsWith('+++ ')) {
        headNew = (() => {
          const p = headerPath(l);
          return p === '/dev/null' ? null : p;
        })();
        i++;
        continue;
      }
      if (l.startsWith('rename from ')) {
        renOld = l.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        renNew = l.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        newFile = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        delFile = true;
        i++;
        continue;
      }
      // index, old/new mode, similarity, Index: and anything else: ignored.
      i++;
      continue;
    }
    // Between hunks: lines that are not a section or a hunk are ignored.
    i++;
  }
  flush();
  return sections;
}

function unifiedEdits(lines: string[], strict: boolean, moves: { old: string; new: string }[]): Edit[] {
  const sections = parseUnified(lines);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => {
    return (tree: Tree) => {
      if (sec.create) {
        const p = sec.newPath;
        if (p === null) throw new Fail('missing', sec.oldPath ?? '');
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const out: string[] = [];
        let noEol = false;
        for (const h of sec.hunks) {
          for (const nl of h.n) if (!nl.ctx) out.push(nl.text);
          if (h.hasPlus) noEol = h.plusNoEol;
        }
        tree.now.set(p, out.length === 0 ? '' : out.join('\n') + (noEol ? '' : '\n'));
        return;
      }
      if (sec.del) {
        const p = sec.oldPath;
        if (p === null) throw new Fail('missing', sec.newPath ?? '');
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return;
      }
      const oldP = sec.oldPath!;
      const newP = sec.newPath!;
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (newP !== oldP && !safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (newP !== oldP && tree.get(newP) !== null) throw new Fail('exists', newP);
      const parts = splitFile(before);
      let d = 0;
      for (const h of sec.hunks) {
        if (h.o.length === 0) {
          const at = Math.min(h.a + d, parts.lines.length);
          const wasAtEnd = at === parts.lines.length;
          const seg = h.n.map((nl) => nl.text);
          parts.lines.splice(at, 0, ...seg);
          if (wasAtEnd) parts.eol = !h.noEol;
          d += h.n.length;
          continue;
        }
        const occ = occurrences(parts.lines, h.o, 0, strict);
        if (occ === null) throw new Fail('no-match', oldP);
        const target = h.a - 1 + d;
        let best = occ.positions[0]!;
        let bestDist = Math.abs(best - target);
        for (const pos of occ.positions) {
          const dist = Math.abs(pos - target);
          if (dist < bestDist) {
            best = pos;
            bestDist = dist;
          }
        }
        const touchesEnd = best + h.o.length === parts.lines.length;
        applyAt(parts, best, h.o, h.n, occ.tier);
        if (touchesEnd) parts.eol = !h.noEol;
        d += h.n.length - h.o.length;
      }
      const text = joinFile(parts);
      if (newP !== oldP) {
        tree.now.set(oldP, null);
        tree.now.set(newP, text);
        moves.push({ old: oldP, new: newP });
      } else {
        tree.now.set(oldP, text);
      }
    };
  });
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC section 7)                              */
/* ------------------------------------------------------------------ */

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SrBlock[] = [];
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let pathIdx = -1;
    for (let j = searchIdx - 1; j >= prevEnd; j--) {
      const t = lines[j]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      pathIdx = j;
      break;
    }
    let path: string;
    if (pathIdx < 0) {
      if (blocks.length === 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = blocks[blocks.length - 1]!.path;
    } else {
      path = lines[pathIdx]!.trim();
    }
    let eqIdx = -1;
    let repIdx = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eqIdx = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eqIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    for (let j = eqIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        repIdx = j;
        break;
      }
    }
    if (repIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, oldLines: lines.slice(searchIdx + 1, eqIdx), newLines: lines.slice(eqIdx + 1, repIdx) });
    prevEnd = repIdx + 1;
    i = repIdx + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => {
    return (tree: Tree) => {
      if (!safe(b.path)) throw new Fail('unsafe', b.path);
      if (b.oldLines.length === 0) {
        if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
        tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(b.path);
      if (before === null) throw new Fail('missing', b.path);
      const parts = splitFile(before);
      const occ = occurrences(parts.lines, b.oldLines, 0, strict);
      if (occ === null) throw new Fail('no-match', b.path);
      if (occ.positions.length > 1) throw new Fail('ambiguous', b.path);
      const n: NLine[] = b.newLines.map((text) => ({ text, ctx: false, oIdx: -1 }));
      applyAt(parts, occ.positions[0]!, b.oldLines, n, occ.tier);
      tree.now.set(b.path, joinFile(parts));
    };
  });
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC section 8)                                        */
/* ------------------------------------------------------------------ */

interface VChunk {
  anchor: string | null;
  o: string[];
  n: NLine[];
  eof: boolean;
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lines: string[];
  moveTo: string | null;
  chunks: VChunk[];
}

function v4aEdits(lines: string[], strict: boolean, moves: { old: string; new: string }[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const l = lines[i]!;
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (l.startsWith('*** Add File:')) {
      kind = 'add';
      path = l.slice('*** Add File:'.length).trim();
    } else if (l.startsWith('*** Delete File:')) {
      kind = 'delete';
      path = l.slice('*** Delete File:'.length).trim();
    } else if (l.startsWith('*** Update File:')) {
      kind = 'update';
      path = l.slice('*** Update File:'.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const startLine = i + 1;
    i++;
    const raw: { text: string; idx: number }[] = [];
    while (i < last) {
      const t = lines[i]!;
      if (t.startsWith('*** Add File:') || t.startsWith('*** Delete File:') || t.startsWith('*** Update File:')) break;
      raw.push({ text: t, idx: i });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();

    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text === '') fileLines.push('');
        else if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.idx + 1}`);
      }
      sections.push({ kind, path, lines: fileLines, moveTo: null, chunks: [] });
    } else if (kind === 'delete') {
      for (const r of raw) {
        if (!blank(r.text)) throw new Exit2(`error: parse ${r.idx + 1}`);
      }
      sections.push({ kind, path, lines: [], moveTo: null, chunks: [] });
    } else {
      let moveTo: string | null = null;
      let pos = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to:')) {
        moveTo = raw[0]!.text.slice('*** Move to:'.length).trim();
        pos = 1;
      }
      const chunks: VChunk[] = [];
      let cur: { anchor: string | null; body: string[]; eof: boolean } | null = null;
      const closeBody = (c: { anchor: string | null; body: string[]; eof: boolean }): VChunk => {
        const built = buildHunk(c.body);
        return { anchor: c.anchor, o: built.o, n: built.n, eof: c.eof };
      };
      for (; pos < raw.length; pos++) {
        const r = raw[pos]!;
        const t = r.text;
        if (t.startsWith('@@')) {
          if (cur !== null) chunks.push(closeBody(cur));
          const anchor = t.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          continue;
        }
        if (t.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${r.idx + 1}`);
          cur.eof = true;
          chunks.push(closeBody(cur));
          cur = null;
          continue;
        }
        if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          // Only the first chunk may start at a body line; later chunks
          // start at an @@ line, and one ended by *** End of File is done.
          if (cur === null && chunks.length > 0) throw new Exit2(`error: parse ${r.idx + 1}`);
          if (cur === null) cur = { anchor: null, body: [], eof: false };
          cur.body.push(t);
          continue;
        }
        throw new Exit2(`error: parse ${r.idx + 1}`);
      }
      if (cur !== null) chunks.push(closeBody(cur));
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine}`);
      sections.push({ kind, path, lines: [], moveTo, chunks });
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');

  return sections.map((sec) => {
    return (tree: Tree) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (sec.kind === 'add') {
        if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
        tree.now.set(sec.path, sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n');
        return;
      }
      if (sec.kind === 'delete') {
        if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
        tree.now.set(sec.path, null);
        return;
      }
      if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
      const before = tree.get(sec.path);
      if (before === null) throw new Fail('missing', sec.path);
      if (sec.moveTo !== null) {
        if (tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
      }
      const parts = splitFile(before);
      let cursor = 0;
      for (const chunk of sec.chunks) {
        if (chunk.anchor !== null) {
          const found = singleOccurrence(parts.lines, chunk.anchor, cursor, strict);
          if (found === null) throw new Fail('no-match', sec.path);
          cursor = found.pos + 1;
        }
        if (chunk.o.length === 0) {
          const at = chunk.eof ? parts.lines.length : cursor;
          const seg = chunk.n.map((nl) => nl.text);
          parts.lines.splice(at, 0, ...seg);
          cursor = at + seg.length;
          continue;
        }
        const occ = occurrences(parts.lines, chunk.o, cursor, strict);
        if (occ === null) throw new Fail('no-match', sec.path);
        let candidates = occ.positions;
        if (chunk.eof) candidates = candidates.filter((pos) => pos + chunk.o.length === parts.lines.length);
        if (candidates.length === 0) throw new Fail('no-match', sec.path);
        const at = candidates[0]!;
        applyAt(parts, at, chunk.o, chunk.n, occ.tier);
        cursor = at + chunk.n.length;
      }
      const text = joinFile(parts);
      if (sec.moveTo !== null) {
        tree.now.set(sec.path, null);
        tree.now.set(sec.moveTo, text);
        moves.push({ old: sec.path, new: sec.moveTo });
      } else {
        tree.now.set(sec.path, text);
      }
    };
  });
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: { old: string; new: string }[] = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict, moves);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows: A / D / M, with a qualifying move as one R line sorted by its new path.
  const handled = new Set<string>();
  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  for (const m of moves) {
    if (tree.original(m.old) !== null && tree.now.get(m.old) === null && tree.original(m.new) === null && tree.now.get(m.new) !== null) {
      rows.push({ key: m.new, text: `R ${m.old} -> ${m.new}` });
      handled.add(m.old);
      handled.add(m.new);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (handled.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  // Moves write their files too: the loop above skipped handled paths, so write them here.
  if (!check) {
    for (const p of handled) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}

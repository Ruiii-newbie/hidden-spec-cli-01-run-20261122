// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// What it does, section by section of SPEC.md:
//   1. the command line (options in any order, `--` ends them, usage errors);
//   2. the output and exit codes (2 usage/no-patch/format/parse, 1 failed edits, 0 applied);
//   3. files, lines and paths (safe paths, each file's own line break, final break kept);
//   4. format detection (v4a, json, search-replace, unified, in that order);
//   5. matching lines at three tiers (exact, trailing whitespace, both sides trimmed),
//      with context lines written as the file's own and tier-2 re-indentation;
//   6. unified diffs (sections, headers, hunks, nearest occurrence, no-newline marks);
//   7. SEARCH/REPLACE blocks (path from the line above, exactly one occurrence);
//   8. V4A patches (add/delete/update sections, anchors, cursor, end-of-file chunks);
//   9. JSON edits (create, str_replace, insert, array or JSON Lines);
//  10. order and atomicity (edits in patch order, a failed edit changes nothing,
//      when any edit failed no file is written, `--check` writes none).
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this
// file hands over to runner.ts (the last lines below): keep that hand-over and runner.ts
// as they are, and write the CLI.

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

/** One file's lines, its own line break and whether it ends with one (SPEC.md section 3). */
interface FileModel {
  lines: string[];
  br: string;
  ends: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const ends = text.endsWith(br);
  if (ends) parts.pop();
  return { lines: parts, br, ends };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.ends ? m.br : '');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** Line equality at one matching tier (SPEC.md section 5). */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** Every 0-based position where O occurs in the file's lines at one tier. */
function occurrences(fileLines: string[], oldLines: string[], tier: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + oldLines.length <= fileLines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < oldLines.length; k += 1) {
      if (!lineEq(fileLines[i + k]!, oldLines[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with its occurrences. */
function findTier(
  fileLines: string[],
  oldLines: string[],
  strict: boolean,
): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(fileLines, oldLines, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/**
 * The new lines of a replacement, with tier-2 re-indentation (SPEC.md section 5):
 * F is the leading spaces and tabs of the file's first matched line, P those of
 * O's first line; a line of N that is not empty and not only whitespace and starts
 * with P has that P replaced by F; any other line is written as it is.
 */
function mapNewLines(fileLines: string[], pos: number, oldLines: string[], newLines: string[], tier: number): string[] {
  if (tier !== 2 || oldLines.length === 0) return [...newLines];
  const f = leadingWs(fileLines[pos] ?? '');
  const p = leadingWs(oldLines[0]!);
  return newLines.map((t) => {
    if (t === '' || t.trim() === '') return t;
    return t.startsWith(p) ? f + t.slice(p.length) : t;
  });
}

/** One body line of a unified hunk or a V4A chunk. */
interface BodyItem {
  kind: ' ' | '-' | '+';
  text: string;
  /** A `\` line follows this item (unified diffs only). */
  noEol: boolean;
}

/** The old lines O and new lines N a body names, in body order. */
function bodyOldNew(items: BodyItem[]): { oldLines: string[]; newItems: BodyItem[] } {
  const oldLines: string[] = [];
  const newItems: BodyItem[] = [];
  for (const it of items) {
    if (it.kind === '-') oldLines.push(it.text);
    else if (it.kind === ' ') {
      oldLines.push(it.text);
      newItems.push(it);
    } else newItems.push(it);
  }
  return { oldLines, newItems };
}

/**
 * The lines a body writes over the file's matched lines: a context line is written
 * as the file's own matched line, never the patch's; every other line of N is
 * re-indented at tier 2 (SPEC.md section 5).
 */
function buildNewLines(fileLines: string[], pos: number, items: BodyItem[], tier: number): string[] {
  const { oldLines } = bodyOldNew(items);
  const out: string[] = [];
  let oIdx = 0;
  for (const it of items) {
    if (it.kind === '-') {
      oIdx += 1;
      continue;
    }
    if (it.kind === ' ') {
      out.push(fileLines[pos + oIdx]!);
      oIdx += 1;
      continue;
    }
    const mapped = mapNewLines(fileLines, pos, oldLines, [it.text], tier);
    out.push(mapped[0]!);
  }
  return out;
}

/** The `\` line follows the hunk's last context or `+` line (SPEC.md section 6). */
function lastNewNoEol(items: BodyItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i]!;
    if (it.kind === ' ' || it.kind === '+') return it.noEol;
  }
  return false;
}

/**
 * Apply one hunk or chunk body to a file model, at a known occurrence position.
 * Returns the replacement lines; the caller splices them in.
 */
function applyBodyAt(model: FileModel, pos: number, items: BodyItem[], tier: number): string[] {
  return buildNewLines(model.lines, pos, items, tier);
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Where a moved file came from: new path -> path it had before the patch. */
  readonly moves = new Map<string, string>();
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
  /** Record a move, chaining through an earlier move of the same file. */
  recordMove(from: string, to: string): void {
    const origin = this.moves.has(from) ? this.moves.get(from)! : from;
    this.moves.delete(from);
    this.moves.set(to, origin);
  }
  /** A path that is created fresh or deleted outright is no longer a move target. */
  forgetMove(p: string): void {
    this.moves.delete(p);
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
      tree.forgetMove(p);
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
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface Hunk {
  /** The hunk header's old start line, A (1-based). */
  a: number;
  items: BodyItem[];
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` or `+++ `: text after the four characters, up to the first tab, trimmed. */
function diffPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab >= 0 ? rest.slice(0, tab) : rest).trim();
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)\s*$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function isDiffGitLine(l: string): boolean {
  return l === 'diff --git' || l.startsWith('diff --git ');
}

/**
 * Read one hunk body: the lines after the header that start with ` `, `-`, `+`
 * or `\`, or are empty. The body ends at the first other line, at a `diff --git `
 * line, at a `--- ` line followed by a `+++ ` line, or at the end of the patch;
 * empty lines at the end of a body are not part of it.
 */
function readHunkBody(lines: string[], start: number): { items: BodyItem[]; next: number } {
  const items: BodyItem[] = [];
  let j = start;
  while (j < lines.length) {
    const l = lines[j]!;
    // The body ends at a `--- ` line followed by a `+++ ` line: that pair
    // starts a new section, so it is not an old line of this hunk.
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      items.push({ kind: ' ', text: '', noEol: false });
      j += 1;
      continue;
    }
    const c = l[0]!;
    if (c === ' ' || c === '-' || c === '+') {
      items.push({ kind: c, text: l.slice(1), noEol: false });
      j += 1;
      continue;
    }
    if (c === '\\') {
      // A `\` line refers to the body line before it.
      if (items.length > 0) items[items.length - 1]!.noEol = true;
      j += 1;
      continue;
    }
    break;
  }
  // Empty lines at the end of a body are not part of it; a `\` that followed one
  // still marks the hunk's last context or `+` line.
  let strippedNoEol = false;
  while (items.length > 0) {
    const last = items[items.length - 1]!;
    if (last.kind !== ' ' || last.text.trim() !== '') break;
    if (last.noEol) strippedNoEol = true;
    items.pop();
  }
  if (strippedNoEol) {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const it = items[i]!;
      if (it.kind === ' ' || it.kind === '+') {
        it.noEol = true;
        break;
      }
    }
  }
  return { items, next: j };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let i = 0;
  let cur: {
    diffOld: string | null;
    diffNew: string | null;
    pairOld: string | null;
    pairNew: string | null;
    renameFrom: string | null;
    renameTo: string | null;
    isCreate: boolean;
    isDelete: boolean;
    inHeader: boolean;
    hunks: Hunk[];
  } | null = null;

  const finish = (): void => {
    if (cur === null) return;
    let oldPath: string | null;
    let newPath: string | null;
    if (cur.pairOld !== null) {
      oldPath = cur.pairOld === '/dev/null' ? null : stripAB(cur.pairOld);
      newPath = cur.pairNew === '/dev/null' ? null : stripAB(cur.pairNew!);
    } else {
      oldPath = cur.renameFrom ?? cur.diffOld;
      newPath = cur.renameTo ?? cur.diffNew;
    }
    sections.push({ oldPath, newPath, isCreate: cur.isCreate, isDelete: cur.isDelete, hunks: cur.hunks });
    cur = null;
  };

  while (i < lines.length) {
    const l = lines[i]!;
    if (isDiffGitLine(l)) {
      const m = DIFF_GIT_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      finish();
      cur = {
        diffOld: m[1]!,
        diffNew: m[2]!,
        pairOld: null,
        pairNew: null,
        renameFrom: null,
        renameTo: null,
        isCreate: false,
        isDelete: false,
        inHeader: true,
        hunks: [],
      };
      i += 1;
      continue;
    }
    if (cur !== null && cur.inHeader) {
      if (l.startsWith('@@')) {
        const m = HUNK_RE.exec(l);
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        cur.inHeader = false;
        const body = readHunkBody(lines, i + 1);
        cur.hunks.push({ a: Number(m[1]), items: body.items });
        i = body.next;
        continue;
      }
      if (l.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (cur.pairOld === null) {
            cur.pairOld = diffPath(l);
            cur.pairNew = diffPath(lines[i + 1]!);
          } else {
            // A second pair before any hunk starts a new section.
            finish();
            cur = {
              diffOld: null,
              diffNew: null,
              pairOld: diffPath(l),
              pairNew: diffPath(lines[i + 1]!),
              renameFrom: null,
              renameTo: null,
              isCreate: false,
              isDelete: false,
              inHeader: true,
              hunks: [],
            };
          }
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (l.startsWith('rename from ')) cur.renameFrom = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.renameTo = l.slice('rename to '.length).trim();
      else if (l === 'new file mode' || l.startsWith('new file mode ')) cur.isCreate = true;
      else if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) cur.isDelete = true;
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      finish();
      cur = {
        diffOld: null,
        diffNew: null,
        pairOld: diffPath(l),
        pairNew: diffPath(lines[i + 1]!),
        renameFrom: null,
        renameTo: null,
        isCreate: false,
        isDelete: false,
        inHeader: true,
        hunks: [],
      };
      i += 2;
      continue;
    }
    if (cur === null) {
      // Outside a section: a hunk line is a parse error, anything else is prose.
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    // After a section's first hunk: a `@@` line starts its next hunk.
    if (l.startsWith('@@')) {
      const m = HUNK_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const body = readHunkBody(lines, i + 1);
      cur.hunks.push({ a: Number(m[1]), items: body.items });
      i = body.next;
      continue;
    }
    i += 1;
  }
  finish();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => unifiedEdit(sec, strict));
}

function unifiedEdit(sec: UniSection, strict: boolean): Edit {
  return (tree) => {
    // A section naming no file at all changes nothing.
    if (sec.oldPath === null && sec.newPath === null) return;
    if (sec.oldPath !== null && !safe(sec.oldPath)) throw new Fail('unsafe', sec.oldPath);
    if (sec.newPath !== null && !safe(sec.newPath)) throw new Fail('unsafe', sec.newPath);
    if (sec.isCreate || sec.oldPath === null) {
      const np = sec.newPath!;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const outLines: string[] = [];
      let lastPlus: BodyItem | null = null;
      for (const h of sec.hunks) {
        for (const it of h.items) {
          if (it.kind === '+') {
            outLines.push(it.text);
            lastPlus = it;
          }
        }
      }
      const text = outLines.length === 0 ? '' : outLines.join('\n') + (lastPlus !== null && lastPlus.noEol ? '' : '\n');
      tree.forgetMove(np);
      tree.now.set(np, text);
      return;
    }
    if (sec.isDelete || sec.newPath === null) {
      const op = sec.oldPath!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.forgetMove(op);
      tree.now.set(op, null);
      return;
    }
    const op = sec.oldPath!;
    const np = sec.newPath!;
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    if (op === np) {
      const model = splitFile(before);
      applyUniHunks(model, sec.hunks, strict, op);
      tree.now.set(op, joinFile(model));
      return;
    }
    // A move: the old path exists, the new path does not; hunks apply to the
    // old file's lines and the result is written at the new path.
    if (tree.get(np) !== null) throw new Fail('exists', np);
    const model = splitFile(before);
    applyUniHunks(model, sec.hunks, strict, op);
    tree.recordMove(op, np);
    tree.now.set(np, joinFile(model));
    tree.now.set(op, null);
  };
}

/** Apply a section's hunks in order, each to the result of the ones before it. */
function applyUniHunks(model: FileModel, hunks: Hunk[], strict: boolean, failPath: string): void {
  let d = 0;
  for (const h of hunks) {
    const { oldLines, newItems } = bodyOldNew(h.items);
    if (oldLines.length === 0) {
      const at = Math.min(Math.max(h.a + d, 0), model.lines.length);
      const atEnd = at === model.lines.length;
      const added = newItems.map((it) => it.text);
      model.lines.splice(at, 0, ...added);
      if (atEnd) model.ends = !lastNewNoEol(h.items);
      d += added.length;
      continue;
    }
    const found = findTier(model.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', failPath);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    let bestDist = Math.abs(best - target);
    for (const pos of found.occ) {
      const dist = Math.abs(pos - target);
      if (dist < bestDist) {
        best = pos;
        bestDist = dist;
      }
    }
    const touchesEnd = best + oldLines.length === model.lines.length;
    const replacement = applyBodyAt(model, best, h.items, found.tier);
    model.lines.splice(best, oldLines.length, ...replacement);
    if (touchesEnd) model.ends = !lastNewNoEol(h.items);
    d += replacement.length - oldLines.length;
  }
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    oldLines: string[];
    newLines: string[];
  }
  const blocks: Block[] = [];
  let i = 0;
  let prevEnd = 0;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j -= 1) {
      const t = lines[j]!;
      if (t.trim() === '') continue;
      if (t.trimStart().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    let eq = -1;
    let rep = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (eq === -1 && lines[j]!.trimEnd() === '=======') {
        eq = j;
        continue;
      }
      if (eq !== -1 && lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (eq === -1 || rep === -1) throw new Exit2(`error: parse ${searchLine}`);
    blocks.push({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => searchReplaceEdit(b, strict));
}

function searchReplaceEdit(
  b: { path: string; oldLines: string[]; newLines: string[] },
  strict: boolean,
): Edit {
  return (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.forgetMove(b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(b.path);
    if (cur === null) throw new Fail('missing', b.path);
    const model = splitFile(cur);
    const found = findTier(model.lines, b.oldLines, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.occ[0]!;
    const replacement = mapNewLines(model.lines, pos, b.oldLines, b.newLines, found.tier);
    model.lines.splice(pos, b.oldLines.length, ...replacement);
    tree.now.set(b.path, joinFile(model));
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  /** Null or empty: no anchor. */
  anchor: string | null;
  /** Anchored to the end of the file by `*** End of File`. */
  eof: boolean;
  items: BodyItem[];
}

function isV4aSectionHeader(l: string): boolean {
  return l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (l.startsWith('*** Add File:')) {
      const path = l.slice('*** Add File:'.length).trim();
      const raw: string[] = [];
      let j = i + 1;
      while (j < last && !isV4aSectionHeader(lines[j]!)) {
        raw.push(lines[j]!);
        j += 1;
      }
      // Blank lines at the end of a section are not part of it: drop trailing
      // blank patch lines before reading the section's lines.
      while (raw.length > 0 && raw[raw.length - 1]!.trim() === '') raw.pop();
      const content: string[] = [];
      for (let k = 0; k < raw.length; k += 1) {
        const t = raw[k]!;
        if (t === '') content.push('');
        else if (t.startsWith('+')) content.push(t.slice(1));
        else throw new Exit2(`error: parse ${i + 1 + k + 1}`);
      }
      edits.push(v4aAddEdit(path, content));
      i = j;
      continue;
    }
    if (l.startsWith('*** Delete File:')) {
      const path = l.slice('*** Delete File:'.length).trim();
      let j = i + 1;
      while (j < last && !isV4aSectionHeader(lines[j]!)) {
        if (!blank(lines[j]!)) throw new Exit2(`error: parse ${j + 1}`);
        j += 1;
      }
      edits.push(v4aDeleteEdit(path));
      i = j;
      continue;
    }
    if (l.startsWith('*** Update File:')) {
      const path = l.slice('*** Update File:'.length).trim();
      let j = i + 1;
      let moveTo: string | null = null;
      if (j < last && lines[j]!.startsWith('*** Move to:')) {
        moveTo = lines[j]!.slice('*** Move to:'.length).trim();
        j += 1;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      let firstChunk = true;
      while (j < last && !isV4aSectionHeader(lines[j]!)) {
        const t = lines[j]!;
        if (t.trimEnd() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${j + 1}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          firstChunk = false;
          j += 1;
          continue;
        }
        if (t.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          cur = { anchor: t.slice(2).trim(), eof: false, items: [] };
          firstChunk = false;
          j += 1;
          continue;
        }
        if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          if (cur === null) {
            if (!firstChunk) {
              // A blank line after a chunk ended is between sections and is
              // ignored; any other body line here needs a new `@@` chunk.
              if (t.trim() === '') {
                j += 1;
                continue;
              }
              throw new Exit2(`error: parse ${j + 1}`);
            }
            cur = { anchor: null, eof: false, items: [] };
            firstChunk = false;
          }
          cur.items.push({ kind: t === '' ? ' ' : (t[0] as ' ' | '-' | '+'), text: t === '' ? '' : t.slice(1), noEol: false });
          j += 1;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      if (cur !== null) chunks.push(cur);
      // Blank lines at the end of a section are not part of it: drop trailing
      // blank body lines of the section's last chunk.
      if (chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1]!;
        while (lastChunk.items.length > 0) {
          const tail = lastChunk.items[lastChunk.items.length - 1]!;
          if (tail.kind !== ' ' || tail.text.trim() !== '') break;
          lastChunk.items.pop();
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function v4aAddEdit(path: string, content: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.forgetMove(path);
    tree.now.set(path, content.length === 0 ? '' : content.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.forgetMove(path);
    tree.now.set(path, null);
  };
}

/** The first line at or after the cursor equal to the anchor, at the first tier with one. */
function findAnchor(lines: string[], cursor: number, anchor: string, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let k = cursor; k < lines.length; k += 1) {
      if (lineEq(lines[k]!, anchor, t)) return k;
    }
  }
  return -1;
}

/** The first occurrence of O at or after the cursor, at the first tier with one. */
function findFrom(
  lines: string[],
  oldLines: string[],
  cursor: number,
  strict: boolean,
  eof: boolean,
): { pos: number; tier: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, oldLines, t).filter((p) => p >= cursor && (!eof || p + oldLines.length === lines.length));
    if (occ.length > 0) return { pos: occ[0]!, tier: t };
  }
  return null;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const model = splitFile(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const at = findAnchor(model.lines, cursor, ch.anchor, strict);
        if (at === -1) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const { oldLines } = bodyOldNew(ch.items);
      if (oldLines.length === 0) {
        const at = ch.eof ? model.lines.length : cursor;
        const added = ch.items.filter((it) => it.kind === '+').map((it) => it.text);
        model.lines.splice(at, 0, ...added);
        cursor = at + added.length;
        continue;
      }
      const found = findFrom(model.lines, oldLines, cursor, strict, ch.eof);
      if (found === null) throw new Fail('no-match', path);
      const replacement = applyBodyAt(model, found.pos, ch.items, found.tier);
      model.lines.splice(found.pos, oldLines.length, ...replacement);
      cursor = found.pos + replacement.length;
    }
    const out = joinFile(model);
    if (moveTo !== null) {
      tree.recordMove(path, moveTo);
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
    } else {
      tree.now.set(path, out);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Running (SPEC.md sections 1, 2 and 10)                              */
/* ------------------------------------------------------------------ */

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
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = new Map(tree.moves);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves.clear();
      for (const [k, v] of beforeMoves) tree.moves.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // One line for each path whose state changed, in byte order of the paths
  // (UTF-8); a move's line sorts by its new path and replaces that pair's
  // `D` and `A` lines.
  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  const handled = new Set<string>();
  for (const [np, op] of tree.moves) {
    if (tree.original(op) !== null && tree.original(np) === null && tree.get(np) !== null && tree.get(op) === null) {
      rows.push({ key: np, text: `R ${op} -> ${np}` });
      handled.add(op);
      handled.add(np);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (handled.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out };
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

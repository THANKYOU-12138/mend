// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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
  readonly moves: [string, string][] = [];
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

/** A file as lines (SPEC.md section 3): its own break, its lines, whether it ends with a break. */
interface FileState {
  br: string;
  lines: string[];
  ends: boolean;
}
function splitFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const ends = text.endsWith(br);
  if (ends) lines.pop();
  return { br, lines, ends };
}
function joinFile(st: FileState): string {
  return st.lines.length === 0 ? '' : st.lines.join(st.br) + (st.ends ? st.br : '');
}

const lead = (s: string): string => /^[ \t]*/.exec(s)![0]!;
const trailWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => trailWs(s.replace(/^[ \t]+/, ''));

/** Matching lines (SPEC.md section 5): tiers 0 exact, 1 trailing-ws, 2 full trim. */
function lineEq(a: string, b: string, tier: number): boolean {
  return tier === 0 ? a === b : tier === 1 ? trailWs(a) === trailWs(b) : trimWs(a) === trimWs(b);
}
function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, from); i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}
interface Match {
  tier: number;
  at: number[];
}
function findTier(lines: string[], o: string[], strict: boolean, from = 0): Match | null {
  for (const t of strict ? [0] : [0, 1, 2]) {
    const at = occurrences(lines, o, t, from);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/** One body line of a unified hunk or a V4A chunk; `empty` marks a literally empty line. */
interface BodyLine {
  kind: string;
  text: string;
  empty?: boolean;
}
/** One line of N: a context line (carried at `oi` in O) or a new line. */
interface NLine {
  text: string;
  context: boolean;
  oi: number;
  noEol: boolean;
}
function buildON(body: BodyLine[]): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  body.forEach((b, idx) => {
    const noEol = body[idx + 1]?.kind === '\\';
    if (b.kind === ' ') {
      n.push({ text: b.text, context: true, oi: o.length, noEol });
      o.push(b.text);
    } else if (b.kind === '-') o.push(b.text);
    else if (b.kind === '+') n.push({ text: b.text, context: false, oi: -1, noEol });
  });
  return { o, n };
}
/** Render N against a match at `pos`: context lines are the file's own; at tier 2 other lines are re-indented. */
function renderLines(n: NLine[], o: string[], fileLines: string[], pos: number, tier: number): string[] {
  const f = lead(fileLines[pos] ?? '');
  const p = lead(o[0] ?? '');
  return n.map((e) => {
    if (e.context) return fileLines[pos + e.oi]!;
    if (tier === 2 && e.text.trim() !== '' && e.text.startsWith(p)) return f + e.text.slice(p.length);
    return e.text;
  });
}

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

/** Unified diffs (SPEC.md section 6). */
interface Hunk {
  a: number;
  body: BodyLine[];
}
interface Section {
  gitOld?: string;
  gitNew?: string;
  pairOld?: string;
  pairNew?: string;
  renameFrom?: string;
  renameTo?: string;
  create?: boolean;
  del?: boolean;
  viaDiff?: boolean;
  hunks: Hunk[];
}
function headerPath(line: string): string {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}
/** Apply a section's hunks to a file's text; `path` is the file hunks fail against. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const st = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const { o, n } = buildON(h.body);
    if (o.length === 0) {
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > st.lines.length) pos = st.lines.length;
      const atEnd = pos === st.lines.length;
      const ins = n.map((e) => e.text);
      st.lines.splice(pos, 0, ...ins);
      if (atEnd && ins.length > 0) st.ends = !n[n.length - 1]!.noEol;
      d += ins.length;
    } else {
      const m = findTier(st.lines, o, strict);
      if (m === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let pos = m.at[0]!;
      for (const cand of m.at) if (Math.abs(cand - target) < Math.abs(pos - target)) pos = cand;
      const rendered = renderLines(n, o, st.lines, pos, m.tier);
      const atEnd = pos + o.length === st.lines.length;
      st.lines.splice(pos, o.length, ...rendered);
      if (atEnd) st.ends = rendered.length > 0 ? !n[n.length - 1]!.noEol : st.lines.length > 0;
      d += rendered.length - o.length;
    }
  }
  return joinFile(st);
}
function sectionEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.pairOld ?? sec.renameFrom ?? sec.gitOld;
    const newP = sec.pairNew ?? sec.renameTo ?? sec.gitNew;
    const isCreate = sec.pairOld === '/dev/null' || sec.create === true;
    const isDelete = sec.pairNew === '/dev/null' || sec.del === true;
    if (isCreate) {
      const p = newP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const created: string[] = [];
      let lastNoEol = false;
      for (const h of sec.hunks) {
        h.body.forEach((b, idx) => {
          if (b.kind === '+') {
            created.push(b.text);
            lastNoEol = h.body[idx + 1]?.kind === '\\';
          }
        });
      }
      tree.now.set(p, created.length === 0 ? '' : created.join('\n') + (lastNoEol ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const o = oldP!;
    const nw = newP!;
    if (!safe(o)) throw new Fail('unsafe', o);
    if (nw !== o && !safe(nw)) throw new Fail('unsafe', nw);
    const before = tree.get(o);
    if (before === null) throw new Fail('missing', o);
    if (nw !== o && tree.get(nw) !== null) throw new Fail('exists', nw);
    const result = applyHunks(before, sec.hunks, strict, o);
    if (nw !== o) {
      tree.now.set(nw, result);
      tree.now.set(o, null);
      tree.moves.push([o, nw]);
    } else tree.now.set(o, result);
  };
}
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  let hunk: Hunk | null = null;
  const endHunk = (): void => {
    if (hunk !== null && sec !== null) {
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.kind === ' ' && hunk.body[hunk.body.length - 1]!.empty === true) hunk.body.pop();
      sec.hunks.push(hunk);
    }
    hunk = null;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const isDiff = line.startsWith('diff --git ');
    const isPair = line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
    if (hunk !== null) {
      if (!isDiff && !isPair && (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\'))) {
        hunk.body.push({ kind: line === '' ? ' ' : line[0]!, text: line === '' ? '' : line.slice(1), empty: line === '' });
        i += 1;
        continue;
      }
      endHunk();
    }
    if (isDiff) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = { gitOld: m[1]!, gitNew: m[2]!, viaDiff: true, hunks: [] };
      sections.push(sec);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { a: parseInt(m[1]!, 10), body: [] };
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (isPair) {
        if (sec !== null && sec.hunks.length === 0 && sec.pairOld === undefined) {
          sec.pairOld = headerPath(line);
          sec.pairNew = headerPath(lines[i + 1]!);
        } else {
          sec = { pairOld: headerPath(line), pairNew: headerPath(lines[i + 1]!), hunks: [] };
          sections.push(sec);
        }
        i += 2;
        continue;
      }
      if (sec !== null && sec.viaDiff === true && sec.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (sec !== null && sec.hunks.length === 0) {
      if (line.startsWith('rename from ')) sec.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) sec.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) sec.create = true;
      else if (line.startsWith('deleted file mode')) sec.del = true;
    }
    i += 1;
  }
  endHunk();
  return sections.map((s) => sectionEdit(s, strict));
}

/** SEARCH/REPLACE blocks (SPEC.md section 7). */
function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const st = splitFile(before);
    const m = findTier(st.lines, oldLines, strict);
    if (m === null) throw new Fail('no-match', path);
    if (m.at.length > 1) throw new Fail('ambiguous', path);
    const pos = m.at[0]!;
    const n: NLine[] = newLines.map((text) => ({ text, context: false, oi: -1, noEol: false }));
    const rendered = renderLines(n, oldLines, st.lines, pos, m.tier);
    st.lines.splice(pos, oldLines.length, ...rendered);
    tree.now.set(path, joinFile(st));
  };
}
function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  for (;;) {
    let s = -1;
    for (let j = prevEnd + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s < 0) break;
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j -= 1) {
      const t = lines[j]!;
      if (t.trim() === '' || t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    let eq = -1;
    let rep = -1;
    for (let j = s + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    edits.push(srEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep;
  }
  return edits;
}

/** V4A patches (SPEC.md section 8). */
interface Chunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}
interface VSection {
  kind: string;
  path: string;
  addLines?: string[];
  moveTo?: string;
  chunks?: Chunk[];
}
function v4aEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      const ls = sec.addLines!;
      tree.now.set(sec.path, ls.length === 0 ? '' : `${ls.join('\n')}\n`);
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    if (sec.moveTo !== undefined && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== undefined && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const st = splitFile(before);
    let cursor = 0;
    for (const chunk of sec.chunks!) {
      if (chunk.anchor !== null) {
        let found = -1;
        for (const t of strict ? [0] : [0, 1, 2]) {
          const occ = occurrences(st.lines, [chunk.anchor], t, cursor);
          if (occ.length > 0) {
            found = occ[0]!;
            break;
          }
        }
        if (found < 0) throw new Fail('no-match', sec.path);
        cursor = found + 1;
      }
      const { o, n } = buildON(chunk.body);
      if (o.length === 0) {
        const pos = chunk.eof ? st.lines.length : cursor;
        const ins = n.map((e) => e.text);
        st.lines.splice(pos, 0, ...ins);
        cursor = pos + ins.length;
      } else {
        const m = findTier(st.lines, o, strict, cursor);
        if (m === null) throw new Fail('no-match', sec.path);
        let pos = m.at[0]!;
        if (chunk.eof) {
          const cand = m.at.filter((p) => p + o.length === st.lines.length);
          if (cand.length === 0) throw new Fail('no-match', sec.path);
          pos = cand[0]!;
        }
        const rendered = renderLines(n, o, st.lines, pos, m.tier);
        st.lines.splice(pos, o.length, ...rendered);
        cursor = pos + rendered.length;
      }
    }
    const out = joinFile(st);
    if (sec.moveTo !== undefined) {
      tree.now.set(sec.moveTo, out);
      tree.now.set(sec.path, null);
      tree.moves.push([sec.path, sec.moveTo]);
    } else tree.now.set(sec.path, out);
  };
}
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j -= 1) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const secStart = (l: string): string | null =>
    l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'delete' : l.startsWith('*** Update File: ') ? 'update' : null;
  const secs: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const kind = secStart(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = line.slice(line.indexOf(': ') + 2).trim();
    const secLine = i + 1;
    i += 1;
    // The section's raw lines, up to the next section; blank lines at its end are not part of it.
    const raw: { l: string; num: number }[] = [];
    while (i < last && secStart(lines[i]!) === null) {
      raw.push({ l: lines[i]!, num: i + 1 });
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.l)) raw.pop();
    if (kind === 'add') {
      const content: string[] = [];
      for (const r of raw) {
        if (r.l.startsWith('+')) content.push(r.l.slice(1));
        else if (r.l === '') content.push('');
        else throw new Exit2(`error: parse ${r.num}`);
      }
      secs.push({ kind, path, addLines: content });
    } else if (kind === 'delete') {
      for (const r of raw) if (!blank(r.l)) throw new Exit2(`error: parse ${r.num}`);
      secs.push({ kind, path });
    } else {
      let moveTo: string | undefined;
      const chunks: Chunk[] = [];
      let chunk: Chunk | null = null;
      let firstLine = true;
      for (const r of raw) {
        const l = r.l;
        if (firstLine && l.startsWith('*** Move to: ')) {
          moveTo = l.slice('*** Move to: '.length).trim();
          firstLine = false;
          continue;
        }
        firstLine = false;
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          chunk = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          chunks.push(chunk);
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (chunk === null) {
            chunk = { anchor: null, eof: true, body: [] };
            chunks.push(chunk);
          }
          chunk.eof = true;
          chunk = null;
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (chunk === null) {
            chunk = { anchor: null, eof: false, body: [] };
            chunks.push(chunk);
          }
          chunk.body.push({ kind: l === '' ? ' ' : l[0]!, text: l === '' ? '' : l.slice(1), empty: l === '' });
          continue;
        }
        throw new Exit2(`error: parse ${r.num}`);
      }
      if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${secLine}`);
      secs.push({ kind, path, moveTo, chunks });
    }
  }
  return secs.map((s) => v4aEdit(s, strict));
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
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? srEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const movePairs = tree.moves.filter(
    ([o, n]) => tree.now.has(o) && tree.now.has(n) && tree.original(o) !== null && tree.now.get(o) === null && tree.original(n) === null && tree.now.get(n) !== null,
  );
  const inMove = new Set<string>();
  for (const [o, n] of movePairs) {
    inMove.add(o);
    inMove.add(n);
  }
  const rows: { key: string; text: string }[] = [];
  for (const [o, n] of movePairs) rows.push({ key: n, text: `R ${o} -> ${n}` });
  for (const p of tree.now.keys()) {
    if (inMove.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
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

# mend — build notes

Competition: hidden-spec-cli-01-run-20261122 ("Build mend, one patch tool for every AI edit format")
Built from the kit starter in this directory; `runner.ts` and main.ts's hand-over to it are byte-for-byte
the kit's. Node standard library only.

## Scores

- Practice (starter's `check.ts` against `program/generator/practice.json`): **100 of 100, score 1000**
  - unified 30/30, search_replace 20/20, v4a 20/20, json 15/15, cli 15/15
  - (The unmodified starter scored 24/100.)
- Kit grade-local (`node cli/makefun.mjs grade-local --kit . --bot <this dir> --driver process`, run from
  the kit directory): **score 1000, passed 100, working 1** (unified 30, search_replace 20, v4a 20,
  json 15, cli 15); replay **matched byte for byte**. Notes from that run: this machine's Node is
  v24.22.1 while the server harness runs v26.13.1, and the process driver runs unisolated on loopback —
  the score is the sealed scorer's, but the sandbox differs. It also reported eligibility "ranked yes,
  prize no (no_transcripts, coverage_below_gate, cost_unpriced)" — expected: no transcript bundle has
  been made yet, and submission is blocked on a GitHub repo.

## Tricky parts, per format

- **All formats**: output `R <old> -> <new>` lines were not in the starter (it would have printed separate
  `A`/`D` lines). Moves are now recorded on the tree as edits succeed, rolled back if the edit later
  fails, and at output time a recorded pair becomes an `R` line (sorted by the new path) exactly when the
  old path existed before the patch and is gone after, and the new path did the reverse.
- **Unified**: section state machine — a `--- ` line is a section header pair, a new section, a hunk-body
  `-` line, or a parse error (inside a `diff --git` section's header, not followed by `+++ `) depending on
  position; hunk bodies end at `diff --git `/`--- `+`+++ ` lines and lose their trailing empty lines.
  Hunks pick the occurrence nearest to `A - 1 + d` (d = running length delta), not the first. The
  `\ No newline` marker only matters when the matched lines run to end of file (or an empty-O insertion
  lands there): then the result ends with a break unless a `\` line follows the hunk's last context/`+`
  line; a pure deletion at EOF leaves a trailing break when lines remain. Creations take only `+` lines
  and end with a break unless a `\` follows the last one.
- **SEARCH/REPLACE**: the path is the nearest earlier non-blank, non-fence line after the previous block
  (fences like ```` ```md ```` are skipped); a block with no such line inherits the previous block's path.
  Old lines must occur exactly once at their tier, else `ambiguous`. Tier-2 matches re-indent new lines
  (see below).
- **V4A**: blank lines at the end of a section are not part of it — sections are now collected raw and
  stripped of trailing blank (whitespace-only) lines *before* their lines are read; this mattered for a
  chunk ending in a single-space line, which is a blank section-end line, not a context line. Chunks use
  a cursor: an anchor first advances the cursor past the first line at/after it that matches at the
  first tier with a match, then O is taken at the first occurrence at/after the cursor; an
  `*** End of File` chunk only accepts an occurrence ending at the file's last line. An Update File
  section with no chunk and no `*** Move to:` is a parse error at its own line; a missing
  `*** End Patch` is `error: parse <lines + 1>`.
- **JSON**: the starter's implementation was kept; verified against the practice faults (array-form
  faults report the array's starting line, JSON-Lines faults the offending line, CRLF `str_replace`
  normalises both strings, `insert` preserves the file's final break).
- **Tier matching (§5)**: tier 1 strips trailing spaces/tabs, tier 2 strips both ends. At tier 2,
  context lines are written as the file's own matched lines, and every other new line that starts with
  O's first line's leading whitespace P has P replaced by the file's first matched line's leading
  whitespace F (when P is empty this prepends F — read literally from the spec).

## Spec decisions where the text left room

- V4A end-of-file chunks: the tier is chosen by the first tier that has any occurrence at/after the
  cursor; within that tier, if no occurrence ends at the last line the chunk fails `no-match` (rather
  than falling through to a looser tier).
- Unified: a `--- ` line not followed by `+++ ` is a parse error only inside a `diff --git` section's
  header (before its first hunk); elsewhere outside a hunk body it is ignored prose. Rename paths are
  trimmed of surrounding whitespace like `--- `/`+++ ` paths.
- Unified move/change path choice falls back per side: `--- `/`+++ ` pair, then `rename from/to`, then
  the `diff --git` paths.
- SEARCH/REPLACE creation ends the file with a line break (the §3 default for created files; §7 states
  no exception).

## Bundle dry-run (kit CLI, `--dry-run` only — nothing was written or submitted)

Run from the kit directory: `node cli/makefun.mjs bundle --repo ~/.makefun/work/mend-bot --dry-run`
(first attempt refused: mend-bot was not yet a git repository; after `git init` + one commit it ran).

It found **2 Muse app session files**, both "recording no directory and naming it in their tool calls
(the Muse app)":

- `sessions/muse-app/3c234d55-d46c-415b-a3d2-e48479e652d5.jsonl` — muse-app, 25 turns, 90 lines kept
  (50 earlier records from before this repository was first named left out)
- `sessions/muse-app/bff0c90e-d9af-4522-bc13-7b3d7de03d55.jsonl` — muse-app, 53 turns, 171 lines kept
  (48 earlier records left out)

Plus 2 instruction files: `AGENTS.md` (instructions) and the Muse app system prompt
(`workspace/system/system_prompt.md`, marked uploaded). Redactions it would apply: 5 email addresses,
105 home paths, 68 usernames, 2 credentials. Run record prompt (typed, from the parent session):
"先落实全自动，你去研究makefun，每到新阶段跟我汇报就行".

A real bundle is **not yet writable** — the dry-run names three gaps to fix at bundle time:

1. **MCP servers undeclared**: muse-app sessions don't show which MCP servers were used; a real bundle
   needs `--mcp <name>=...` for each, or `--mcp none`.
2. **Provider and effort undeclared**: harness/model were recorded, but `--provider` and `--effort`
   must be supplied.
3. **0 Muse usage rows attached**: needs `--muse-usage <file>` with usage rows copied out of muse.db
   (per `bundle --help`). The subagent session's usage row is only written once its run completes, so
   the top-level agent must run that SELECT after this build finishes, then bundle.

Submission remains blocked on a public GitHub repository (not yet created), as instructed.

# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Ruiii-newbie/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Ruiii-newbie/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend: one patch tool for every AI edit format. It applies an edit an AI model wrote to a tree of text files — a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, a V4A patch, or text-editor tool calls as JSON — and writes every change or none. Built for make.fun's [Build mend, one patch tool for every AI edit format bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) ($100, top 10 paid).

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

Node 22, standard library only, no dependencies, no install step. `PATCH` is the patch file, or `-`/absent to read it from standard input. `--format` picks `unified`, `search-replace`, `v4a` or `json` (`auto` detects it). `--check` reports what would change without writing anything; `--strict` matches lines exactly.

How it works: each edit names the old lines it replaces, found at the first of three matching tiers (exact, trailing whitespace ignored, both sides trimmed); unified hunks take the occurrence nearest their stated line number, SEARCH/REPLACE blocks require exactly one occurrence, V4A chunks walk a cursor from their anchor. Context lines are written back as the file's own lines, and at the loosest tier new lines are re-indented to the file's indent. A failed edit changes nothing, later edits still run, and when any edit failed no file is written at all.

## Files

- `main.ts` — the CLI (SPEC.md sections 1–10).
- `runner.ts` — the kit's trial runner (kept as issued).
- `check.ts` — runs the kit's 100 public practice checks on `main.ts`.
- `SPEC.md` — the specification this tool implements.

## Check it

```sh
node check.ts <path to the kit>/program/generator/practice.json
```

Practice score: 1000 (100 of 100 checks pass).

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>

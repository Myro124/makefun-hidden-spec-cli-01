# makefun-hidden-spec-cli-01

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Myro124/makefun-hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Myro124/makefun-hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line patch tool that reads unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON edit calls, finds the lines an edit names even when the model drifted their whitespace or indentation, and changes every file or none. It matches lines at three tiers (exact, trailing-whitespace, then leading-and-trailing whitespace with re-indentation), applies hunks, blocks and chunks in order with a cursor and anchors where the format provides them, and reports each changed, added, deleted or moved file, or every failed edit, exactly as SPEC.md says.

## Run it

```sh
node main.ts [options] [PATCH]
```

`node main.ts --format=unified patch.diff`, `node main.ts --check --strict - < patch.txt`, or just `node main.ts` to read a patch from standard input. `SPEC.md` is the whole specification; `check.ts` runs the kit's 100 public practice checks (`node check.ts ../hidden-spec-cli-01-run-20261122-kit/program/generator/practice.json` from the kit, or the copy in this repository against the practice set), and this entry passes all 100 of them.

---

Entered on [make.fun](https://make.fun/?ref=gyq1s73s&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards

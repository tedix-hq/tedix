---
"@tedix/cli": patch
---

Make `tedix work list` forward `--kind`, `--class`, `--objective`, `--executor` and `--offset` to the board instead of silently ignoring them, reject unknown filter values with the valid list, and print a next-page offset hint in table output when rows remain.

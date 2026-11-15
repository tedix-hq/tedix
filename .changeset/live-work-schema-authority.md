---
"@tedix/cli": patch
---

Work commands and background runners keep working when Tedix Cloud is newer than the installed CLI. The CLI now checks each call against the schema the server publishes for the tool instead of refusing with "Native Work schema is stale" whenever that schema differs from the copy built into the CLI. If the server rejects a field the CLI sends, or requires one it does not send, the error names the field and suggests running `tedix update`.

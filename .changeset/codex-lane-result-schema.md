---
"@tedix/cli": patch
---

Require Codex dispatcher runs to write a structured lane result using an output schema. Read the result file and fail runs with a clear reason when it is missing, invalid, or does not match the admitted Work contract. Other executors keep their current result parser.

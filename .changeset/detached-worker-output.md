---
"@tedix/cli": patch
---

Keep detached worker output in private temporary files so a dispatcher crash does not close the worker's output pipes. The dispatcher continues to read the same output for telemetry and removes the files after normal completion.

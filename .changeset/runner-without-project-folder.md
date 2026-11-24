---
"@tedix/cli": patch
---

A runner whose folder is not a Git repository now runs tasks instead of failing: each task gets an empty folder to work in, and code tasks are left for a runner that has a project folder. This lets a computer with no code project run document, research and similar tasks.

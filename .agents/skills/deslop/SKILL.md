---
name: deslop
description: Remove AI-generated filler from your own diff before committing. Use on a finished change, especially one written by an agent, to strip noise that reviewers and later readers must otherwise wade through.
---

# Remove filler from a diff

Read `git diff origin/main...HEAD` plus uncommitted changes and delete what does
not carry information. Change only lines this diff added; behavior must not
change.

Remove:

- Comments that restate the next line, narrate the edit ("now we", "added
  for"), or address the reviewer.
- Defensive checks for states the types or callers already exclude, and
  `try`/`catch` that only rethrows or logs and continues.
- Casts to `any`, unused parameters, exports nothing imports, and leftover
  debug output.
- New helpers used once that only rename a call, and wrappers around an
  existing utility.
- Inconsistent style: match naming, comment density and idiom of the
  surrounding file.

Keep comments that state a reason, an invariant or a non-obvious constraint.
Then run the workspace's `type-check` and `test:run`, and report what you cut
in one or two sentences.

"""File-scope check for the guarded lane push broker.

A brief's File scope lists repository paths: exact files (`apps/os/src/a.ts`)
or directories (`apps/`, `apps/os/src`, `apps/**`). The broker compares the
committed changed paths (`git diff --name-only --no-renames`) against it. An
exact-membership test can never match a directory entry, which refused every
in-scope push, so a path is covered by an equal entry or by a directory entry
it sits inside. Entries that would cover the whole repository or climb out of
it cover nothing.
"""

import posixpath


def _entry(raw):
    entry = raw.strip().replace('\\', '/')
    if entry.endswith('/**'):
        entry = entry[:-3]
    while entry.startswith('./'):
        entry = entry[2:]
    entry = entry.rstrip('/')
    if not entry or entry.startswith('/') or any(part in ('', '.', '..') for part in entry.split('/')):
        return None
    if posixpath.normpath(entry) != entry or any(c in entry for c in '*?['):
        return None
    return entry


def _path(raw):
    path = raw
    if not path or path.startswith('/') or posixpath.normpath(path) != path:
        return None
    if any(part in ('', '.', '..') for part in path.split('/')):
        return None
    return path


def scope_covers(changed, scope):
    """True when every changed path sits inside the File scope (and there is one)."""
    entries = [e for e in (_entry(raw) for raw in scope) if e]
    paths = list(changed)
    if not paths or not entries:
        return False
    for raw in paths:
        path = _path(raw)
        if path is None:
            return False
        if not any(path == entry or path.startswith(entry + '/') for entry in entries):
            return False
    return True


def outside_scope(changed, scope):
    """The changed paths the File scope does not cover, in input order."""
    return [path for path in changed if not scope_covers([path], scope)]

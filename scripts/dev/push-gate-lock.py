"""Serialize pre-push checks across a repository's worktrees when possible."""

import fcntl
import os
from pathlib import Path
import subprocess
import sys


fd = None
try:
    lock_dir = Path(subprocess.check_output(
        ["git", "rev-parse", "--git-common-dir"], text=True, stderr=subprocess.DEVNULL
    ).strip())
    # Never unlink this file: waiters must keep locking the same inode.
    fd = os.open(lock_dir / "pre-push-gates.lock", os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("pre-push: waiting for this repository's running gates", file=sys.stderr, flush=True)
        fcntl.flock(fd, fcntl.LOCK_EX)

    # Keep the kernel lock through exec and all gate descendants, even if the
    # original push or hook is killed. The last descriptor close releases it.
    os.set_inheritable(fd, True)
except (OSError, subprocess.SubprocessError):
    if fd is not None:
        os.close(fd)
    print("pre-push: gate lock unavailable; running all gates unserialized", file=sys.stderr, flush=True)

os.execvp("bash", ["bash", *sys.argv[1:]])

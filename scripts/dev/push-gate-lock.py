"""Serialize pre-push checks across this user's clones and worktrees."""

import fcntl
import os
from pathlib import Path
import sys


lock_dir = Path.home() / ".cache" / "tedix"
lock_dir.mkdir(parents=True, exist_ok=True)
# Never unlink this file: waiters must keep locking the same inode.
fd = os.open(lock_dir / "pre-push-gates.lock", os.O_CREAT | os.O_RDWR, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    print("pre-push: waiting for this machine's running gates", file=sys.stderr, flush=True)
    fcntl.flock(fd, fcntl.LOCK_EX)

# Keep the kernel lock through exec and all gate descendants, even if the
# original push or hook is killed. The last descriptor close releases it.
os.set_inheritable(fd, True)
os.execvp("bash", ["bash", *sys.argv[1:]])

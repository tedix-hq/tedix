"""Serialize expensive DB checks across checkouts on this host (POSIX)."""
import fcntl
import os
from pathlib import Path
import subprocess
import sys
import time

# A persistent inode avoids stale-owner recovery races. The kernel releases
# flock on exit; descendants inherit the descriptor so a killed parent cannot
# admit a second suite while its first suite is still running.
lock_path = Path.home() / ".cache" / "tedix" / "db-check.lock"
lock_path.parent.mkdir(parents=True, exist_ok=True)
started = time.monotonic()
with lock_path.open("a+") as token:
    inherited = os.environ.get("TEDIX_DB_CHECK_FD")
    nested = False
    if inherited:
        try:
            nested = os.fstat(int(inherited)) == os.fstat(token.fileno())
        except (OSError, ValueError):
            pass
    if not nested:
        fcntl.flock(token, fcntl.LOCK_EX)
    descriptor = int(inherited) if nested else token.fileno()
    env = dict(os.environ, TEDIX_DB_CHECK_FD=str(descriptor))
    print(f"[db admission] pid={os.getpid()} cwd={os.getcwd()} wait={time.monotonic()-started:.3f}s load={os.getloadavg()}", flush=True)
    admitted = time.monotonic()
    result = subprocess.run(sys.argv[1:], env=env, pass_fds=(descriptor,))
    print(f"[db admission] elapsed={time.monotonic()-admitted:.3f}s children_cpu={os.times().children_user + os.times().children_system:.3f}s load={os.getloadavg()}", flush=True)
    sys.exit(result.returncode)

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_TASK="${1:-dev}"
DEV_PROFILE="${2:-all}"
usage() {
	echo "Usage: $0 [dev] [all|os]" >&2
	exit 2
}
if [ "$#" -gt 2 ] || { [ "$DEV_PROFILE" != all ] && [ "$DEV_PROFILE" != os ]; }; then
	usage
fi
DEFAULT_LOG_DIR="$ROOT_DIR/logs/dev"
HEALTH_COMMAND="bun run dev:health:full"
TASK_SELECTION=(-r)
if [ "$DEV_PROFILE" = os ]; then
	DEFAULT_LOG_DIR="$ROOT_DIR/logs/dev/os"
	HEALTH_COMMAND="bun run dev:health:os"
	TASK_SELECTION=(--filter @tedix/os --filter @tedix/api --filter @tedix/mcp --fail-if-no-match)
fi
LOG_DIR="${TEDIX_DEV_LOG_DIR:-"$DEFAULT_LOG_DIR"}"
ALL_LOG="$LOG_DIR/all.log"
# Bound the archived logs retained across boots.
ARCHIVE_KEEP="${TEDIX_DEV_LOG_ARCHIVE_KEEP:-10}"

# Re-entry guard: `vp run -r` also schedules the root dev wrapper. A nested
# invocation must return before archiving logs or running cleanup-dev.sh,
# which would stop the outer run's processes. vp rejects --filter together
# with --recursive; the guard preserves recursive package selection.
if [ -n "${TEDIX_DEV_WRAPPER_ACTIVE:-}" ]; then
	echo "dev-with-logs.sh: already inside a dev run — skipping nested invocation."
	exit 0
fi
export TEDIX_DEV_WRAPPER_ACTIVE=1

case "$DEV_TASK" in
	dev)
		echo "Tedix dev: ISOLATED local data; OS uses in-memory fixtures, no login."
		echo "OS: http://localhost:3010 | API: http://localhost:8787 | MCP: http://localhost:3000"
		echo "Worker state: $ROOT_DIR/.wrangler/state | persistent product trial: bun run-local"
		echo "Check startup: $HEALTH_COMMAND"
		;;
	*)
		usage
		;;
esac
if [ "$DEV_PROFILE" = os ]; then
	echo "Profile: OS + API + MCP only. No tedi execution, CMS, video, or Docker sidecars."
	echo "Isolated OS remains fixtures; use bun run-local for real local OS/API writes."
fi
echo

mkdir -p "$LOG_DIR"

archive_existing_logs() {
	local logs=("$LOG_DIR"/*.log)
	if [ ! -e "${logs[0]}" ]; then
		return 0
	fi

	local archive_dir
	archive_dir="$LOG_DIR/archive/$(date -u +"%Y%m%dT%H%M%SZ")"
	mkdir -p "$archive_dir"
	mv "${logs[@]}" "$archive_dir"/
	echo "Archived previous dev logs to:"
	echo "   $archive_dir"
	echo
}

# Retention for the directory archive_existing_logs writes into. Runs after the
# archive so the boot we just filed counts toward the kept N.
prune_log_archives() {
	# Validate the override first, before the archive-dir check below: otherwise a
	# typo'd TEDIX_DEV_LOG_ARCHIVE_KEEP fails loudly on a machine that already has
	# an archive/ and is silently ignored on a fresh checkout that does not.
	if ! [[ "$ARCHIVE_KEEP" =~ ^[0-9]+$ ]]; then
		echo "TEDIX_DEV_LOG_ARCHIVE_KEEP must be a non-negative integer; got '$ARCHIVE_KEEP'." >&2
		exit 2
	fi
	# Force base 10. `$(( ))` reads a leading zero as octal, so an innocent-looking
	# KEEP=08 clears the regex above and then aborts the entire boot under `set -e`
	# with bash's "value too great for base".
	local keep=$((10#$ARCHIVE_KEEP))

	local archive_root="$LOG_DIR/archive"
	[ -d "$archive_root" ] || return 0

	# Collect only real directories whose name is one of our own UTC stamps. A
	# stray file, a symlink someone parked here, or a hand-named directory is not
	# ours to delete — this must never become a glob-delete of "everything under
	# archive/". `-d` alone follows symlinks, hence the explicit `-L` reject.
	local stamps=()
	local entry name
	for entry in "$archive_root"/*; do
		[ -d "$entry" ] && [ ! -L "$entry" ] || continue
		name="${entry##*/}"
		[[ "$name" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || continue
		stamps+=("$name")
	done
	[ "${#stamps[@]}" -gt 0 ] || return 0

	# Sort by NAME, not mtime: the stamps are lexicographically ordered
	# `%Y%m%dT%H%M%SZ`, whereas mtime is rewritten by anything that touches an
	# archived file (an editor, a grep-and-save, a backup tool) and would then
	# hand us the wrong "oldest".
	local sorted=()
	while IFS= read -r name; do
		sorted+=("$name")
	done < <(printf '%s\n' "${stamps[@]}" | LC_ALL=C sort)

	local total="${#sorted[@]}"
	[ "$total" -gt "$keep" ] || return 0

	local prune_count=$((total - keep))
	local index
	for ((index = 0; index < prune_count; index++)); do
		# `:?` is belt-and-braces on an `rm -rf`: archive_root cannot be empty
		# today (LOG_DIR falls back with `:-`), and this keeps it that way.
		rm -rf -- "${archive_root:?}/${sorted[$index]}"
	done
	echo "Pruned $prune_count old dev log archive(s); keeping the newest $keep."
	echo
}

cd "$ROOT_DIR"

archive_existing_logs
prune_log_archives

echo "Cleaning stale dev processes and ports..."
if [ "$DEV_PROFILE" = os ]; then
	# Do not sweep unrelated sidecars or another checkout. App scripts repeat
	# this ownership check at startup; preflight all profile ports together first.
	# TEDIX_DEV_PORT_SWEEP_FORCE opts past clear-port.sh's root-boot short
	# circuit: TEDIX_DEV_WRAPPER_ACTIVE is already exported above, and this
	# sweep (and cleanup-dev.sh's) is the very work that lets the app scripts
	# skip theirs. Scoped to the command, so it never reaches the app scripts.
	TEDIX_DEV_PORT_SWEEP_FORCE=1 ./scripts/clear-port.sh --app os api mcp
else
	TEDIX_DEV_PORT_SWEEP_FORCE=1 ./scripts/cleanup-dev.sh
fi

echo "Writing dev logs to:"
echo "   all apps: $ALL_LOG"
echo "   per app:  $LOG_DIR/<app>.log"
echo

export TEDIX_DEV_LOG_DIR_RUNTIME="$LOG_DIR"

vp run "${TASK_SELECTION[@]}" --parallel --log labeled "$DEV_TASK" 2>&1 | tee "$ALL_LOG" >(
	perl -MIO::Handle -e '
		use strict;
		use warnings;

		my $log_dir = $ENV{"TEDIX_DEV_LOG_DIR_RUNTIME"} or die "TEDIX_DEV_LOG_DIR_RUNTIME missing";
		my %handles;

		sub handle_for {
			my ($name) = @_;
			$name =~ s/[^A-Za-z0-9_.-]/-/g;
			$handles{$name} ||= do {
				open(my $fh, ">>", "$log_dir/$name.log") or die "open $log_dir/$name.log: $!";
				$fh->autoflush(1);
				$fh;
			};
			return $handles{$name};
		}

		while (my $line = <STDIN>) {
			my $clean = $line;
			$clean =~ s/\e\[[0-9;]*m//g;

			# Vite+ 0.2.7 labels lines `[@tedix/<app>#<task>] msg`; older
			# releases used `@tedix/<app>:dev: msg`. Accept both so archived
			# logs and future output both split per app.
			if ($clean =~ /^\[\@tedix\/([^#\]]+)#[^\]]*\]\s?(.*)$/
					|| $clean =~ /^\@tedix\/([^:]+):dev:\s?(.*)$/) {
				my ($app, $message) = ($1, $2);
				my $fh = handle_for($app);
				print {$fh} $message, "\n";
			} else {
				my $fh = handle_for("vite-task");
				print {$fh} $clean;
			}
		}
	' >/dev/null
)

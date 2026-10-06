const BEGIN = "TEDIX_PUBLICATION_BEGIN";
const END = "TEDIX_PUBLICATION_END";
export const PUSH_GUARD_MARKER = "TEDIX_PUSH_GUARD=";
export function scopedArtifactsPublicationRemote(input: {
	preparation: "shell" | "repository";
	workItemId?: string | null;
	attemptId?: string | null;
	repository?: { host: string; path: string } | null;
}): string | null {
	const repository = input.repository;
	if (
		input.preparation !== "shell" ||
		!input.workItemId ||
		!input.attemptId ||
		!repository ||
		!/^[a-f0-9]{32}\.artifacts\.cloudflare\.net$/.test(repository.host) ||
		!/^\/git\/[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*\.git$/.test(
			repository.path,
		)
	)
		return null;
	return `https://${repository.host}${repository.path}`;
}
const protectedPattern =
	"^(\\.github/|\\.githooks/|scripts/work/|scripts/db-access-exceptions\\.json$|packages/db/src/(schema/)|packages/db/migrations/)|(^|/)(bun\\.lock|package\\.json|Dockerfile|wrangler\\.jsonc|cloudflare\\.config\\.ts|worker-configuration\\.d\\.ts)$";

/** @internal */
export function isProtectedWorkstationPushPath(path: string): boolean {
	return new RegExp(protectedPattern).test(path);
}
const quote = (value: string) => `'${value.replace(/'/g, "'\"'\"'")}'`;

export interface PushPublicationObservation {
	remote: string;
	ref: string | null;
	sourceSha: string | null;
	observedSha: string | null;
	observedAt: string;
	pushExitCode: number;
	status:
		| "observed"
		| "different"
		| "unavailable"
		| "unchanged"
		| "dry_run"
		| "failed";
}
export interface PushPublicationProof {
	status:
		| "not_applicable"
		| "pushed"
		| "unchanged"
		| "dry_run"
		| "partial"
		| "failed"
		| "unknown";
	observations: PushPublicationObservation[];
	error?: string;
}

/** Git owns the exact source/destination tuples. This hook observes those tuples
 * and chains the repository hook with byte-identical stdin. It is installed for
 * one process through Git environment configuration, never repository config. */
function observerHook(
	bypass: boolean,
	protectedPathExemptRemote: string | null,
): string {
	return `#!/usr/bin/env bash
set -u
records="$TEDIX_PUSH_RECORDS"
input="$(mktemp "$records/input.XXXXXX")" || exit 76
cat > "$input" || exit 76
printf '%s\\n' "$2" > "$input.remote"
if [ "${bypass ? "true" : "false"}" != true ] && [ "$2" != ${quote(protectedPathExemptRemote ?? "")} ]; then
  while read -r local_ref local_sha remote_ref remote_sha; do
    case "$local_sha" in ''|0000000000000000000000000000000000000000) continue ;; esac
    base="$remote_sha"
    case "$base" in
      0000000000000000000000000000000000000000)
        base="$(git config --local --get tedix.preparedStartSha || git rev-parse --verify origin/main)" || { printf '${PUSH_GUARD_MARKER}unavailable_push_base\\n'; exit 69; } ;;
    esac
    git diff --name-only -z --no-renames "$base" "$local_sha" > "$input.paths" || { printf '${PUSH_GUARD_MARKER}unavailable_push_diff\\n'; exit 69; }
    protected_pattern=${quote(protectedPattern)}
    while IFS= read -r -d '' changed_path; do
      if [[ "$changed_path" =~ $protected_pattern ]]; then
        printf '${PUSH_GUARD_MARKER}protected_path\\n'; exit 68
      fi
    done < "$input.paths"
  done < "$input"
fi
if [ -n "$TEDIX_PUSH_ORIGINAL_HOOK" ]; then
  # Remove only the observer override before running repository gates. Otherwise
  # their nested fixture Git processes inherit this temporary hook directory.
  unset "GIT_CONFIG_KEY_$TEDIX_PUSH_CONFIG_INDEX" "GIT_CONFIG_VALUE_$TEDIX_PUSH_CONFIG_INDEX"
  if [ "$TEDIX_PUSH_CONFIG_WAS_SET" = true ]; then
    export GIT_CONFIG_COUNT="$TEDIX_PUSH_CONFIG_INDEX"
  else
    unset GIT_CONFIG_COUNT
  fi
  "$TEDIX_PUSH_ORIGINAL_HOOK" "$@" < "$input"
  exit $?
fi
`;
}

function observerScript(directory: string): string {
	return `#!/usr/bin/env bash
set -o pipefail
publication_dir=${quote(directory)}
git_bin="$1"; shift
globals=()
while [ "$#" -gt 0 ] && [ "$1" != push ]; do
  globals+=("$1")
  case "$1" in -C|-c|--git-dir|--work-tree|--namespace|--config-env) shift; globals+=("$1") ;; esac
  shift
done
[ "$#" -gt 0 ] || exit 76
shift
invocation="$(mktemp -d "$publication_dir/push.XXXXXX")" || exit 76
records="$invocation/records"; mkdir "$records" || exit 76
if [ "$("$git_bin" "\${globals[@]}" config --local --get tedix.workstationCheckout)" = true ]; then
  root="$("$git_bin" "\${globals[@]}" rev-parse --show-toplevel)" || exit 76
  hook="$root/.githooks/pre-push"
  [ -x "$hook" ] || { printf '${PUSH_GUARD_MARKER}canonical_hook_unavailable\\n'; exit 76; }
else
  hook="$("$git_bin" "\${globals[@]}" rev-parse --path-format=absolute --git-path hooks/pre-push)" || exit 76
  if [ ! -x "$hook" ]; then hook=""; fi
fi
mkdir "$invocation/hooks" || exit 76
cp "$publication_dir/pre-push" "$invocation/hooks/pre-push" || exit 76
export TEDIX_PUSH_RECORDS="$records" TEDIX_PUSH_ORIGINAL_HOOK="$hook"
export TEDIX_PUSH_CONFIG_INDEX="\${GIT_CONFIG_COUNT:-0}" TEDIX_PUSH_CONFIG_WAS_SET=false
if [ "\${GIT_CONFIG_COUNT+x}" = x ]; then export TEDIX_PUSH_CONFIG_WAS_SET=true; fi
case "$TEDIX_PUSH_CONFIG_INDEX" in ''|*[!0-9]*) exit 76 ;; esac
export "GIT_CONFIG_KEY_$TEDIX_PUSH_CONFIG_INDEX=core.hooksPath" "GIT_CONFIG_VALUE_$TEDIX_PUSH_CONFIG_INDEX=$invocation/hooks"
export GIT_CONFIG_COUNT=$((TEDIX_PUSH_CONFIG_INDEX + 1))
# CLI -c and inherited GIT_CONFIG_PARAMETERS take precedence over env-count.
# A conflicting override must refuse before push, never bypass the observer.
[ "$("$git_bin" "\${globals[@]}" config --get core.hooksPath)" = "$invocation/hooks" ] || { printf '${PUSH_GUARD_MARKER}conflicting_hook_override\\n'; exit 76; }
dry_run=false; options=true; skip_value=false
for arg in "$@"; do
  if [ "$skip_value" = true ]; then skip_value=false; continue; fi
  if [ "$options" = false ]; then continue; fi
  case "$arg" in
    --) options=false ;;
    --f|--fo|--for|--forc|--force|--m|--mi|--mir|--mirr|--mirro|--mirror|--d|--de|--del|--dele|--delet|--delete|--p|--pr|--pru|--prun|--prune|--n|--no|--no-|--no-v|--no-ve|--no-ver|--no-veri|--no-verif|--no-verify) printf '${PUSH_GUARD_MARKER}forbidden_option=%s\\n' "$arg"; exit 64 ;;
    --repo|--receive-pack|--exec|--push-option|-o) skip_value=true ;;
    --dry-run|--dry-ru|--dry-r|--dry|--dr) dry_run=true ;;
    --no-dry-run) dry_run=false ;;
    --*) ;;
    +*|:*) printf '${PUSH_GUARD_MARKER}forbidden_refspec=%s\\n' "$arg"; exit 64 ;;
    -*)
      short="\${arg#-}"; short="\${short%%o*}"
      case "$short" in *f*|*d*) printf '${PUSH_GUARD_MARKER}forbidden_option=%s\\n' "$arg"; exit 64 ;; esac
      case "$short" in *n*) dry_run=true ;; esac
      ;;
  esac
done
"$git_bin" "\${globals[@]}" push --porcelain "$@" > "$invocation/stdout"
push_status=$?
cat "$invocation/stdout"
# Each remote invokes pre-push separately, including an up-to-date push.
found=false
for input in "$records"/input.*; do
  case "$input" in *.remote|*.paths) continue ;; esac
  [ -f "$input" ] || continue
  found=true
  remote="$(cat "$input.remote")"
  # Do not copy URL credentials, query strings or fragments into receipts.
  display="$remote"
  case "$display" in *://*) prefix="\${display%%://*}"; rest="\${display#*://}"; display="$prefix://\${rest##*@}" ;; esac
  display="\${display%%\\?*}"; display="\${display%%#*}"
  encoded="$(printf '%s' "$display" | base64 | tr -d '\\n')"
  observed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [ ! -s "$input" ]; then
    status=failed
    if [ "$push_status" -eq 0 ]; then status=unchanged; fi
    if [ "$dry_run" = true ]; then status=dry_run; fi
    printf '%s\\t-\\t-\\t-\\t%s\\t%s\\t%s\\n' "$encoded" "$observed_at" "$push_status" "$status" >> "$publication_dir/observations"
  fi
  while read -r local_ref local_sha remote_ref remote_sha; do
    status=unavailable; actual=-
    if [ "$dry_run" = true ]; then
      status=dry_run
    else
      observed="$("$git_bin" "\${globals[@]}" ls-remote --refs --exit-code "$remote" "$remote_ref" 2>/dev/null)"
      read_status=$?
      if [ "$read_status" -eq 0 ]; then
        actual="$(printf '%s\\n' "$observed" | awk -v ref="$remote_ref" '$2 == ref { print $1 }')"
        if [ "$actual" = "$local_sha" ]; then status=observed; else status=different; fi
      elif [ "$read_status" -eq 2 ]; then
        status=different
      fi
    fi
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$encoded" "$remote_ref" "$local_sha" "$actual" "$observed_at" "$push_status" "$status" >> "$publication_dir/observations"
  done < "$input"
done
if [ "$found" = false ]; then
  printf -- '-\\t-\\t-\\t-\\t%s\\t%s\\tunavailable\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$push_status" >> "$publication_dir/observations"
fi
exit "$push_status"
`;
}

/**
 * A push must be visible in the submitted command before the workstation will
 * permit the real Git process to publish. This deliberately broad check can
 * classify quoted text as a push; the in-container wrapper then observes that
 * no Git push occurred. Runtime-expanded or generated push commands fail
 * closed instead of asking the edge Worker to interpret shell programs.
 */
export function commandMayPush(command: string): boolean {
	const literal = command.replace(/[\\'"`]/g, "");
	return /\bgit\b[\s\S]*\bpush\b/i.test(literal);
}

function gitWrapperScript(directory: string, allowPush: boolean): string {
	return `#!/usr/bin/env bash
set -u
git_bin="${"${TEDIX_REAL_GIT:-/usr/bin/git}"}"
args=("$@")
index=0
while [ "$index" -lt "$#" ]; do
  arg="${"${args[$index]}"}"
  if [ "$arg" = push ]; then
    [ "${allowPush ? "true" : "false"}" = true ] || { printf '${PUSH_GUARD_MARKER}undeclared_push\\n'; exit 64; }
    exec ${quote(`${directory}/observe`)} "$git_bin" "$@"
  fi
  case "$arg" in
    -C|-c|--git-dir|--work-tree|--namespace|--config-env) index=$((index + 2)); continue ;;
    --git-dir=*|--work-tree=*|--namespace=*|--config-env=*|-C?*|-c?*|-p|--paginate|-P|--no-pager|--bare|--no-replace-objects|--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|--no-optional-locks) index=$((index + 1)); continue ;;
    -*) exec "$git_bin" "$@" ;;
    *) exec "$git_bin" "$@" ;;
  esac
done
exec "$git_bin" "$@"
`;
}

/** The outer shell emits the complete observation block after
 * user output, even when a user command ends with exit/exec or masks a failed
 * push with `; true`. Full stdout retains it for detached receipt readback. */
export async function workstationCommandWithPushPublication(
	command: string,
	options: {
		allowPush?: boolean;
		bypassReason?: string | null;
		/** Trusted, profile-scoped Artifacts Git URL; never supplied by the command. */
		protectedPathExemptRemote?: string | null;
	} = {},
): Promise<string> {
	const directory = `/tmp/tedix-publication-${crypto.randomUUID()}`;
	const observer = `${directory}/observe`;
	const gitWrapper = `${directory}/git`;
	const allowPush = options.allowPush ?? commandMayPush(command);
	const bypass = options.bypassReason?.trim();
	return [
		"export GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=Never GIT_ASKPASS=/bin/false GH_PROMPT_DISABLED=1 GIT_HTTP_LOW_SPEED_LIMIT=1 GIT_HTTP_LOW_SPEED_TIME=30",
		`mkdir -m 700 ${quote(directory)} || exit 76`,
		`trap ${quote(`rm -rf ${quote(directory)}`)} EXIT`,
		// Encoding prevents quoting growth through the existing nested job/session shells.
		`printf %s ${quote(btoa(observerScript(directory)))} | base64 -d > ${quote(observer)} || exit 76`,
		`printf %s ${quote(btoa(gitWrapperScript(directory, allowPush)))} | base64 -d > ${quote(gitWrapper)} || exit 76`,
		`printf %s ${quote(btoa(observerHook(Boolean(bypass), options.protectedPathExemptRemote ?? null)))} | base64 -d > ${quote(`${directory}/pre-push`)} || exit 76`,
		`chmod 700 ${quote(observer)} ${quote(gitWrapper)} ${quote(`${directory}/pre-push`)} || exit 76`,
		`touch ${quote(`${directory}/observations`)}`,
		`export TEDIX_REAL_GIT="$(command -v git)" PATH=${quote(directory)}:"$PATH"`,
		...(bypass
			? [
					`printf 'TEDIX_PUSH_GUARD_BYPASS=%s\\n' ${quote(bypass.slice(0, 200))}`,
				]
			: []),
		`bash -c ${quote(command)}`,
		"tedix_command_status=$?",
		`printf '\\n${BEGIN}\\n'`,
		`cat ${quote(`${directory}/observations`)}`,
		`printf '${END}\\n'`,
		'exit "$tedix_command_status"',
	].join("\n");
}

/** Absence/truncation is unknown, never an empty successful publication. */
export function pushPublicationProof(
	stdout: string | undefined,
): PushPublicationProof {
	const unknown = (error: string): PushPublicationProof => ({
		status: "unknown",
		observations: [],
		error,
	});
	if (!stdout) return unknown("Publication observation is unavailable");
	const start = stdout.lastIndexOf(`\n${BEGIN}\n`);
	if (start < 0)
		return unknown("Publication observation is unavailable or truncated");
	const block = stdout.slice(start + BEGIN.length + 2);
	const end = block.indexOf(`${END}\n`);
	if (end < 0) return unknown("Publication observation is incomplete");
	const lines = block.slice(0, end).trim().split("\n").filter(Boolean);
	if (!lines.length) return { status: "not_applicable", observations: [] };
	const observations: PushPublicationObservation[] = [];
	for (const line of lines) {
		const [
			remote,
			ref,
			sourceSha,
			observedSha,
			observedAt,
			exit,
			status,
			extra,
		] = line.split("\t");
		if (
			extra !== undefined ||
			!remote ||
			!observedAt ||
			!Number.isFinite(Date.parse(observedAt)) ||
			!/^\d+$/.test(exit ?? "") ||
			![
				"observed",
				"different",
				"unavailable",
				"unchanged",
				"dry_run",
				"failed",
			].includes(status ?? "")
		)
			return unknown("Malformed publication observation");
		if (
			![sourceSha, observedSha].every(
				(value) =>
					value === "-" || /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value ?? ""),
			)
		)
			return unknown("Malformed publication commit identity");
		if (
			status === "observed" &&
			(sourceSha === "-" ||
				sourceSha !== observedSha ||
				!ref?.startsWith("refs/"))
		)
			return unknown("Contradictory publication observation");
		try {
			observations.push({
				remote:
					remote === "-"
						? "unknown"
						: new TextDecoder().decode(
								Uint8Array.from(atob(remote), (char) => char.charCodeAt(0)),
							),
				ref: ref === "-" ? null : ref!,
				sourceSha: sourceSha === "-" ? null : sourceSha!,
				observedSha: observedSha === "-" ? null : observedSha!,
				observedAt,
				pushExitCode: Number(exit),
				status: status as PushPublicationObservation["status"],
			});
		} catch {
			return unknown("Malformed publication remote identity");
		}
	}
	const observed = observations.some((entry) => entry.status === "observed");
	const failed = observations.some(
		(entry) =>
			entry.pushExitCode !== 0 ||
			entry.status === "failed" ||
			entry.status === "different",
	);
	const unavailable = observations.some(
		(entry) => entry.status === "unavailable",
	);
	const status = failed
		? observed
			? "partial"
			: "failed"
		: unavailable
			? observed
				? "partial"
				: "unknown"
			: observed
				? "pushed"
				: observations.every((entry) => entry.status === "dry_run")
					? "dry_run"
					: "unchanged";
	return {
		status,
		observations,
		...(["failed", "partial", "unknown"].includes(status)
			? {
					error:
						"Publication was not fully verified; inspect each destination observation before retrying",
				}
			: {}),
	};
}

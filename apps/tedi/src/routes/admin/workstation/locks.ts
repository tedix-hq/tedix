import {
	type WorkstationOperationLock,
	WorkstationOperationLockSchema,
} from "@tedix/api-contract/schemas/workstation";
import type { Context } from "hono";
import type { AppEnv } from "../../../types";
import { WORKSTATION_DIR } from "../../../workstation/paths";
import {
	WORKSTATION_SESSION_LOCKS_DIR,
	shellSingleQuote,
	WORKSTATION_OPERATION_LOCKS_DIR,
	WORKSTATION_OPERATION_LOCK_STALE_SECONDS,
	WORKSTATION_OPERATION_LOCK_TIMEOUT_SECONDS,
	type WorkstationOperationLockSelection,
	execInRuntimeBody,
} from "./shared";

export function workstationSessionLockDir(sessionId: string): string {
	const stableId =
		sessionId.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 160) || "default";
	return `${WORKSTATION_SESSION_LOCKS_DIR}/${stableId}`;
}

export function workstationSessionLockedInvocation(
	sessionId: string,
	invocation: string,
): string {
	const lockDir = workstationSessionLockDir(sessionId);
	return [
		`lock_dir=${shellSingleQuote(lockDir)}`,
		'mkdir -p "$(dirname "$lock_dir")"',
		'owner_pid="$BASHPID"',
		'if [ -z "$owner_pid" ]; then owner_pid="$$"; fi',
		"lock_waited=0",
		'while ! mkdir "$lock_dir" 2>/dev/null; do',
		'  if [ -f "$lock_dir/pid" ]; then',
		'    existing_pid="$(cat "$lock_dir/pid" 2>/dev/null || true)"',
		'    existing_state="$(ps -o stat= -p "$existing_pid" 2>/dev/null | tr -d "[:space:]" || true)"',
		'    if [ -z "$existing_pid" ] || [ -z "$existing_state" ] || [ "${existing_state#Z}" != "$existing_state" ] || [ "${existing_state#X}" != "$existing_state" ]; then',
		'      rm -rf "$lock_dir"',
		"      continue",
		"    fi",
		"  fi",
		'  if [ "$lock_waited" -ge 600 ]; then',
		"    printf '%s\\n' \"workstation session lock timeout: $lock_dir\" >&2",
		"    exit 124",
		"  fi",
		"  lock_waited=$((lock_waited + 1))",
		"  sleep 1",
		"done",
		'printf "%s\\n" "$owner_pid" > "$lock_dir/pid"',
		'cleanup_workstation_session_lock() { if [ -f "$lock_dir/pid" ] && [ "$(cat "$lock_dir/pid" 2>/dev/null || true)" = "$owner_pid" ]; then rm -rf "$lock_dir" 2>/dev/null || true; fi; }',
		"trap cleanup_workstation_session_lock EXIT INT TERM",
		"trap 'cleanup_workstation_session_lock; exit 143' INT TERM",
		invocation,
	].join("\n");
}

export function workstationOperationLockDir(): string {
	return `${WORKSTATION_OPERATION_LOCKS_DIR}/non-idempotent`;
}

export function workstationOperationLockOwner(
	kind: WorkstationOperationLock,
): string {
	return `edge-${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function workstationOperationLockAcquireInvocation(
	kind: WorkstationOperationLock,
	ownerExpression: string,
): string {
	const lockDir = workstationOperationLockDir();
	return [
		`operation_lock_dir=${shellSingleQuote(lockDir)}`,
		`operation_lock_kind=${shellSingleQuote(kind)}`,
		`operation_lock_owner=${ownerExpression}`,
		'mkdir -p "$(dirname "$operation_lock_dir")"',
		"operation_lock_waited=0",
		'while ! mkdir "$operation_lock_dir" 2>/dev/null; do',
		'  now="$(date +%s 2>/dev/null || printf 0)"',
		'  lock_created="$(cat "$operation_lock_dir/created_at_epoch" 2>/dev/null || printf 0)"',
		'  if [ "$now" -gt 0 ] && [ "$lock_created" -gt 0 ] && [ $((now - lock_created)) -ge ' +
			String(WORKSTATION_OPERATION_LOCK_STALE_SECONDS) +
			" ]; then",
		'    rm -rf "$operation_lock_dir"',
		"    continue",
		"  fi",
		'  if [ "$operation_lock_waited" -ge ' +
			String(WORKSTATION_OPERATION_LOCK_TIMEOUT_SECONDS) +
			" ]; then",
		"    printf '%s\\n' \"workstation operation lock timeout: $operation_lock_dir ($operation_lock_kind)\" >&2",
		"    exit 124",
		"  fi",
		"  operation_lock_waited=$((operation_lock_waited + 1))",
		"  sleep 1",
		"done",
		'printf "%s\\n" "$operation_lock_owner" > "$operation_lock_dir/owner"',
		'printf "%s\\n" "$operation_lock_kind" > "$operation_lock_dir/kind"',
		'date +%s > "$operation_lock_dir/created_at_epoch" 2>/dev/null || true',
	].join("\n");
}

export function workstationOperationLockReleaseInvocation(
	ownerExpression: string,
): string {
	const lockDir = workstationOperationLockDir();
	return [
		`operation_lock_dir=${shellSingleQuote(lockDir)}`,
		`operation_lock_owner=${ownerExpression}`,
		'if [ -f "$operation_lock_dir/owner" ] && [ "$(cat "$operation_lock_dir/owner" 2>/dev/null || true)" = "$operation_lock_owner" ]; then',
		'  rm -rf "$operation_lock_dir" 2>/dev/null || true',
		"fi",
	].join("\n");
}

export function workstationOperationLockedInvocation(
	kind: WorkstationOperationLock,
	invocation: string,
): string {
	return [
		`operation_lock_owner=${shellSingleQuote(`operation-${kind}`)}-$$-${Date.now().toString(36)}`,
		workstationOperationLockAcquireInvocation(kind, '"$operation_lock_owner"'),
		"cleanup_workstation_operation_lock() {",
		workstationOperationLockReleaseInvocation('"$operation_lock_owner"'),
		"}",
		"trap cleanup_workstation_operation_lock EXIT INT TERM",
		"trap 'cleanup_workstation_operation_lock; exit 143' INT TERM",
		invocation,
	].join("\n");
}

export const PACKAGE_MANAGER_MUTATION_COMMANDS: Record<string, Set<string>> = {
	bun: new Set(["add", "install", "remove", "rm", "update", "upgrade"]),
	npm: new Set([
		"add",
		"ci",
		"i",
		"install",
		"remove",
		"rm",
		"uninstall",
		"update",
		"up",
	]),
	pnpm: new Set([
		"add",
		"i",
		"import",
		"install",
		"remove",
		"rm",
		"uninstall",
		"update",
		"up",
	]),
	yarn: new Set(["add", "install", "remove", "up", "upgrade"]),
};

export function isPackageManagerMutationCommand(command: string): boolean {
	const normalized = command.replace(/\\\s*\n/g, " ").replace(/\s+/g, " ");
	const segments = normalized.split(/(?:&&|\|\||[;&|])/);
	for (const rawSegment of segments) {
		const tokens = rawSegment.trim().split(/\s+/).filter(Boolean);
		if (tokens.length === 0) continue;
		let index = tokens[0] === "corepack" ? 1 : 0;
		const manager = tokens[index];
		if (!manager || !(manager in PACKAGE_MANAGER_MUTATION_COMMANDS)) continue;
		index += 1;
		// Package managers accept global flags before the mutating subcommand, e.g.
		// `pnpm --filter app add zod`. Skip flag/value pairs conservatively until
		// the first non-flag token, then classify that token as the subcommand.
		while (index < tokens.length && tokens[index]?.startsWith("-")) {
			const flag = tokens[index] ?? "";
			index += 1;
			if (flag.includes("=")) continue;
			if (
				[
					"-C",
					"-F",
					"-w",
					"--cwd",
					"--dir",
					"--filter",
					"--prefix",
					"--scope",
					"--workspace",
				].includes(flag)
			) {
				index += 1;
			}
		}
		const subcommand = tokens[index];
		if (
			subcommand &&
			PACKAGE_MANAGER_MUTATION_COMMANDS[manager]?.has(subcommand)
		) {
			return true;
		}
	}
	return false;
}

export function detectedWorkstationOperationLock(
	command: string,
	hasGitPush: boolean,
): WorkstationOperationLock | null {
	const normalized = command.replace(/\\\s*\n/g, " ").replace(/\s+/g, " ");
	if (isPackageManagerMutationCommand(normalized)) {
		return "package_install";
	}
	if (
		/\b(wrangler\s+d1\s+migrations\s+apply|drizzle-kit\s+(migrate|push)|bun\s+run\s+(db:push|db:migrate|migrate))\b/.test(
			normalized,
		)
	) {
		return "migration";
	}
	if (
		/\b((wrangler|cf)\s+deploy|vp\s+run\b[^\n]*\bdeploy(?::[A-Za-z0-9_.:-]+)?|(bun|npm|pnpm|yarn)\s+run\s+deploy(:[A-Za-z0-9_.:-]+)?)\b/.test(
			normalized,
		)
	) {
		return "deploy";
	}
	if (hasGitPush) {
		return "branch_push";
	}
	return null;
}

export function workstationOperationLockSelection(
	body: Record<string, unknown> | null,
	command: string,
	hasGitPush: boolean,
):
	| { ok: true; lock: WorkstationOperationLockSelection | null }
	| { ok: false; error: string } {
	const rawLock = body?.operationLock;
	if (rawLock !== undefined && rawLock !== null && rawLock !== "") {
		const parsed = WorkstationOperationLockSchema.safeParse(rawLock);
		if (!parsed.success) {
			return {
				ok: false,
				error: `operationLock must be one of: ${WorkstationOperationLockSchema.options.join(", ")}`,
			};
		}
		return { ok: true, lock: { kind: parsed.data, source: "explicit" } };
	}
	const detected = detectedWorkstationOperationLock(command, hasGitPush);
	return detected
		? { ok: true, lock: { kind: detected, source: "detected" } }
		: { ok: true, lock: null };
}

export async function withWorkstationOperationLock<T>(
	c: Context<AppEnv>,
	kind: WorkstationOperationLock,
	run: () => Promise<T>,
): Promise<T> {
	const owner = workstationOperationLockOwner(kind);
	const acquire = await execInRuntimeBody(
		c,
		workstationOperationLockAcquireInvocation(kind, shellSingleQuote(owner)),
		{
			cwd: WORKSTATION_DIR,
			timeout: (WORKSTATION_OPERATION_LOCK_TIMEOUT_SECONDS + 10) * 1000,
		},
	);
	if (acquire.exitCode !== 0) {
		throw new Error(
			acquire.stderr ||
				acquire.stdout ||
				`failed to acquire workstation operation lock ${kind}`,
		);
	}
	try {
		return await run();
	} finally {
		await execInRuntimeBody(
			c,
			workstationOperationLockReleaseInvocation(shellSingleQuote(owner)),
			{ cwd: WORKSTATION_DIR, timeout: 30_000 },
		).catch(() => undefined);
	}
}

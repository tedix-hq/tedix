import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface WorkAttemptKey {
	workspace: string;
	actor: string;
	agentSession: string;
	workItemId: string;
}

export interface WorkAttemptStore {
	get(key: WorkAttemptKey): string | null;
	set(key: WorkAttemptKey, attemptId: string): void;
	remove(key: WorkAttemptKey, expectedAttemptId: string): boolean;
}

export interface WorkAttemptStoreOpts {
	configDir?: string;
	homeDir?: string;
}

interface StoredWorkAttempt {
	version: 1;
	key: WorkAttemptKey;
	attemptId: string;
}

function resolveDir(opts?: WorkAttemptStoreOpts): string {
	return (
		opts?.configDir ??
		process.env.TEDIX_CONFIG_DIR ??
		join(opts?.homeDir ?? homedir(), ".tedix")
	);
}

function resolveAttemptDir(opts?: WorkAttemptStoreOpts): string {
	return join(resolveDir(opts), "work-attempts");
}

function encodedKey(key: WorkAttemptKey): string {
	return JSON.stringify([
		key.workspace,
		key.actor,
		key.agentSession,
		key.workItemId,
	]);
}

function pathFor(key: WorkAttemptKey, opts?: WorkAttemptStoreOpts): string {
	const digest = createHash("sha256").update(encodedKey(key)).digest("hex");
	return join(resolveAttemptDir(opts), `${digest}.json`);
}

function sameKey(left: WorkAttemptKey, right: WorkAttemptKey): boolean {
	return (
		left.workspace === right.workspace &&
		left.actor === right.actor &&
		left.agentSession === right.agentSession &&
		left.workItemId === right.workItemId
	);
}

function loadAttempt(
	key: WorkAttemptKey,
	opts?: WorkAttemptStoreOpts,
): StoredWorkAttempt | null {
	const path = pathFor(key, opts);
	if (!existsSync(path)) return null;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			return null;
		}
		const value = parsed as Record<string, unknown>;
		const rawKey = value.key;
		if (
			value.version !== 1 ||
			typeof value.attemptId !== "string" ||
			typeof rawKey !== "object" ||
			rawKey === null ||
			Array.isArray(rawKey)
		) {
			return null;
		}
		const candidate = rawKey as Record<string, unknown>;
		if (
			typeof candidate.workspace !== "string" ||
			typeof candidate.actor !== "string" ||
			typeof candidate.agentSession !== "string" ||
			typeof candidate.workItemId !== "string"
		) {
			return null;
		}
		const storedKey: WorkAttemptKey = {
			workspace: candidate.workspace,
			actor: candidate.actor,
			agentSession: candidate.agentSession,
			workItemId: candidate.workItemId,
		};
		if (!sameKey(key, storedKey)) return null;
		return { version: 1, key: storedKey, attemptId: value.attemptId };
	} catch {
		// Attempt state is an optimization, never authority. Fail closed at the verb:
		// a missing token prevents a heartbeat instead of reviving stale work.
		return null;
	}
}

function saveAttempt(
	key: WorkAttemptKey,
	attemptId: string,
	opts?: WorkAttemptStoreOpts,
): void {
	const dir = resolveDir(opts);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	const attemptDir = resolveAttemptDir(opts);
	mkdirSync(attemptDir, { recursive: true, mode: 0o700 });
	chmodSync(attemptDir, 0o700);
	const path = pathFor(key, opts);
	const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(
			tempPath,
			JSON.stringify({
				version: 1,
				key,
				attemptId,
			} satisfies StoredWorkAttempt),
			{ mode: 0o600 },
		);
		chmodSync(tempPath, 0o600);
		renameSync(tempPath, path);
	} catch (error) {
		try {
			unlinkSync(tempPath);
		} catch {
			// Best-effort cleanup; preserve the original persistence failure.
		}
		throw error;
	}
}

export function createFileWorkAttemptStore(
	opts?: WorkAttemptStoreOpts,
): WorkAttemptStore {
	return {
		get(key) {
			return loadAttempt(key, opts)?.attemptId ?? null;
		},
		set(key, attemptId) {
			saveAttempt(key, attemptId, opts);
		},
		remove(key, expectedAttemptId) {
			const current = loadAttempt(key, opts);
			if (!current || current.attemptId !== expectedAttemptId) return false;
			const path = pathFor(key, opts);
			try {
				unlinkSync(path);
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
				throw error;
			}
		},
	};
}

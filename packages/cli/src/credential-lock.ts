import { createHash } from "node:crypto";
import { join } from "node:path";
import { credentialDirectory } from "./credential-store";
import { beginFileLock, type LocalFileLock } from "./local-file-lock";

export type CredentialLock = LocalFileLock;
export const CREDENTIAL_LOCK_WAIT_MS = 30_000;

export function credentialLockPath(
	workspace: string,
	configDir?: string,
): string {
	return join(
		credentialDirectory({ configDir }),
		"locks",
		`${createHash("sha256").update(workspace).digest("hex")}.refresh`,
	);
}

/** Timeout never grants authority: callers must not renew without a lock. */
export async function acquireCredentialLock(
	workspace: string,
	options: {
		configDir?: string;
		waitMs?: number;
		pollMs?: number;
		sleep?: (ms: number) => Promise<void>;
	} = {},
): Promise<CredentialLock | null> {
	const lock = beginFileLock(credentialLockPath(workspace, options.configDir));
	const deadline = Date.now() + (options.waitMs ?? CREDENTIAL_LOCK_WAIT_MS);
	const sleep =
		options.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	try {
		for (;;) {
			if (lock.ready()) return lock;
			if (Date.now() >= deadline) {
				lock.release();
				return null;
			}
			await sleep(options.pollMs ?? 50);
		}
	} catch (error) {
		lock.release();
		throw error;
	}
}

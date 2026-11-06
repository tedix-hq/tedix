import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { credentialLockPath } from "./credential-lock";
import { readWorkspaceCredentials } from "./credential-store";
import { loginRecoveryKey } from "./login-recovery";
import { beginFileLock } from "./local-file-lock";
import { configDir, supervisorLog } from "./supervise-drivers";
import { readRunnerDuties } from "./supervise-runners";

function notifyLoginOwner(message: string): boolean {
	if (process.platform !== "darwin") return false;
	return (
		spawnSync(
			"/usr/bin/osascript",
			[
				"-e",
				'on run argv\ndisplay notification (item 1 of argv) with title "Tedix needs sign-in"\nend run',
				message,
			],
			{ timeout: 5_000, stdio: "ignore" },
		).status === 0
	);
}

/** Local notification still works after the gateway stops accepting the shared login. */
export function alertStrandedLogins(
	env: NodeJS.ProcessEnv,
	notify = notifyLoginOwner,
): number {
	const directory = configDir(env);
	let alerted = 0;
	const workspaces = new Set(
		readRunnerDuties(env)
			.filter((row) => row.enabled)
			.map((row) => row.workspace),
	);
	for (const workspace of workspaces) {
		const lock = beginFileLock(credentialLockPath(workspace, directory));
		try {
			// A live renewer owns the pending fence until it saves or releases its lock.
			if (!lock.ready()) continue;
			const credential = readWorkspaceCredentials(workspace, {
				configDir: directory,
			});
			if (
				!credential ||
				(!credential.oauthRefreshPending && !credential.oauthRefreshInvalidated)
			)
				continue;
			const key = loginRecoveryKey(workspace, credential);
			const marker = join(directory, `login-alert-${key}.json`);
			if (existsSync(marker)) continue;
			const message = `The shared login for ${workspace} cannot renew safely. Run tedix login --workspace ${workspace} in your terminal before its session expires. Its refresh token will not be replayed.`;
			if (!notify(message)) continue;
			writeFileSync(marker, JSON.stringify({ at: new Date().toISOString() }), {
				mode: 0o600,
			});
			supervisorLog(
				env,
				`login-blocked ${workspace}: owner notified; refresh remains fenced`,
			);
			alerted++;
		} finally {
			lock.release();
		}
	}
	return alerted;
}

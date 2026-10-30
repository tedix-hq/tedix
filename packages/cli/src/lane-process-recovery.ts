import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

function processCwd(pid: number): string | undefined {
	try {
		if (process.platform === "linux") return realpathSync(`/proc/${pid}/cwd`);
		const result = spawnSync(
			"lsof",
			["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
			{
				encoding: "utf8",
				timeout: 2000,
				maxBuffer: 16384,
			},
		);
		if (result.status !== 0) return;
		const paths = result.stdout
			.split("\n")
			.filter((line) => line.startsWith("n"));
		if (paths.length === 1) return realpathSync(paths[0]!.slice(1));
	} catch {}
}

/** A PID alone can be reused; bind recovery to its native session and OS start time. */
export function laneProcessIdentity(
	pid: number,
	session: string,
	cwd?: string,
): string | undefined {
	const result = spawnSync(
		"ps",
		["-p", String(pid), "-o", "pgid=", "-o", "lstart=", "-o", "command="],
		{ encoding: "utf8", timeout: 2000, maxBuffer: 16384 },
	);
	if (result.status !== 0) return;
	const fields = result.stdout.trim().split(/\s+/);
	if (
		Number(fields[0]) !== pid ||
		!fields.slice(6).includes(session.slice(session.indexOf(":") + 1))
	)
		return;
	if (!cwd) return createHash("sha256").update(fields.join(" ")).digest("hex");
	try {
		const directory = realpathSync(cwd);
		if (fields.length < 7 || processCwd(pid) !== directory) return;
		// exec replaces argv, but preserves the process birth, group and cwd.
		return `v2:${createHash("sha256")
			.update(JSON.stringify([fields.slice(0, 6), session, directory]))
			.digest("hex")}`;
	} catch {
		return;
	}
}
export function reapLaneProcess(
	pid: number,
	session: string,
	identity: string,
	cwd?: string,
): boolean {
	if (identity.startsWith("v2:") && !cwd) return false;
	if (
		laneProcessIdentity(
			pid,
			session,
			identity.startsWith("v2:") ? cwd : undefined,
		) !== identity
	)
		return false;
	try {
		process.kill(-pid, "SIGTERM");
		return true;
	} catch {
		return false;
	}
}

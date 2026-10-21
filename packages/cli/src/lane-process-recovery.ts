import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

/** A PID alone can be reused; bind recovery to its native session and OS start time. */
export function laneProcessIdentity(
	pid: number,
	session: string,
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
	return createHash("sha256").update(fields.join(" ")).digest("hex");
}
export function reapLaneProcess(
	pid: number,
	session: string,
	identity: string,
): boolean {
	if (laneProcessIdentity(pid, session) !== identity) return false;
	try {
		process.kill(-pid, "SIGTERM");
		return true;
	} catch {
		return false;
	}
}

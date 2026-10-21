import { expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { laneProcessIdentity, reapLaneProcess } from "./lane-process-recovery";
it("reaps only the original process group bound to the native session and start identity", async () => {
	const id = "11111111-1111-4111-8111-111111111111";
	const child = spawn(
		process.execPath,
		["-e", "console.log('ready');setInterval(()=>{},1000)", id],
		{ detached: true, stdio: ["ignore", "pipe", "ignore"] },
	);
	try {
		await once(child.stdout!, "data");
		const identity = laneProcessIdentity(child.pid!, `codex:${id}`)!;
		expect(identity).toMatch(/^[a-f0-9]{64}$/);
		expect(laneProcessIdentity(child.pid!, "codex:other")).toBeUndefined();
		expect(
			reapLaneProcess(child.pid!, `codex:${id}`, "different-start-time"),
		).toBe(false);
		const exited = once(child, "exit");
		expect(reapLaneProcess(child.pid!, `codex:${id}`, identity)).toBe(true);
		await exited;
	} finally {
		try {
			process.kill(-child.pid!, "SIGTERM");
		} catch {}
	}
});

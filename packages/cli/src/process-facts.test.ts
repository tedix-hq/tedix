import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import {
	kernelProcessCwd,
	kernelProcessFacts,
	kernelProcessTable,
} from "./process-facts";

const supported = process.platform === "linux" || process.platform === "darwin";

describe.skipIf(!supported)("kernel process facts", () => {
	test("reports this process's group, birth, name and directory", () => {
		const facts = kernelProcessFacts(process.pid)!;
		expect(facts.pid).toBe(process.pid);
		expect(facts.ppid).toBe(process.ppid);
		expect(facts.pgid).toBeGreaterThan(0);
		expect(facts.start.length).toBeGreaterThan(0);
		expect(facts.comm.length).toBeGreaterThan(0);
		expect(facts.cwd).toBe(realpathSync(process.cwd()));
		expect(kernelProcessCwd(process.pid)).toBe(facts.cwd);
	});

	test("lists the process table without spawning", () => {
		const table = kernelProcessTable()!;
		expect(table.length).toBeGreaterThan(10);
		expect(table.find((row) => row.pid === process.pid)?.ppid).toBe(
			process.ppid,
		);
	});

	test("reports a spawned child's group and arguments", async () => {
		const { spawn } = await import("node:child_process");
		const id = "33333333-3333-4333-8333-333333333333";
		const child = spawn(
			process.execPath,
			["-e", "setInterval(()=>{},1000)", id],
			{ detached: true, stdio: "ignore" },
		);
		const pid = child.pid!;
		try {
			await new Promise((resolve) => setTimeout(resolve, 300));
			const facts = kernelProcessFacts(pid)!;
			expect(facts.pgid).toBe(pid);
			if (process.platform === "linux") expect(facts.argv).toContain(id);
		} finally {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {}
		}
	});
});

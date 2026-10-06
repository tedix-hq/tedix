import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireCredentialLock, credentialLockPath } from "./credential-lock";

function configDir(): string {
	return mkdtempSync(join(tmpdir(), "tedix-credential-lock-"));
}

/** One attempt, no waiting: the lock is either free now or refused. */
function tryLock(workspace: string, dir: string) {
	return acquireCredentialLock(workspace, { configDir: dir, waitMs: 0 });
}

describe("credential renewal lock", () => {
	// The property the lock exists for: two processes cannot renew at once, which
	// is what makes the authorization server treat the second token as replay and
	// invalidate the whole family.
	test("a second holder is refused while the first holds it", async () => {
		const dir = configDir();
		const first = await tryLock("tedix", dir);
		expect(first).not.toBeNull();
		expect(await tryLock("tedix", dir)).toBeNull();
		first?.release();
		const third = await tryLock("tedix", dir);
		expect(third).not.toBeNull();
		third?.release();
	});

	test("different workspaces do not block each other", async () => {
		const dir = configDir();
		const a = await tryLock("tedix", dir);
		const b = await tryLock("acme", dir);
		expect(a).not.toBeNull();
		expect(b).not.toBeNull();
		a?.release();
		b?.release();
	});

	test("a killed owner is recovered without stealing a live owner", async () => {
		const dir = configDir();
		const modulePath = new URL("./credential-lock.ts", import.meta.url)
			.pathname;
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				`import { acquireCredentialLock } from ${JSON.stringify(modulePath)}; await acquireCredentialLock("tedix", { configDir: ${JSON.stringify(dir)}, waitMs: 0 }); console.log("held"); setInterval(() => {}, 1000);`,
			],
			{ stdout: "pipe" },
		);
		const reader = child.stdout.getReader();
		await reader.read();
		expect(await tryLock("tedix", dir)).toBeNull();
		child.kill("SIGKILL");
		await child.exited;
		const recovered = await acquireCredentialLock("tedix", {
			configDir: dir,
			waitMs: 1000,
			pollMs: 5,
		});
		expect(recovered).not.toBeNull();
		recovered?.release();
	});

	test("release is idempotent and cannot release a successor", async () => {
		const dir = configDir();
		const first = await tryLock("tedix", dir);
		first?.release();
		const successor = await tryLock("tedix", dir);
		first?.release();
		expect(await tryLock("tedix", dir)).toBeNull();
		successor?.release();
		expect(readdirSync(credentialLockPath("tedix", dir))).toEqual([]);
	});

	test("workspace names that sanitize identically acquire simultaneously", async () => {
		const dir = configDir();
		expect(credentialLockPath("a/b", dir)).not.toBe(
			credentialLockPath("a_b", dir),
		);
		const a = await tryLock("a/b", dir);
		let b: Awaited<ReturnType<typeof acquireCredentialLock>> = null;
		try {
			b = await acquireCredentialLock("a_b", {
				configDir: dir,
				waitMs: 30,
				pollMs: 1,
			});
			expect(a).not.toBeNull();
			expect(b).not.toBeNull();
			expect(await tryLock("a/b", dir)).toBeNull();
			expect(await tryLock("a_b", dir)).toBeNull();
		} finally {
			a?.release();
			b?.release();
		}
	});

	// A workspace name is stored config, not a literal path component.
	test("a workspace name cannot escape the lock directory", () => {
		const dir = configDir();
		const path = credentialLockPath("../../etc/evil", dir);
		expect(path.startsWith(join(dir, "locks"))).toBe(true);
		expect(path).not.toContain("..");
	});

	// Bounded waiting must fail closed rather than permit concurrent renewal.
	test("waiting gives up and returns null instead of blocking", async () => {
		const dir = configDir();
		const held = await tryLock("tedix", dir);
		let slept = 0;
		const waited = await acquireCredentialLock("tedix", {
			configDir: dir,
			waitMs: 30,
			pollMs: 10,
			sleep: async (ms) => {
				slept += ms;
			},
		});
		expect(waited).toBeNull();
		expect(slept).toBeGreaterThan(0);
		held?.release();
	});

	test("waiting succeeds once the holder releases", async () => {
		const dir = configDir();
		const held = await tryLock("tedix", dir);
		const waited = await acquireCredentialLock("tedix", {
			configDir: dir,
			waitMs: 1_000,
			pollMs: 5,
			sleep: async () => {
				held?.release();
			},
		});
		expect(waited).not.toBeNull();
		waited?.release();
	});
});

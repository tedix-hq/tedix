import { execFileSync } from "node:child_process";
import {
	mkdtempSync,
	readFileSync,
	writeFileSync,
	rmSync,
	renameSync,
	existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	persistWorkstationRecoveryCheckpoint as persist,
	restoreWorkstationRecoveryCheckpoint as restore,
	type WithLockedCheckpoint,
	type LockedCheckpointNative,
} from "./recovery-checkpoint";

// The real deadline helper also imports the Worker-only Sandbox SDK. These
// tests execute Git locally and do not invoke the native process wait boundary.
vi.mock("@cloudflare/sandbox", () => ({
	ProcessWaitTimeoutError: class extends Error {},
}));

const provenance = {
	taskId: "task",
	workstationId: "workstation",
	leaseId: "lease",
	containerPlacementId: "placement",
};
const env = { ...process.env };
for (const key of Object.keys(env))
	if (key.startsWith("GIT_")) Reflect.deleteProperty(env, key);
function run(cwd: string, command: string): string {
	return execFileSync("bash", ["-c", command], {
		cwd,
		env,
		encoding: "utf8",
		maxBuffer: 24 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	});
}
function storageFixture() {
	const objects = new Map<string, { text: string; etag: string }>();
	let version = 0;
	const storage = {
		get: vi.fn(async (key: string) => {
			const value = objects.get(key);
			return value ? { etag: value.etag, text: async () => value.text } : null;
		}),
		put: vi.fn(
			async (
				key: string,
				text: string,
				options?: {
					onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
				},
			) => {
				const previous = objects.get(key);
				if (
					(options?.onlyIf?.etagMatches !== undefined &&
						previous?.etag !== options.onlyIf.etagMatches) ||
					(options?.onlyIf?.etagDoesNotMatch === "*" && previous)
				)
					return null;
				const value = { text, etag: `version-${++version}` };
				objects.set(key, value);
				return { etag: value.etag };
			},
		),
	};
	return { objects, storage };
}
function nativeFixture(cwd: string) {
	let locked = false;
	const native: LockedCheckpointNative = {
		exec: vi.fn(async (command) => {
			expect(locked).toBe(true);
			try {
				return { exitCode: 0, stdout: run(cwd, command), stderr: "" };
			} catch (error) {
				const e = error as { status: number; stdout: string; stderr: string };
				return { exitCode: e.status, stdout: e.stdout, stderr: e.stderr };
			}
		}),
		writeFile: vi.fn(async (path, content) => {
			expect(locked).toBe(true);
			writeFileSync(path, content);
		}),
	};
	const withLockedCheckpoint: WithLockedCheckpoint = async (operation) => {
		expect(locked).toBe(false);
		locked = true;
		try {
			return await operation(native);
		} finally {
			locked = false;
		}
	};
	return { native, withLockedCheckpoint };
}
function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "checkpoint-git-"));
	const source = join(directory, "source");
	const target = join(directory, "target");
	run(directory, "git init -q source");
	for (const [path, text] of Object.entries({
		"file.txt": "original\n",
		"delete.txt": "delete me\n",
		"rename.txt": "rename me\n",
		".gitignore": "ignored\n",
	}))
		writeFileSync(join(source, path), text);
	writeFileSync(join(source, "binary.dat"), Buffer.from([0, 1, 2, 255]));
	run(
		source,
		"git config user.name Checkpoint; git config user.email checkpoint@example.test; git add .; git commit -qm initial",
	);
	const preparedStartSha = run(source, "git rev-parse HEAD").trim();
	run(directory, "git clone --quiet --no-local source target");
	const store = storageFixture();
	const producer = nativeFixture(source);
	const consumer = nativeFixture(target);
	const common = {
		manifestKey: "task/active.json",
		storage: store.storage,
		workdir: "/repo",
		preparedStartSha,
		provenance,
	};
	return {
		directory,
		source,
		target,
		store,
		producer,
		consumer,
		preparedStartSha,
		capture: {
			...common,
			...producer,
			patchPrefix: "task/patches",
			reason: "terminal-observation",
		},
		restore: {
			...common,
			...consumer,
			provenance: {
				...provenance,
				leaseId: "replacement",
				containerPlacementId: "new-placement",
			},
		},
		cleanup: () => rmSync(directory, { recursive: true, force: true }),
		manifest: () => JSON.parse(store.objects.get(common.manifestKey)!.text),
	};
}
async function usingFixture(
	operation: (f: ReturnType<typeof fixture>) => Promise<void>,
) {
	const f = fixture();
	try {
		await operation(f);
	} finally {
		f.cleanup();
	}
}
function commit(source: string, text: string): string {
	writeFileSync(join(source, "file.txt"), text);
	run(source, "git add file.txt; git commit -qm saved");
	return run(source, "git rev-parse HEAD").trim();
}

describe("Git checkpoint preservation", () => {
	it("restores unpublished ancestry plus binary, rename, deletion and untracked bytes", async () =>
		usingFixture(async (f) => {
			const first = commit(f.source, "first commit\n");
			const head = commit(f.source, "second commit\n");
			writeFileSync(join(f.source, "file.txt"), "dirty after commits\n");
			writeFileSync(join(f.source, "new ' file.txt"), "new\n");
			writeFileSync(join(f.source, "binary.dat"), Buffer.from([0, 99, 255, 7]));
			writeFileSync(join(f.source, "new.bin"), Buffer.from([0, 200, 9]));
			writeFileSync(join(f.source, "-option.txt"), "literal filename\n");
			writeFileSync(join(f.source, "ignored"), "excluded\n");
			renameSync(join(f.source, "rename.txt"), join(f.source, "renamed.txt"));
			rmSync(join(f.source, "delete.txt"));
			expect(await persist(f.capture)).toMatchObject({
				status: "persisted",
				baseCommit: head,
				provenance,
			});
			expect(f.producer.native.exec).toHaveBeenCalledTimes(1);
			expect(await restore(f.restore)).toMatchObject({
				status: "restored",
				baseCommit: head,
			});
			expect(run(f.target, "git rev-parse HEAD").trim()).toBe(head);
			expect(run(f.target, "git rev-parse HEAD^").trim()).toBe(first);
			for (const path of [
				"file.txt",
				"new ' file.txt",
				"-option.txt",
				"binary.dat",
				"new.bin",
				"renamed.txt",
			])
				expect(readFileSync(join(f.target, path))).toEqual(
					readFileSync(join(f.source, path)),
				);
			for (const path of ["delete.txt", "rename.txt", "ignored"])
				expect(existsSync(join(f.target, path))).toBe(false);
			writeFileSync(join(f.target, "file.txt"), "later edit\n");
			expect((await restore(f.restore)).status).toBe("already_restored");
			expect(readFileSync(join(f.target, "file.txt"), "utf8")).toBe(
				"later edit\n",
			);
		}));
	it("preserves a clean unpublished commit", async () =>
		usingFixture(async (f) => {
			const head = commit(f.source, "committed\n");
			expect(await persist(f.capture)).toMatchObject({
				status: "persisted",
				baseCommit: head,
				bytes: 0,
			});
			expect(f.manifest().bundle).toBeDefined();
			expect((await restore(f.restore)).status).toBe("restored");
			expect(run(f.target, "git rev-parse HEAD").trim()).toBe(head);
			expect(run(f.target, "git status --porcelain")).toBe("");
		}));
	it("reads existing version-one patch-only artifacts through the same parser", async () =>
		usingFixture(async (f) => {
			writeFileSync(join(f.source, "file.txt"), "old persisted patch\n");
			expect((await persist(f.capture)).status).toBe("persisted");
			const manifest = f.manifest();
			delete manifest.provenance;
			delete manifest.preparedStartSha;
			const patch = Buffer.from(
				f.store.objects.get(manifest.patchKey)!.text,
				"base64",
			).toString("utf8");
			const digest = await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(patch),
			);
			const hash = Array.from(new Uint8Array(digest), (byte) =>
				byte.toString(16).padStart(2, "0"),
			).join("");
			manifest.patchKey = `task/patches/${hash}.patch`;
			delete manifest.patchEncoding;
			await f.store.storage.put(manifest.patchKey, patch);
			await f.store.storage.put(
				f.capture.manifestKey,
				JSON.stringify(manifest),
			);
			expect((await restore(f.restore)).status).toBe("restored");
			expect(readFileSync(join(f.target, "file.txt"), "utf8")).toBe(
				"old persisted patch\n",
			);
		}));
	it("publishes a conditional clean tombstone and retains earlier payloads", async () =>
		usingFixture(async (f) => {
			writeFileSync(join(f.source, "file.txt"), "saved\n");
			const saved = await persist(f.capture);
			const previous = f.store.objects.get(f.capture.manifestKey)!;
			writeFileSync(join(f.source, "file.txt"), "original\n");
			expect((await persist(f.capture)).status).toBe("clean");
			expect(f.manifest().clean).toBe(true);
			expect(f.store.objects.has(saved.patchKey!)).toBe(true);
			expect(f.store.storage.put).toHaveBeenLastCalledWith(
				f.capture.manifestKey,
				expect.any(String),
				expect.objectContaining({ onlyIf: { etagMatches: previous.etag } }),
			);
			expect((await restore(f.restore)).status).toBe("clean");
			expect(f.consumer.native.exec).not.toHaveBeenCalled();
		}));
	it.each([
		[false, false],
		[true, false],
		[false, true],
		[true, true],
	])(
		"stale capture cannot replace a winner (clean=%s existing=%s)",
		async (clean, existing) =>
			usingFixture(async (f) => {
				if (existing) expect((await persist(f.capture)).status).toBe("clean");
				if (!clean) writeFileSync(join(f.source, "file.txt"), "stale\n");
				let winner: string | undefined;
				const withLockedCheckpoint: WithLockedCheckpoint = async (
					operation,
				) => {
					const value = await f.producer.withLockedCheckpoint(operation);
					writeFileSync(join(f.source, "file.txt"), "winner\n");
					expect((await persist(f.capture)).status).toBe("persisted");
					winner = f.store.objects.get(f.capture.manifestKey)?.text;
					return value;
				};
				expect(
					await persist({ ...f.capture, withLockedCheckpoint }),
				).toMatchObject({
					status: "failed",
					error: expect.stringContaining("conflict"),
				});
				expect(f.store.objects.get(f.capture.manifestKey)?.text).toBe(winner);
				expect((await restore(f.restore)).status).toBe("restored");
				expect(readFileSync(join(f.target, "file.txt"), "utf8")).toBe(
					"winner\n",
				);
			}),
	);
	it("retains last good checkpoint on upload or generation validation failure", async () =>
		usingFixture(async (f) => {
			writeFileSync(join(f.source, "file.txt"), "last good\n");
			await persist(f.capture);
			const previous = f.store.objects.get(f.capture.manifestKey)?.text;
			writeFileSync(join(f.source, "file.txt"), "new\n");
			f.store.storage.put.mockRejectedValueOnce(new Error("R2 upload failed"));
			expect((await persist(f.capture)).status).toBe("failed");
			expect(f.store.objects.get(f.capture.manifestKey)?.text).toBe(previous);
			const withLockedCheckpoint: WithLockedCheckpoint = async (operation) => {
				await f.producer.withLockedCheckpoint(operation);
				throw new Error("original generation changed");
			};
			const calls = f.store.storage.put.mock.calls.length;
			expect(
				await persist({ ...f.capture, withLockedCheckpoint }),
			).toMatchObject({
				status: "failed",
				error: "original generation changed",
			});
			expect(f.store.storage.put.mock.calls.length).toBe(calls);
			expect(f.store.objects.get(f.capture.manifestKey)?.text).toBe(previous);
		}));
	it.each(["patch", "bundle", "missing", "oversized", "identity", "manifest"])(
		"rejects %s corruption before native restore",
		async (kind) =>
			usingFixture(async (f) => {
				commit(f.source, "unpublished\n");
				writeFileSync(join(f.source, "file.txt"), "dirty\n");
				await persist(f.capture);
				const manifest = f.manifest();
				if (kind === "patch")
					await f.store.storage.put(manifest.patchKey, "wrong bytes");
				if (kind === "bundle")
					await f.store.storage.put(manifest.bundle.key, "AAAA");
				if (kind === "missing") f.store.objects.delete(manifest.bundle.key);
				if (kind === "oversized") manifest.bytes = 8 * 1024 * 1024 + 1;
				if (kind === "identity") manifest.provenance.taskId = "other-task";
				if (kind === "manifest") manifest.version = 99;
				await f.store.storage.put(
					f.capture.manifestKey,
					JSON.stringify(manifest),
				);
				expect((await restore(f.restore)).status).toBe("failed");
				expect(f.consumer.native.exec).not.toHaveBeenCalled();
				expect(run(f.target, "git rev-parse HEAD").trim()).toBe(
					f.preparedStartSha,
				);
			}),
	);
	it("refuses dirty work and incompatible newer preparation without changing checkout", async () =>
		usingFixture(async (f) => {
			commit(f.source, "saved\n");
			await persist(f.capture);
			writeFileSync(join(f.target, "file.txt"), "user work\n");
			expect(await restore(f.restore)).toMatchObject({
				status: "failed",
				error: expect.stringContaining("dirty work"),
			});
			expect(readFileSync(join(f.target, "file.txt"), "utf8")).toBe(
				"user work\n",
			);
			run(
				f.target,
				"git config user.name Checkpoint; git config user.email checkpoint@example.test; git add file.txt; git commit -qm different",
			);
			const newer = run(f.target, "git rev-parse HEAD").trim();
			expect(
				await restore({ ...f.restore, preparedStartSha: newer }),
			).toMatchObject({
				status: "failed",
				error: expect.stringContaining("incompatible"),
			});
			expect(run(f.target, "git rev-parse HEAD").trim()).toBe(newer);
		}));
	it("fails on unavailable bundle prerequisites without fetching network history", async () =>
		usingFixture(async (f) => {
			commit(f.source, "saved\n");
			await persist(f.capture);
			rmSync(f.target, { recursive: true, force: true });
			run(f.directory, "git init -q target");
			writeFileSync(join(f.target, "unrelated"), "different\n");
			run(
				f.target,
				"git add .; git -c user.name=Checkpoint -c user.email=checkpoint@example.test commit -qm unrelated",
			);
			const head = run(f.target, "git rev-parse HEAD").trim();
			expect(
				(await restore({ ...f.restore, preparedStartSha: head })).status,
			).toBe("failed");
			expect(run(f.target, "git rev-parse HEAD").trim()).toBe(head);
			expect(readFileSync(join(f.target, "unrelated"), "utf8")).toBe(
				"different\n",
			);
		}));
	it("bounds capture output and preserves prior checkpoint", async () =>
		usingFixture(async (f) => {
			writeFileSync(join(f.source, "file.txt"), "saved\n");
			await persist(f.capture);
			const previous = f.store.objects.get(f.capture.manifestKey)?.text;
			writeFileSync(
				join(f.source, "huge.txt"),
				"x".repeat(8 * 1024 * 1024 + 1),
			);
			expect(await persist(f.capture)).toMatchObject({
				status: "failed",
				error: expect.stringContaining("exceeds"),
			});
			expect(f.store.objects.get(f.capture.manifestKey)?.text).toBe(previous);
		}));
	it("distinguishes unavailable, missing and invalid metadata", async () =>
		usingFixture(async (f) => {
			expect((await persist({ ...f.capture, storage: null })).status).toBe(
				"unavailable",
			);
			expect((await restore(f.restore)).status).toBe("missing");
			await f.store.storage.put(f.capture.manifestKey, "broken");
			expect((await restore(f.restore)).status).toBe("failed");
			expect((await persist(f.capture)).status).toBe("failed");
			expect(f.producer.native.exec).not.toHaveBeenCalled();
		}));
	it("preserves a checkpoint when a hash-addressed payload already exists with corrupt bytes", async () =>
		usingFixture(async (f) => {
			writeFileSync(join(f.source, "file.txt"), "saved\n");
			const saved = await persist(f.capture);
			const previous = f.store.objects.get(f.capture.manifestKey)?.text;
			await f.store.storage.put(saved.patchKey!, "corrupt");
			expect(await persist(f.capture)).toMatchObject({
				status: "failed",
				error: expect.stringContaining("immutable"),
			});
			expect(f.store.objects.get(f.capture.manifestKey)?.text).toBe(previous);
		}));
	it("round trips unpublished commits from a shallow prepared checkout", async () =>
		usingFixture(async (f) => {
			rmSync(f.target, { recursive: true, force: true });
			run(f.directory, `git clone --quiet --depth=1 file://${f.source} target`);
			expect(
				run(f.target, "git rev-parse --is-shallow-repository").trim(),
			).toBe("true");
			run(
				f.target,
				"git config user.name Checkpoint; git config user.email checkpoint@example.test",
			);
			const head = commit(f.target, "shallow local commit\n");
			const captured = await persist({
				...f.capture,
				withLockedCheckpoint: f.consumer.withLockedCheckpoint,
			});
			expect(captured).toMatchObject({ status: "persisted", baseCommit: head });
			expect(
				await restore({
					...f.restore,
					withLockedCheckpoint: f.producer.withLockedCheckpoint,
				}),
			).toMatchObject({ status: "restored", baseCommit: head });
			expect(run(f.source, "git rev-parse HEAD").trim()).toBe(head);
		}));
	it("bounds unresponsive scratch staging before any protected restore", async () =>
		usingFixture(async (f) => {
			writeFileSync(join(f.source, "file.txt"), "saved\n");
			await persist(f.capture);
			vi.useFakeTimers();
			try {
				let writeStarted = false;
				const withLockedCheckpoint: WithLockedCheckpoint = (operation) =>
					f.consumer.withLockedCheckpoint((native) =>
						operation({
							...native,
							writeFile: () => {
								writeStarted = true;
								return new Promise<never>(() => {});
							},
						}),
					);
				const promise = restore({ ...f.restore, withLockedCheckpoint });
				await vi.waitFor(() => expect(writeStarted).toBe(true));
				await vi.advanceTimersByTimeAsync(60_001);
				expect(await promise).toMatchObject({
					status: "failed",
					error: expect.stringContaining("checkpoint write observation"),
				});
				expect(run(f.target, "git status --porcelain")).toBe("");
			} finally {
				vi.useRealTimers();
			}
		}));

	it("preserves non-UTF-8 tracked text bytes without re-encoding", async () =>
		usingFixture(async (f) => {
			const dirty = Buffer.from([0x61, 0xff, 0x0a]);
			writeFileSync(join(f.source, "file.txt"), dirty);
			expect((await persist(f.capture)).status).toBe("persisted");
			expect((await restore(f.restore)).status).toBe("restored");
			expect(readFileSync(join(f.target, "file.txt"))).toEqual(dirty);
		}));
	it("refuses ignored-file collisions before changing HEAD or user bytes", async () =>
		usingFixture(async (f) => {
			const head = commit(f.source, "saved commit\n");
			writeFileSync(join(f.source, "ignored"), "captured file\n");
			run(f.source, "git add -f ignored");
			expect((await persist(f.capture)).status).toBe("persisted");
			writeFileSync(join(f.target, "ignored"), "user ignored bytes\n");
			expect((await restore(f.restore)).status).toBe("failed");
			expect(run(f.target, "git rev-parse HEAD").trim()).toBe(
				f.preparedStartSha,
			);
			expect(readFileSync(join(f.target, "ignored"), "utf8")).toBe(
				"user ignored bytes\n",
			);
			expect(head).not.toBe(f.preparedStartSha);
		}));
	it("validates the caller boundary even when a clean tombstone needs no native mutation", async () =>
		usingFixture(async (f) => {
			expect((await persist(f.capture)).status).toBe("clean");
			const withLockedCheckpoint: WithLockedCheckpoint = async () => {
				throw new Error("replacement generation unavailable");
			};
			expect(
				await restore({ ...f.restore, withLockedCheckpoint }),
			).toMatchObject({
				status: "failed",
				error: "replacement generation unavailable",
			});
		}));

	it("reports cleanup failure without pretending an applied restore rolled back", async () =>
		usingFixture(async (f) => {
			writeFileSync(join(f.source, "file.txt"), "saved\n");
			await persist(f.capture);
			const withLockedCheckpoint: WithLockedCheckpoint = (operation) =>
				f.consumer.withLockedCheckpoint((native) =>
					operation({
						...native,
						exec: async (command, options) => {
							const result = await native.exec(command, options);
							return command.includes("echo restored")
								? { ...result, exitCode: 1, stderr: "cleanup unavailable" }
								: result;
						},
					}),
				);
			expect(
				await restore({ ...f.restore, withLockedCheckpoint }),
			).toMatchObject({
				status: "failed",
				error: expect.stringContaining("cleanup unavailable"),
			});
			expect(readFileSync(join(f.target, "file.txt"), "utf8")).toBe("saved\n");
			expect((await restore(f.restore)).status).toBe("already_restored");
		}));

	it("preserves the native capture identity when observation is unknown", async () =>
		usingFixture(async (f) => {
			const { WorkstationDispatchUnknownError } =
				await import("./computer-body");
			const withLockedCheckpoint: WithLockedCheckpoint = (operation) =>
				operation({
					exec: async () => {
						throw new WorkstationDispatchUnknownError("capture-original");
					},
					writeFile: async () => {},
				});
			expect(
				await persist({ ...f.capture, withLockedCheckpoint }),
			).toMatchObject({
				status: "failed",
				executionId: "capture-original",
				observation: "unknown",
			});
			expect(f.store.objects.size).toBe(0);
		}));
});

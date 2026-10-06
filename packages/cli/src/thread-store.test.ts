import { describe, expect, test } from "bun:test";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listThreads, resolveThread, setThread } from "./thread-store";

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`tedix-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

// Capture console.error output for the duration of `fn`.
function captureErrors<T>(fn: (errors: string[]) => T): { errors: string[] } {
	const errors: string[] = [];
	const origError = console.error;
	console.error = (...args: unknown[]) => {
		errors.push(String(args[0]));
	};
	try {
		fn(errors);
	} finally {
		console.error = origError;
	}
	return { errors };
}

describe("thread-store", () => {
	test("resolveThread returns null when file does not exist", () => {
		const dir = makeTmpDir();
		expect(
			resolveThread("nope", { configDir: join(dir, "missing") }),
		).toBeNull();
	});

	test("set/resolve round-trips a named alias", () => {
		const dir = makeTmpDir();
		setThread("review", "conv_abc123", { configDir: dir });
		expect(resolveThread("review", { configDir: dir })).toBe("conv_abc123");
	});

	test("setThread upserts an existing name", () => {
		const dir = makeTmpDir();
		setThread("review", "conv_old", { configDir: dir });
		setThread("review", "conv_new", { configDir: dir });
		expect(resolveThread("review", { configDir: dir })).toBe("conv_new");
	});

	test("multiple names coexist", () => {
		const dir = makeTmpDir();
		setThread("review", "conv_1", { configDir: dir });
		setThread("deploy", "conv_2", { configDir: dir });
		setThread("triage", "conv_3", { configDir: dir });
		expect(resolveThread("review", { configDir: dir })).toBe("conv_1");
		expect(resolveThread("deploy", { configDir: dir })).toBe("conv_2");
		expect(resolveThread("triage", { configDir: dir })).toBe("conv_3");
	});

	test("listThreads is sorted by name", () => {
		const dir = makeTmpDir();
		setThread("zeta", "conv_z", { configDir: dir });
		setThread("alpha", "conv_a", { configDir: dir });
		setThread("mike", "conv_m", { configDir: dir });
		expect(listThreads({ configDir: dir })).toEqual([
			{ name: "alpha", conversationId: "conv_a" },
			{ name: "mike", conversationId: "conv_m" },
			{ name: "zeta", conversationId: "conv_z" },
		]);
	});

	test("listThreads returns empty array when no file exists", () => {
		const dir = makeTmpDir();
		expect(listThreads({ configDir: join(dir, "missing") })).toEqual([]);
	});

	test("corrupt JSON → resolve returns null and emits a diagnostic", () => {
		const dir = makeTmpDir();
		writeFileSync(join(dir, "threads.json"), "{ this is not json");
		const { errors } = captureErrors(() => {
			expect(resolveThread("review", { configDir: dir })).toBeNull();
		});
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]).toContain("threads.json is corrupt");
	});

	test("non-object JSON → empty store and a diagnostic", () => {
		const dir = makeTmpDir();
		writeFileSync(join(dir, "threads.json"), JSON.stringify([1, 2, 3]));
		const { errors } = captureErrors(() => {
			expect(listThreads({ configDir: dir })).toEqual([]);
		});
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]).toContain("threads.json is corrupt");
	});

	test("non-string thread entries are dropped, valid siblings survive", () => {
		const dir = makeTmpDir();
		writeFileSync(
			join(dir, "threads.json"),
			JSON.stringify({
				version: 1,
				threads: { good: "conv_ok", bad: 42, alsoBad: null },
			}),
		);
		expect(resolveThread("good", { configDir: dir })).toBe("conv_ok");
		expect(resolveThread("bad", { configDir: dir })).toBeNull();
		expect(listThreads({ configDir: dir })).toEqual([
			{ name: "good", conversationId: "conv_ok" },
		]);
	});

	test("TEDIX_CONFIG_DIR env var is honored", () => {
		const dir = makeTmpDir();
		const prev = process.env.TEDIX_CONFIG_DIR;
		process.env.TEDIX_CONFIG_DIR = dir;
		try {
			setThread("review", "conv_env", {});
			expect(resolveThread("review", {})).toBe("conv_env");
		} finally {
			if (prev === undefined) delete process.env.TEDIX_CONFIG_DIR;
			else process.env.TEDIX_CONFIG_DIR = prev;
		}
	});

	test("configDir takes precedence over TEDIX_CONFIG_DIR", () => {
		const envDir = makeTmpDir();
		const optDir = makeTmpDir();
		const prev = process.env.TEDIX_CONFIG_DIR;
		process.env.TEDIX_CONFIG_DIR = envDir;
		try {
			setThread("review", "conv_opt", { configDir: optDir });
			// Written to optDir, not envDir.
			expect(resolveThread("review", { configDir: optDir })).toBe("conv_opt");
			expect(resolveThread("review", {})).toBeNull();
		} finally {
			if (prev === undefined) delete process.env.TEDIX_CONFIG_DIR;
			else process.env.TEDIX_CONFIG_DIR = prev;
		}
	});

	test("homeDir is honored when no configDir/env is set", () => {
		const home = makeTmpDir();
		const prev = process.env.TEDIX_CONFIG_DIR;
		delete process.env.TEDIX_CONFIG_DIR;
		try {
			setThread("review", "conv_home", { homeDir: home });
			expect(resolveThread("review", { homeDir: home })).toBe("conv_home");
			// Stored under <home>/.tedix/threads.json.
			expect(() =>
				statSync(join(home, ".tedix", "threads.json")),
			).not.toThrow();
		} finally {
			if (prev === undefined) delete process.env.TEDIX_CONFIG_DIR;
			else process.env.TEDIX_CONFIG_DIR = prev;
		}
	});

	test("store file and dir are written with hardened perms", () => {
		const dir = makeTmpDir();
		setThread("review", "conv_x", { configDir: dir });
		const fileMode = statSync(join(dir, "threads.json")).mode & 0o777;
		const dirMode = statSync(dir).mode & 0o777;
		expect(fileMode).toBe(0o600);
		expect(dirMode).toBe(0o700);
	});
});

test("same alias is isolated by exact organization and does not adopt old global names", () => {
	const configDir = makeTmpDir();
	setThread("review", "legacy", { configDir });
	const first = { configDir, organizationId: "org-a" };
	const second = { configDir, organizationId: "org-b" };
	expect(resolveThread("review", first)).toBeNull();
	setThread("review", "conversation-a", first);
	setThread("review", "conversation-b", second);
	expect(resolveThread("review", first)).toBe("conversation-a");
	expect(listThreads(second)).toEqual([
		{ name: "review", conversationId: "conversation-b" },
	]);
	expect(listThreads({ configDir })).toEqual([
		{ name: "review", conversationId: "legacy" },
	]);
});

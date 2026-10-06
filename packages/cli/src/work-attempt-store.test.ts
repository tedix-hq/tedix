import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileWorkAttemptStore } from "./work-attempt-store";

const KEY = {
	workspace: "tedix",
	actor: "credential",
	agentSession: "codex:session-a",
	workItemId: "11111111-2222-3333-4444-555555555555",
};

describe("work attempt store", () => {
	test("persists and fences attempt ids by actor and session", () => {
		const dir = mkdtempSync(join(tmpdir(), "tedix-work-attempts-"));
		const store = createFileWorkAttemptStore({ configDir: dir });
		store.set(KEY, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
		expect(createFileWorkAttemptStore({ configDir: dir }).get(KEY)).toBe(
			"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
		);
		expect(store.get({ ...KEY, agentSession: "codex:session-b" })).toBeNull();
		expect(store.remove(KEY, "wrong-attempt")).toBe(false);
		expect(store.remove(KEY, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")).toBe(
			true,
		);
	});

	test("writes private capability state", () => {
		const dir = mkdtempSync(join(tmpdir(), "tedix-work-attempt-mode-"));
		const store = createFileWorkAttemptStore({ configDir: dir });
		store.set(KEY, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
		const stateDir = join(dir, "work-attempts");
		const [file] = readdirSync(stateDir);
		expect(statSync(stateDir).mode & 0o777).toBe(0o700);
		expect(statSync(join(stateDir, file!)).mode & 0o777).toBe(0o600);
	});
});

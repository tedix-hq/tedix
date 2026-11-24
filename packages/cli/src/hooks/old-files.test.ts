import { expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OLD_FILE_MS, removeOldHookFiles } from "./old-files";

it("deletes only hook files older than 30 days, at most once a day", () => {
	const root = mkdtempSync(join(tmpdir(), "old-files-"));
	const env = { TEDIX_CONFIG_DIR: root };
	mkdirSync(join(root, "hook-cache"));
	const file = (name: string, ageMs: number) => {
		const path = join(root, name);
		writeFileSync(path, "");
		const at = (Date.now() - ageMs) / 1000;
		utimesSync(path, at, at);
		return path;
	};
	const old = file("hook-cache/old.json", OLD_FILE_MS + 60_000);
	const fresh = file("hook-cache/fresh.json", OLD_FILE_MS - 60_000);
	const login = file("auth.json", OLD_FILE_MS * 2);
	expect(removeOldHookFiles(env)).toBe(1);
	expect([old, fresh, login].map((path) => existsSync(path))).toEqual([
		false,
		true,
		true,
	]);
	file("hook-cache/later.json", OLD_FILE_MS * 2);
	expect(removeOldHookFiles(env)).toBe(0);
});

import { afterEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moveAppFolders, userDataFolder } from "./app-folders";

const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0))
		rmSync(home, { recursive: true, force: true });
});

function oldMac() {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "tedix-folders-")));
	homes.push(home);
	const appData = join(home, "Library", "Application Support");
	const old = join(appData, "@tedix", "desktop");
	mkdirSync(join(old, "Partitions"), { recursive: true });
	writeFileSync(join(old, "Partitions", "Cookies"), "signed in");
	mkdirSync(join(old, "cli"));
	writeFileSync(join(old, "cli", "tedix"), "tool");
	mkdirSync(join(home, ".local", "bin"), { recursive: true });
	symlinkSync(join(old, "cli", "tedix"), join(home, ".local", "bin", "tedix"));
	mkdirSync(join(home, "Library", "Logs", "Tedix"), { recursive: true });
	writeFileSync(join(home, "Library", "Logs", "Tedix", "tedix.log"), "line\n");
	mkdirSync(join(home, "Library", "Logs", "@tedix", "desktop"), {
		recursive: true,
	});
	mkdirSync(join(appData, "Tedix dialog test"));
	return { home, appData, old, folders: { appData, home, packaged: true } };
}

test("the first start moves the app's data, logs and tool link into one folder", () => {
	const f = oldMac();
	// A copy run from source made its dev/ folder there first.
	mkdirSync(join(f.appData, "Tedix", "dev"), { recursive: true });
	// An older copy from source left its own folder beside the app's.
	mkdirSync(join(f.appData, "Tedix Dev"));
	writeFileSync(join(f.appData, "Tedix Dev", "settings.json"), "{}");
	moveAppFolders(f.folders);
	const data = userDataFolder(f.folders);
	expect(data).toBe(join(f.appData, "Tedix"));
	expect(existsSync(join(data, "dev", "settings.json"))).toBe(true);
	expect(readFileSync(join(data, "Partitions", "Cookies"), "utf8")).toBe(
		"signed in",
	);
	expect(existsSync(join(data, "dev"))).toBe(true);
	expect(readlinkSync(join(f.home, ".local", "bin", "tedix"))).toBe(
		join(data, "cli", "tedix"),
	);
	expect(readFileSync(join(data, "logs", "tedix.log"), "utf8")).toBe("line\n");
	for (const gone of [
		join(f.appData, "@tedix"),
		join(f.appData, "Tedix Dev"),
		join(f.appData, "Tedix dialog test"),
		join(f.home, "Library", "Logs", "Tedix"),
		join(f.home, "Library", "Logs", "@tedix"),
	])
		expect(existsSync(gone)).toBe(false);
	// The next start has nothing to move.
	expect(moveAppFolders(f.folders)).toEqual([]);
});

test("a folder already in the new place keeps the old one, which is not deleted", () => {
	const f = oldMac();
	mkdirSync(join(f.appData, "Tedix", "Partitions"), { recursive: true });
	const lines = moveAppFolders(f.folders);
	expect(existsSync(join(f.old, "Partitions", "Cookies"))).toBe(true);
	expect(existsSync(join(f.appData, "Tedix", "cli", "tedix"))).toBe(true);
	// The link keeps the old path while the old folder is still there.
	expect(readlinkSync(join(f.home, ".local", "bin", "tedix"))).toBe(
		join(f.old, "cli", "tedix"),
	);
	expect(lines.join("\n")).toContain("Partitions already in");
});

test("a new Mac has nothing to move and nothing to report", () => {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "tedix-folders-")));
	homes.push(home);
	const appData = join(home, "Library", "Application Support");
	expect(moveAppFolders({ appData, home, packaged: true })).toEqual([]);
});

test("a copy run from source uses dev/ inside the same folder", () => {
	const f = oldMac();
	const folders = { ...f.folders, packaged: false };
	mkdirSync(join(f.appData, "Tedix Dev"));
	writeFileSync(join(f.appData, "Tedix Dev", "settings.json"), "{}");
	moveAppFolders(folders);
	expect(userDataFolder(folders)).toBe(join(f.appData, "Tedix", "dev"));
	expect(existsSync(join(f.appData, "Tedix", "dev", "settings.json"))).toBe(
		true,
	);
	expect(existsSync(join(f.appData, "Tedix Dev"))).toBe(false);
	// The installed app's data is left for the installed app to move.
	expect(existsSync(f.old)).toBe(true);
});

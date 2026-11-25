import {
	lstatSync,
	mkdirSync,
	readdirSync,
	readlinkSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	symlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * The app keeps everything in one folder: `~/Library/Application Support/Tedix`,
 * with its logs in `logs/` there. A copy run from source uses `dev/` inside it.
 * Earlier versions used `@tedix/desktop`, `Tedix Dev` and `~/Library/Logs`;
 * the first start of this version moves them and deletes the old folders.
 */
export interface AppFolders {
	/** `~/Library/Application Support`. */
	appData: string;
	home: string;
	packaged: boolean;
}

export const userDataFolder = ({ appData, packaged }: AppFolders) =>
	packaged ? join(appData, "Tedix") : join(appData, "Tedix", "dev");

const exists = (path: string) => {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
};

/**
 * Renames `from` to `to`, or moves its entries one by one when `to` already
 * exists. An entry already in `to` stays where it is, and so does `from`.
 */
export function moveInto(
	from: string,
	to: string,
	say: (line: string) => void,
) {
	if (!exists(from)) return;
	if (!exists(to)) {
		mkdirSync(dirname(to), { recursive: true });
		renameSync(from, to);
		say(`moved ${from} to ${to}`);
		return;
	}
	if (!statSync(from).isDirectory() || !statSync(to).isDirectory()) {
		say(`kept ${from}: ${to} already exists`);
		return;
	}
	const kept: string[] = [];
	for (const name of readdirSync(from)) {
		if (exists(join(to, name))) kept.push(name);
		else renameSync(join(from, name), join(to, name));
	}
	if (kept.length) {
		say(`kept ${from}: ${kept.join(", ")} already in ${to}`);
		return;
	}
	rmdirSync(from);
	say(`moved the contents of ${from} to ${to}`);
}

/** The pid in Chromium's lock of a profile that is open now, if any. */
function openedBy(profile: string): number | undefined {
	try {
		const pid = Number(
			readlinkSync(join(profile, "SingletonLock")).split("-").pop(),
		);
		if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
		process.kill(pid, 0);
		return pid;
	} catch {
		return undefined;
	}
}

/**
 * Moves the folders earlier versions used into the current ones. Runs before
 * the app opens its profile, so sign-ins, settings and the command-line tool
 * copies move with it. Returns what happened, for the log. Any failure leaves
 * the old folder in place, and the next start tries again.
 */
export function moveAppFolders(folders: AppFolders): string[] {
	const lines: string[] = [];
	const say = (line: string) => lines.push(`folders: ${line}`);
	const { appData, home, packaged } = folders;
	const userData = userDataFolder(folders);
	const oldData = packaged
		? join(appData, "@tedix", "desktop")
		: join(appData, "Tedix Dev");
	const oldLogs = join(
		home,
		"Library",
		"Logs",
		packaged ? "Tedix" : "Tedix Dev",
	);
	const step = (label: string, run: () => void) => {
		try {
			run();
		} catch (error) {
			say(`${label} failed: ${(error as Error).message}`);
		}
	};
	const pid = openedBy(oldData);
	if (pid) {
		say(`kept ${oldData}: another copy of the app (pid ${pid}) has it open`);
		return lines;
	}
	step("app data", () => {
		moveInto(oldData, userData, say);
		if (packaged) {
			const parent = join(appData, "@tedix");
			if (exists(parent) && !readdirSync(parent).length) rmdirSync(parent);
		}
	});
	step("command-line tool link", () => {
		// `~/.local/bin/tedix` names the app's copy by its full path.
		const link = join(home, ".local", "bin", "tedix");
		// A new Mac has no link yet; the app makes one once its copy is in place.
		if (!exists(link)) return;
		const target = readlinkSync(link);
		if (!target.startsWith(`${oldData}/`) || exists(oldData)) return;
		const next = join(userData, target.slice(oldData.length + 1));
		rmSync(`${link}.app-link`, { force: true });
		symlinkSync(next, `${link}.app-link`);
		renameSync(`${link}.app-link`, link);
		say(`~/.local/bin/tedix now points at ${next}`);
	});
	step("logs", () => moveInto(oldLogs, join(userData, "logs"), say));
	if (packaged) {
		// The folders of a copy run from source move to its dev/ folder too,
		// unless such a copy has them open now; it moves them itself later.
		const oldDev = join(appData, "Tedix Dev");
		const devPid = openedBy(oldDev);
		if (devPid)
			say(`kept ${oldDev}: a copy run from source (pid ${devPid}) has it open`);
		else
			step("source copy folders", () => {
				moveInto(oldDev, join(userData, "dev"), say);
				moveInto(
					join(home, "Library", "Logs", "Tedix Dev"),
					join(userData, "dev", "logs"),
					say,
				);
			});
	}
	if (packaged)
		step("old folders", () => {
			// Electron's own default logs folder, and folders of test builds.
			for (const folder of [
				join(home, "Library", "Logs", "@tedix"),
				join(appData, "Tedix Local"),
				join(appData, "Tedix dialog test"),
			])
				if (exists(folder)) {
					rmSync(folder, { recursive: true, force: true });
					say(`deleted ${folder}`);
				}
		});
	return lines;
}

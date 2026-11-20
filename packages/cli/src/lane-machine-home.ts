import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { refusedMachineHomePath } from "./lane-machine-refused";

/**
 * Reading the owner's home folder for a tedi: list a folder, read a text
 * file. Nothing here writes. A path is resolved with its links followed and
 * must end up inside the home folder, outside the Tedix settings folder and
 * outside the places `refusedMachineHomePath` names. This exists only on a
 * machine whose saved runner settings say `machineWriteMode: "allow"`.
 */

const FOLDER_ENTRY_LIMIT = 500;
const FILE_MAX_BYTES = 2 * 1024 * 1024;

export interface MachineHome {
	/** The checked, resolved location of a path such as `~/Downloads`. */
	locate(path: string): Promise<string>;
	listFolder(path: string): Promise<string>;
	readText(path: string): Promise<string>;
}

export function machineHome(options: {
	home: string;
	/** The Tedix settings folder; never read, wherever it is. */
	configDir: string;
}): MachineHome {
	const inside = (parent: string, path: string) =>
		path === parent || path.startsWith(parent + sep);

	/** The path's parts below `root`, or undefined when it is not inside. */
	const below = (root: string, path: string) =>
		inside(root, path)
			? path.slice(root.length).split(sep).filter(Boolean)
			: undefined;
	const allow = (parts: string[]) => {
		const refused = refusedMachineHomePath(parts);
		if (refused) throw new Error(`Refused: ${refused}`);
	};

	async function locate(path: string): Promise<string> {
		const written = resolve(options.home);
		const home = await realpath(written);
		const named = resolve(
			path === "~"
				? written
				: path.startsWith("~/")
					? join(written, path.slice(2))
					: path,
		);
		// The name is checked before anything is touched, the target after links.
		const parts = below(written, named) ?? below(home, named);
		if (!parts) throw new Error(`Refused: ${path} is outside the home folder`);
		allow(parts);
		const target = await realpath(named).catch(() => {
			throw new Error(`No such folder or file: ${path}`);
		});
		const reached = below(home, target);
		if (!reached)
			throw new Error(`Refused: ${path} leaves the home folder through a link`);
		allow(reached);
		const settings = await realpath(options.configDir).catch(() =>
			resolve(options.configDir),
		);
		if (inside(settings, target))
			throw new Error("Refused: the runner's own settings are not read");
		return target;
	}

	return {
		locate,
		async listFolder(path) {
			const folder = await locate(path);
			const entries = await readdir(folder, { withFileTypes: true }).catch(
				(error: NodeJS.ErrnoException) => {
					throw new Error(
						error.code === "ENOTDIR"
							? `${path} is a file; read it with read_file`
							: error.code === "EACCES" || error.code === "EPERM"
								? `This machine does not let its runner read ${path}`
								: `${path} could not be listed`,
					);
				},
			);
			entries.sort((a, b) => a.name.localeCompare(b.name));
			const lines = await Promise.all(
				entries.slice(0, FOLDER_ENTRY_LIMIT).map(async (entry) => {
					const info = await stat(join(folder, entry.name)).catch(
						() => undefined,
					);
					if (info?.isDirectory()) return `folder\t\t\t${entry.name}/`;
					return `file\t${info?.size ?? "?"} bytes\t${info?.mtime.toISOString().slice(0, 16) ?? "?"}\t${entry.name}`;
				}),
			);
			return `${path}: ${entries.length} ${entries.length === 1 ? "entry" : "entries"}${
				entries.length > FOLDER_ENTRY_LIMIT
					? `, the first ${FOLDER_ENTRY_LIMIT} shown`
					: ""
			}\n${lines.join("\n")}`;
		},
		async readText(path) {
			const file = await locate(path);
			const info = await stat(file);
			if (info.isDirectory())
				throw new Error(`${path} is a folder; list it with list_folder`);
			if (info.size > FILE_MAX_BYTES)
				throw new Error(
					`${path} is too large to read as text (${info.size} bytes)`,
				);
			const text = await readFile(file, "utf8").catch(() => {
				throw new Error(`This machine does not let its runner read ${path}`);
			});
			if (text.includes("\0")) throw new Error(`${path} is not a text file`);
			return text;
		},
	};
}

/**
 * In-memory filesystem for isomorphic-git inside a Cloudflare Worker.
 *
 * Copied verbatim (minimal subset isomorphic-git uses) from
 * https://developers.cloudflare.com/artifacts/examples/isomorphic-git/
 *
 * Workers have no local disk, so isomorphic-git needs an `fs` adapter that
 * keeps the working tree + .git objects in memory for the duration of the
 * request. The whole tree is GC'd when the function returns.
 */

type Entry =
	| { kind: "dir"; children: Set<string>; mtimeMs: number }
	| { kind: "file"; data: Uint8Array; mtimeMs: number };

/**
 * Throw a Node-style FS error. isomorphic-git's `FileSystem.exists` (and
 * similar) checks `err.code === 'ENOENT'` / `'ENOTDIR'` to detect "missing"
 * vs propagate. Without the `code` field, every miss looks like a hard
 * failure and clone/init bail with "Unhandled error in FileSystem.exists".
 */
function fsError(
	code: "ENOENT" | "ENOTDIR" | "EISDIR" | "ENOTEMPTY" | "ENOSYS",
	path: string,
): Error {
	const err = new Error(`${code}: ${path}`) as Error & { code: string };
	err.code = code;
	return err;
}

class MemoryStats {
	entry: Entry;
	constructor(entry: Entry) {
		this.entry = entry;
	}
	get size() {
		return this.entry.kind === "file" ? this.entry.data.byteLength : 0;
	}
	get mtimeMs() {
		return this.entry.mtimeMs;
	}
	get ctimeMs() {
		return this.entry.mtimeMs;
	}
	get mode() {
		return this.entry.kind === "file" ? 0o100644 : 0o040000;
	}
	isFile() {
		return this.entry.kind === "file";
	}
	isDirectory() {
		return this.entry.kind === "dir";
	}
	isSymbolicLink() {
		return false;
	}
}

export class MemoryFS {
	encoder = new TextEncoder();
	decoder = new TextDecoder();
	entries = new Map<string, Entry>([
		["/", { kind: "dir", children: new Set(), mtimeMs: Date.now() }],
	]);

	promises = {
		readFile: this.readFile.bind(this),
		writeFile: this.writeFile.bind(this),
		unlink: this.unlink.bind(this),
		readdir: this.readdir.bind(this),
		mkdir: this.mkdir.bind(this),
		rmdir: this.rmdir.bind(this),
		stat: this.stat.bind(this),
		lstat: this.lstat.bind(this),
		// isomorphic-git binds these unconditionally on init even when no
		// repo content contains symlinks. Daily logs are plain markdown so
		// any actual call here is a bug — throw ENOSYS so it surfaces.
		readlink: this.readlink.bind(this),
		symlink: this.symlink.bind(this),
	};

	async readlink(_path: string): Promise<string> {
		throw fsError("ENOSYS", "readlink");
	}

	async symlink(_target: string, _path: string): Promise<void> {
		throw fsError("ENOSYS", "symlink");
	}

	normalize(input: string) {
		const segments: string[] = [];
		for (const part of input.split("/")) {
			if (!part || part === ".") continue;
			if (part === "..") {
				segments.pop();
				continue;
			}
			segments.push(part);
		}
		return `/${segments.join("/")}` || "/";
	}

	parent(path: string) {
		const normalized = this.normalize(path);
		if (normalized === "/") return "/";
		const parts = normalized.split("/").filter(Boolean);
		parts.pop();
		return parts.length ? `/${parts.join("/")}` : "/";
	}

	basename(path: string) {
		return this.normalize(path).split("/").filter(Boolean).pop() ?? "";
	}

	getEntry(path: string) {
		return this.entries.get(this.normalize(path));
	}

	requireEntry(path: string) {
		const entry = this.getEntry(path);
		if (!entry) throw fsError("ENOENT", path);
		return entry;
	}

	requireDir(path: string) {
		const entry = this.requireEntry(path);
		if (entry.kind !== "dir") throw fsError("ENOTDIR", path);
		return entry;
	}

	async mkdir(path: string, options?: { recursive?: boolean } | unknown) {
		const target = this.normalize(path);
		if (target === "/") return;
		const recursive =
			typeof options === "object" &&
			options !== null &&
			(options as { recursive?: boolean }).recursive === true;
		const parent = this.parent(target);
		if (!this.entries.has(parent)) {
			if (!recursive) throw fsError("ENOENT", parent);
			await this.mkdir(parent, { recursive: true });
		}
		if (this.entries.has(target)) return;
		this.entries.set(target, {
			kind: "dir",
			children: new Set(),
			mtimeMs: Date.now(),
		});
		this.requireDir(parent).children.add(this.basename(target));
	}

	async writeFile(path: string, data: string | Uint8Array | ArrayBuffer) {
		const target = this.normalize(path);
		await this.mkdir(this.parent(target), { recursive: true });
		const bytes =
			typeof data === "string"
				? this.encoder.encode(data)
				: data instanceof Uint8Array
					? data
					: new Uint8Array(data);
		this.entries.set(target, {
			kind: "file",
			data: bytes,
			mtimeMs: Date.now(),
		});
		this.requireDir(this.parent(target)).children.add(this.basename(target));
	}

	async readFile(
		path: string,
		options?: string | { encoding?: string } | unknown,
	) {
		const entry = this.requireEntry(path);
		if (entry.kind !== "file") throw fsError("EISDIR", path);
		const encoding =
			typeof options === "string"
				? options
				: (options as { encoding?: string } | undefined)?.encoding;
		return encoding ? this.decoder.decode(entry.data) : entry.data;
	}

	async readdir(path: string) {
		return [...this.requireDir(path).children].sort();
	}

	async unlink(path: string) {
		const target = this.normalize(path);
		const entry = this.requireEntry(target);
		if (entry.kind !== "file") throw fsError("EISDIR", path);
		this.entries.delete(target);
		this.requireDir(this.parent(target)).children.delete(this.basename(target));
	}

	async rmdir(path: string) {
		const target = this.normalize(path);
		const entry = this.requireDir(target);
		if (entry.children.size > 0) throw fsError("ENOTEMPTY", path);
		this.entries.delete(target);
		this.requireDir(this.parent(target)).children.delete(this.basename(target));
	}

	async stat(path: string) {
		return new MemoryStats(this.requireEntry(path));
	}

	async lstat(path: string) {
		return this.stat(path);
	}
}

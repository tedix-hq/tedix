import { Buffer } from "node:buffer";

type Entry =
	| { kind: "directory"; children: Set<string> }
	| { kind: "file"; bytes: Uint8Array };

function failure(code: string): Error & { code: string } {
	return Object.assign(new Error(`Candidate Git filesystem ${code}`), { code });
}

/** Request-local Git storage. It has no access to the host filesystem. */
export class CandidateGitMemoryFs {
	private entries = new Map<string, Entry>([
		["/", { kind: "directory", children: new Set() }],
	]);
	private bytes = 0;
	constructor(
		private readonly maxBytes = 4 * 1024 * 1024,
		private readonly maxEntries = 512,
	) {}
	get storedBytes() {
		return this.bytes;
	}
	get entryCount() {
		return this.entries.size;
	}
	readonly promises = {
		readFile: this.readFile.bind(this),
		writeFile: this.writeFile.bind(this),
		mkdir: this.mkdir.bind(this),
		rmdir: this.rmdir.bind(this),
		unlink: this.unlink.bind(this),
		stat: this.stat.bind(this),
		lstat: this.stat.bind(this),
		readdir: this.readdir.bind(this),
		readlink: this.readlink.bind(this),
		symlink: this.symlink.bind(this),
	};
	private normalize(path: string) {
		if (path.length > 2048 || path.includes("\0")) throw failure("EINVAL");
		const parts: string[] = [];
		for (const part of path.split("/")) {
			if (part === "..") parts.pop();
			else if (part && part !== ".") parts.push(part);
		}
		return `/${parts.join("/")}`;
	}
	private parent(path: string) {
		const parts = path.split("/");
		parts.pop();
		return parts.join("/") || "/";
	}
	private name(path: string) {
		return path.slice(path.lastIndexOf("/") + 1);
	}
	private directory(path: string) {
		const entry = this.entries.get(path);
		if (!entry) throw failure("ENOENT");
		if (entry.kind !== "directory") throw failure("ENOTDIR");
		return entry;
	}
	private ensureCapacity() {
		if (this.entries.size >= this.maxEntries) throw failure("ENOSPC");
	}
	async mkdir(path: string, options?: { recursive?: boolean }) {
		const key = this.normalize(path);
		if (this.entries.has(key)) {
			this.directory(key);
			return;
		}
		const parent = this.parent(key);
		if (!this.entries.has(parent) && options?.recursive)
			await this.mkdir(parent, options);
		const directory = this.directory(parent);
		this.ensureCapacity();
		this.entries.set(key, { kind: "directory", children: new Set() });
		directory.children.add(this.name(key));
	}
	async writeFile(path: string, data: string | Uint8Array | ArrayBuffer) {
		const key = this.normalize(path),
			prior = this.entries.get(key);
		if (prior?.kind === "directory") throw failure("EISDIR");
		const size =
			typeof data === "string"
				? Buffer.byteLength(data, "utf8")
				: data.byteLength;
		const nextSize = this.bytes - (prior?.bytes.byteLength ?? 0) + size;
		if (nextSize > this.maxBytes) throw failure("ENOSPC");
		const bytes =
			typeof data === "string"
				? new TextEncoder().encode(data)
				: data instanceof Uint8Array
					? data
					: new Uint8Array(data);
		const parent = this.directory(this.parent(key));
		if (!prior) this.ensureCapacity();
		this.entries.set(key, { kind: "file", bytes: bytes.slice() });
		parent.children.add(this.name(key));
		this.bytes = nextSize;
	}
	async readFile(path: string, options?: string | { encoding?: string }) {
		const entry = this.entries.get(this.normalize(path));
		if (!entry) throw failure("ENOENT");
		if (entry.kind !== "file") throw failure("EISDIR");
		return (typeof options === "string" ? options : options?.encoding)
			? new TextDecoder().decode(entry.bytes)
			: entry.bytes.slice();
	}
	async readdir(path: string) {
		return [...this.directory(this.normalize(path)).children].sort();
	}
	async unlink(path: string) {
		const key = this.normalize(path),
			entry = this.entries.get(key);
		if (!entry) throw failure("ENOENT");
		if (entry.kind !== "file") throw failure("EISDIR");
		this.bytes -= entry.bytes.byteLength;
		this.entries.delete(key);
		this.directory(this.parent(key)).children.delete(this.name(key));
	}
	async rmdir(path: string) {
		const key = this.normalize(path),
			entry = this.directory(key);
		if (key === "/" || entry.children.size) throw failure("ENOTEMPTY");
		this.entries.delete(key);
		this.directory(this.parent(key)).children.delete(this.name(key));
	}
	async stat(path: string) {
		const entry = this.entries.get(this.normalize(path));
		if (!entry) throw failure("ENOENT");
		return {
			size: entry.kind === "file" ? entry.bytes.byteLength : 0,
			mode: entry.kind === "file" ? 0o100644 : 0o040000,
			mtimeMs: 0,
			ctimeMs: 0,
			isFile: () => entry.kind === "file",
			isDirectory: () => entry.kind === "directory",
			isSymbolicLink: () => false,
		};
	}
	async readlink(): Promise<string> {
		throw failure("ENOSYS");
	}
	async symlink(): Promise<void> {
		throw failure("ENOSYS");
	}
}

// Derived from the MIT-licensed state API in Cloudflare Shell 0.4.3.
// Copyright (c) 2025 Cloudflare, Inc. See LICENSE in this directory.
export type FileSystemEntryType = "file" | "directory" | "symlink";
/** Stat result returned by FileSystem.stat / FileSystem.lstat. */
export interface FsStat {
	type: FileSystemEntryType;
	size: number;
	mtime: Date;
	mode?: number;
}
/** Directory entry returned by FileSystem.readdirWithFileTypes. */
export interface FileSystemDirent {
	name: string;
	type: FileSystemEntryType;
}
export interface MkdirOptions {
	recursive?: boolean;
}
export interface RmOptions {
	recursive?: boolean;
	force?: boolean;
}
export interface CpOptions {
	recursive?: boolean;
}
/**
 * Filesystem contract consumed by the state compatibility backend.
 *
 * Contracts:
 *   - `readFile` / `readFileBytes` / `stat` / `lstat` throw `ENOENT`
 *     when the path does not exist (never return null).
 *   - `exists` never throws.
 *   - `glob` returns workspace-rooted logical paths matching the pattern.
 */
export interface FileSystem {
	readFile(path: string): Promise<string>;
	readFileBytes(path: string): Promise<Uint8Array>;
	writeFile(path: string, content: string): Promise<void>;
	writeFileBytes(path: string, content: Uint8Array): Promise<void>;
	appendFile(path: string, content: string | Uint8Array): Promise<void>;
	exists(path: string): Promise<boolean>;
	/** Follows symlinks. Throws ENOENT if path does not exist. */
	stat(path: string): Promise<FsStat>;
	/** Does not follow the final symlink. Throws ENOENT if path does not exist. */
	lstat(path: string): Promise<FsStat>;
	mkdir(path: string, options?: MkdirOptions): Promise<void>;
	readdir(path: string): Promise<string[]>;
	readdirWithFileTypes(path: string): Promise<FileSystemDirent[]>;
	rm(path: string, options?: RmOptions): Promise<void>;
	cp(src: string, dest: string, options?: CpOptions): Promise<void>;
	mv(src: string, dest: string): Promise<void>;
	symlink(target: string, linkPath: string): Promise<void>;
	readlink(path: string): Promise<string>;
	realpath(path: string): Promise<string>;
	resolvePath(base: string, path: string): string;
	glob(pattern: string): Promise<string[]>;
}

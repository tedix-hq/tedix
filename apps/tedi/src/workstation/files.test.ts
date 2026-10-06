/// <reference types="node" />
import { spawnSync } from "node:child_process";
import {
	mkdtempSync,
	rmSync,
	symlinkSync,
	readFileSync,
	writeFileSync,
	renameSync,
	unlinkSync,
	mkdirSync,
	readdirSync,
	lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { workstationFiles } from "./files";
const roots: string[] = [];
function setup(
	options: {
		failRename?: boolean;
		truncated?: boolean;
		timedOut?: boolean;
	} = {},
) {
	const root = mkdtempSync(join(tmpdir(), "native-files-"));
	roots.push(root);
	const sandbox = {
		writeFile: async (path: string, content: string) => {
			if (path.startsWith("/tmp/tedix-file-request-")) {
				const input = JSON.parse(content);
				input.root = root;
				content = JSON.stringify(input);
			}
			writeFileSync(path, content);
			return { success: true };
		},
		readFile: async (path: string) => {
			const bytes = readFileSync(path);
			return {
				size: bytes.length,
				content: new ReadableStream<Uint8Array>({
					start(c) {
						for (let i = 0; i < bytes.length; i += 3)
							c.enqueue(bytes.subarray(i, i + 3));
						c.close();
					},
				}),
			};
		},
		renameFile: async (from: string, to: string) => {
			if (options.failRename) throw new Error("rename failed");
			renameSync(from, to);
			return { success: true };
		},
		deleteFile: async (path: string) => {
			unlinkSync(path);
			return { success: true };
		},
		mkdir: async (path: string) => {
			mkdirSync(path, { recursive: true });
			return { success: true };
		},
		listFiles: async (path: string) => ({
			success: true,
			files: readdirSync(path).map((name) => {
				const stat = lstatSync(join(path, name));
				return {
					name,
					size: stat.size,
					modifiedAt: stat.mtime.toISOString(),
					type: stat.isSymbolicLink()
						? "symlink"
						: stat.isDirectory()
							? "directory"
							: "file",
				};
			}),
		}),
		exec: async ([command, ...args]: readonly [string, ...string[]]) => ({
			output: async () => {
				const result = spawnSync(
					command === "node" ? process.execPath : command,
					args.map((value, index) =>
						options.failRename && index === 1
							? `require("node:fs").renameSync = () => { throw new Error("rename failed"); };\n${value}`
							: value,
					),
					{
						encoding: "utf8",
						maxBuffer: 1024 * 1024,
					},
				);
				return {
					stdout: result.stdout,
					stderr: result.stderr,
					exitCode: result.status,
					timedOut: options.timedOut ?? false,
					truncated: options.truncated ?? false,
				};
			},
		}),
	} as unknown as Parameters<typeof workstationFiles>[1];
	return {
		root,
		call: async (input: Record<string, unknown>) =>
			workstationFiles(input, sandbox),
	};
}
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
describe("native Sandbox files", () => {
	it("writes exact Unicode and shell text, edits atomically, and reads tested bytes", async () => {
		const { root, call } = setup();
		const path = join(root, "source.js");
		expect(
			(
				await call({
					operation: "write",
					path,
					content: "café\nfirst\nsecond\n'$(touch bad)'",
				})
			).ok,
		).toBe(true);
		expect(
			(
				await call({
					operation: "edit",
					path,
					edits: [
						{ oldText: "first", newText: "updated" },
						{ oldText: "missing", newText: "no" },
					],
				})
			).ok,
		).toBe(false);
		expect(
			(await call({ operation: "read", path, offset: 2, limit: 1 })).content,
		).toBe("first");
		expect(
			(
				await call({
					operation: "edit",
					path,
					edits: [{ oldText: "first", newText: "updated" }],
				})
			).ok,
		).toBe(true);
		expect((await call({ operation: "read", path })).content).toBe(
			"café\nupdated\nsecond\n'$(touch bad)'",
		);
	});
	it("preserves UTF8 BOM bytes in whole reads, line reads and atomic edits", async () => {
		const { root, call } = setup();
		const path = join(root, "bom.txt");
		writeFileSync(path, "\ufefffirst\nsecond\n");
		expect((await call({ operation: "read_file", path })).content).toBe(
			"\ufefffirst\nsecond\n",
		);
		expect((await call({ operation: "read", path })).content).toBe(
			"\ufefffirst\nsecond",
		);
		expect(
			(
				await call({
					operation: "edit",
					path,
					edits: [{ oldText: "second", newText: "updated" }],
				})
			).ok,
		).toBe(true);
		expect(readFileSync(path)).toEqual(Buffer.from("\ufefffirst\nupdated\n"));
	});
	it("preserves a BOM at a byte-pagination boundary without shifting offsets", async () => {
		const { root, call } = setup();
		const path = join(root, "paged-bom.txt");
		writeFileSync(path, "\ufefffirst\n\ufeffsecond\nlast\n");
		const first = await call({ operation: "read", path, limit: 1 });
		expect(first).toMatchObject({ content: "\ufefffirst", nextByteOffset: 9 });
		const second = await call({
			operation: "read",
			path,
			limit: 1,
			offset: first.nextOffset,
			byteOffset: first.nextByteOffset,
		});
		expect(second).toMatchObject({
			content: "\ufeffsecond",
			nextByteOffset: 19,
		});
		expect(
			(
				await call({
					operation: "read",
					path,
					offset: second.nextOffset,
					byteOffset: second.nextByteOffset,
				})
			).content,
		).toBe("last");
	});

	it("rejects symlink escape and destructive root removal", async () => {
		const { root, call } = setup();
		symlinkSync(tmpdir(), join(root, "escape"));
		symlinkSync(
			join(tmpdir(), "missing-computer-file"),
			join(root, "dangling"),
		);
		expect(
			(
				await call({
					operation: "write",
					path: join(root, "dangling"),
					content: "no",
				})
			).ok,
		).toBe(false);
		expect(
			(
				await call({
					operation: "write",
					path: join(root, "escape", "outside"),
					content: "no",
				})
			).ok,
		).toBe(false);
		expect(
			(await call({ operation: "delete", path: root, recursive: true })).ok,
		).toBe(false);
	});
	it("bounds discovery and supports glob and regex options", async () => {
		const { root, call } = setup();
		await call({
			operation: "write",
			path: join(root, "a.ts"),
			content: "HELLO\nhello",
		});
		await call({
			operation: "write",
			path: join(root, "b.js"),
			content: "hello",
		});
		expect(
			(await call({ operation: "find", path: root, pattern: "*.ts" })).entries,
		).toEqual([{ path: join(root, "a.ts"), type: "file" }]);
		expect(
			await call({
				operation: "grep",
				path: root,
				query: "^hello$",
				regex: true,
				ignoreCase: true,
				include: "*.ts",
				limit: 1,
			}),
		).toMatchObject({
			ok: true,
			truncated: true,
			matches: [{ path: join(root, "a.ts"), line: 1, text: "HELLO" }],
		});
	});
	it("continues text by exact UTF8 byte offset and preserves raw file bytes", async () => {
		const { root, call } = setup();
		const path = join(root, "unicode.txt");
		await call({ operation: "write", path, content: "café\nsecond\nthird\n" });
		const first = await call({ operation: "read", path, limit: 1 });
		expect(first).toMatchObject({
			content: "café",
			startLine: 1,
			endLine: 1,
			totalLines: null,
			truncated: true,
			nextOffset: 2,
			nextByteOffset: 6,
		});
		expect(
			await call({
				operation: "read",
				path,
				offset: first.nextOffset,
				byteOffset: first.nextByteOffset,
			}),
		).toMatchObject({
			content: "second\nthird",
			startLine: 2,
			endLine: 3,
			totalLines: 3,
			truncated: false,
		});
		expect((await call({ operation: "read_file", path })).content).toBe(
			"café\nsecond\nthird\n",
		);
		expect((await call({ operation: "read", path, byteOffset: 6 })).ok).toBe(
			false,
		);
		expect((await call({ operation: "read", path, offset: 4 })).ok).toBe(false);
	});
	it("supports grep context and pagination on a file", async () => {
		const { root, call } = setup();
		const path = join(root, "source.txt");
		await call({
			operation: "write",
			path,
			content: "before\nhit one\nbetween\nhit two\nafter\n",
		});
		expect(
			await call({
				operation: "grep",
				path,
				query: "hit",
				context: 1,
				offset: 1,
				limit: 1,
			}),
		).toMatchObject({
			count: 1,
			truncated: false,
			matches: [
				{
					path,
					line: 4,
					text: "hit two",
					context: [
						{ line: 3, text: "between", isMatch: false },
						{ line: 4, text: "hit two", isMatch: true },
						{ line: 5, text: "after", isMatch: false },
					],
				},
			],
		});
		const first = await call({
			operation: "grep",
			path,
			query: "hit",
			limit: 1,
		});
		expect(first.nextOffset).toBe(1);
	});
	it("matches zero-depth globstars, question marks and excluded directories", async () => {
		const { root, call } = setup();
		for (const file of ["a.ts", "nested/b.ts", "nested/long.ts", "vendor/c.ts"])
			await call({ operation: "write", path: join(root, file), content: "x" });
		expect(
			(
				await call({
					operation: "find",
					path: root,
					pattern: "**/?.ts",
					exclude: ["vendor/**"],
					offset: 1,
				})
			).entries,
		).toEqual([{ path: join(root, "nested/b.ts"), type: "file" }]);
	});
	it("returns null only for a missing exact-read file", async () => {
		const { root, call } = setup();
		expect(
			await call({ operation: "read_file", path: join(root, "missing.txt") }),
		).toMatchObject({
			ok: true,
			content: null,
		});
		expect((await call({ operation: "read_file", path: root })).ok).toBe(false);
		expect(
			(
				await call({
					operation: "read_file",
					path: join(root, "..", "outside.txt"),
				})
			).ok,
		).toBe(false);
	});
	it("leaves original bytes untouched when atomic replacement fails", async () => {
		const { root, call } = setup({ failRename: true });
		const path = join(root, "file.txt");
		writeFileSync(path, "original");
		expect(
			(
				await call({
					operation: "edit",
					path,
					edits: [{ oldText: "original", newText: "changed" }],
				})
			).ok,
		).toBe(false);
		expect(readFileSync(path, "utf8")).toBe("original");
		expect(readdirSync(root)).toEqual(["file.txt"]);
	});
	it("edits an internal symlink target without replacing the link", async () => {
		const { root, call } = setup();
		const target = join(root, "target.txt"),
			link = join(root, "link.txt");
		writeFileSync(target, "before");
		symlinkSync(target, link);
		expect(
			(
				await call({
					operation: "edit",
					path: link,
					edits: [{ oldText: "before", newText: "after" }],
				})
			).ok,
		).toBe(true);
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		expect(readFileSync(target, "utf8")).toBe("after");
	});
	it.each([{ truncated: true }, { timedOut: true }])(
		"rejects incomplete authorization output even with exit zero",
		async (options) => {
			const { root, call } = setup(options);
			const path = join(root, "source");
			writeFileSync(path, "exact");
			expect(await call({ operation: "read_file", path })).toMatchObject({
				ok: false,
				error: "File operation returned incomplete output",
			});
		},
	);
});

describe("guarded native workspace undo", () => {
	it("restores prior bytes and refuses an intervening write or deletion", async () => {
		const { root, call } = setup();
		const path = join(root, "undo.txt");
		await call({ operation: "write", path, content: "before" });
		const receipt = await call({
			operation: "reversible_write",
			path,
			content: "approved",
		});
		expect(receipt).toMatchObject({ ok: true, previousContent: "before" });
		await call({ operation: "write", path, content: "newer" });
		const restore = {
			operation: "guarded_restore",
			path,
			expectedContent: "approved",
			previousContent: receipt.previousContent,
		};
		expect(await call(restore)).toMatchObject({
			ok: false,
			error: expect.stringContaining("workspace_rollback_conflict"),
		});
		expect(readFileSync(path, "utf8")).toBe("newer");
		await call({ operation: "delete", path });
		expect((await call(restore)).ok).toBe(false);
		await call({ operation: "write", path, content: "approved" });
		expect((await call(restore)).ok).toBe(true);
		expect(readFileSync(path, "utf8")).toBe("before");
	});
	it("distinguishes new and empty files, validates receipts before mutation", async () => {
		const { root, call } = setup();
		const path = join(root, "empty.txt");
		expect(
			await call({ operation: "reversible_write", path, content: "" }),
		).toMatchObject({ ok: true, previousContent: null });
		expect(
			(
				await call({
					operation: "guarded_restore",
					path,
					expectedContent: "",
					previousContent: null,
				})
			).ok,
		).toBe(true);
		expect((await call({ operation: "read_file", path })).content).toBeNull();
		await call({ operation: "write", path, content: "" });
		expect(
			await call({ operation: "reversible_write", path, content: "approved" }),
		).toMatchObject({ ok: true, previousContent: "" });
		expect(
			(
				await call({
					operation: "guarded_restore",
					path,
					expectedContent: "approved",
				})
			).ok,
		).toBe(false);
		expect(readFileSync(path, "utf8")).toBe("approved");
		expect(
			(
				await call({
					operation: "guarded_restore",
					path,
					expectedContent: "approved",
					previousContent: "",
				})
			).ok,
		).toBe(true);
		expect(readFileSync(path, "utf8")).toBe("");
	});
	it("refuses oversized escaped receipts before touching file bytes", async () => {
		const { root, call } = setup();
		const path = join(root, "receipt.txt");
		const before = "\n".repeat(150000);
		writeFileSync(path, before);
		expect(
			await call({ operation: "reversible_write", path, content: "approved" }),
		).toMatchObject({
			ok: false,
			error: expect.stringContaining("receipt exceeds"),
		});
		expect(readFileSync(path, "utf8")).toBe(before);
	});
});

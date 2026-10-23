import { env } from "cloudflare:workers";
import { createHash } from "node:crypto";
import { getWorkspace } from "@cloudflare/computer";
import { expect, it } from "vite-plus/test";
import type { TediComputerWorkspaceDO } from "../src/computer-workspace-do";
import { adaptVfsToWorkspaceFs } from "../src/workspace-fs";
import { stateTools } from "../src/workspace-state/workers";

const bindings = env as unknown as {
	TEDI_COMPUTER_WORKSPACE: DurableObjectNamespace<TediComputerWorkspaceDO>;
};

async function open() {
	const stub = bindings.TEDI_COMPUTER_WORKSPACE.getByName(crypto.randomUUID());
	await stub.initialize({
		ownerId: "owner-test",
		tediId: "tedi-test",
		scope: "state-test",
	});
	const workspace = await getWorkspace(
		stub as unknown as Parameters<typeof getWorkspace>[0],
	);
	const provider = stateTools(adaptVfsToWorkspaceFs(workspace));
	const call = (method: string, ...args: unknown[]) =>
		Reflect.apply(provider.tools[method]!.execute!, undefined, args);
	return { workspace, provider, call };
}

it("retains the complete model-visible state API and its object-argument schemas", async () => {
	const { workspace, provider } = await open();
	using owned = workspace;
	expect(Object.keys(provider.tools).sort()).toEqual(
		[
			"appendFile",
			"applyEditPlan",
			"applyEdits",
			"compressFile",
			"copyTree",
			"cp",
			"createArchive",
			"decompressFile",
			"detectFile",
			"diff",
			"diffContent",
			"exists",
			"extractArchive",
			"find",
			"getCapabilities",
			"glob",
			"hashFile",
			"listArchive",
			"lstat",
			"mkdir",
			"moveTree",
			"mv",
			"planEdits",
			"queryJson",
			"readFile",
			"readFileBytes",
			"readJson",
			"readdir",
			"readdirWithFileTypes",
			"readlink",
			"realpath",
			"removeTree",
			"replaceInFile",
			"replaceInFiles",
			"resolvePath",
			"rm",
			"searchFiles",
			"searchText",
			"stat",
			"summarizeTree",
			"symlink",
			"updateJson",
			"walkTree",
			"writeFile",
			"writeFileBytes",
			"writeJson",
		].sort(),
	);
	expect(provider.name).toBe("state");
	// Fingerprint of the previously advertised Shell 0.4.3 TypeScript API.
	expect(createHash("sha256").update(provider.types!).digest("hex")).toBe(
		"a1ea6e537f8314401c7bfe6383978ae662383ac5410de694c1f8ed9a1b16b5bb",
	);
});

it("reads and writes the same Computer workspace using object and positional arguments", async () => {
	const { workspace, call } = await open();
	using owned = workspace;
	await workspace.fs.writeFile("/workspace/notes.md", "# Notes\nHello world");
	const notes = await call("readFile", { path: "/notes.md" });
	expect(notes).toBe("# Notes\nHello world");
	await call("writeFile", {
		path: "/summary.txt",
		content: `Summary: ${String(notes).length} chars`,
	});
	expect(await workspace.fs.readFile("/workspace/summary.txt", "utf8")).toBe(
		"Summary: 19 chars",
	);
	await call("appendFile", "/summary.txt", "!");
	expect(await call("readFile", "/summary.txt")).toBe("Summary: 19 chars!");
	await expect(call("readFile", { path: "/missing" })).rejects.toThrow(
		"ENOENT",
	);
	expect(await call("stat", { path: "/missing" })).toBeNull();
	await expect(
		call("writeFile", { path: "/workspace/../escape", content: "escape" }),
	).rejects.toThrow();
});

it("preserves JSON, search, edit planning, and multi-file rollback behavior", async () => {
	const { workspace, call } = await open();
	using owned = workspace;
	await call("writeJson", {
		path: "/data.json",
		value: { items: [{ name: "alpha" }] },
	});
	expect(
		await call("queryJson", { path: "/data.json", query: ".items[0].name" }),
	).toBe("alpha");
	await call("updateJson", {
		path: "/data.json",
		operations: [{ op: "set", path: ".items[0].name", value: "beta" }],
	});
	expect(await call("readJson", { path: "/data.json" })).toEqual({
		items: [{ name: "beta" }],
	});
	await call("writeFile", { path: "/note.txt", content: "alpha alpha" });
	expect(
		await call("replaceInFile", {
			path: "/note.txt",
			search: "alpha",
			replacement: "beta",
		}),
	).toMatchObject({ replaced: 2, content: "beta beta" });
	const plan = await call("planEdits", {
		instructions: [{ kind: "write", path: "/note.txt", content: "planned" }],
	});
	await call("applyEditPlan", { plan });
	expect(await call("readFile", { path: "/note.txt" })).toBe("planned");
	await expect(
		call("applyEdits", {
			edits: [
				{ path: "/note.txt", content: "must roll back" },
				{ path: "/workspace/../escape", content: "denied" },
			],
		}),
	).rejects.toThrow();
	expect(await call("readFile", { path: "/note.txt" })).toBe("planned");
});

it("preserves binary data, archives, compression, and content hashes", async () => {
	const { workspace, call } = await open();
	using owned = workspace;
	const content = new Uint8Array([0, 1, 255, 128]);
	await call("writeFileBytes", { path: "/binary", content });
	expect(await call("readFileBytes", { path: "/binary" })).toEqual(content);
	await call("createArchive", { path: "/files.tar", sources: ["/binary"] });
	await call("extractArchive", {
		path: "/files.tar",
		destination: "/restored",
	});
	expect(await call("readFileBytes", { path: "/restored/binary" })).toEqual(
		content,
	);
	await call("compressFile", { path: "/binary" });
	await call("decompressFile", {
		path: "/binary.gz",
		destination: "/decompressed",
	});
	expect(await call("readFileBytes", { path: "/decompressed" })).toEqual(
		content,
	);
	expect(await call("hashFile", { path: "/binary" })).toEqual(
		await call("hashFile", { path: "/decompressed" }),
	);
});

it("preserves links, glob paths, directory entries, and missing-file stat behavior", async () => {
	const { workspace, call } = await open();
	using owned = workspace;
	await call("writeFile", { path: "/dir/file.txt", content: "linked" });
	await call("symlink", { target: "/dir/file.txt", linkPath: "/dir/link.txt" });
	expect(await call("readFile", { path: "/dir/link.txt" })).toBe("linked");
	expect(await call("lstat", { path: "/dir/link.txt" })).toMatchObject({
		type: "symlink",
	});
	expect(await call("realpath", { path: "/dir/link.txt" })).toBe(
		"/dir/file.txt",
	);
	expect(await call("glob", { pattern: "dir/*.txt" })).toEqual([
		"dir/file.txt",
		"dir/link.txt",
	]);
	expect(await call("readdir", { path: "/dir" })).toEqual([
		"file.txt",
		"link.txt",
	]);
	expect(await call("stat", { path: "/dir/file.txt" })).toMatchObject({
		type: "file",
		size: 6,
		mtime: expect.any(Date),
	});
});

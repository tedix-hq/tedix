/**
 * Workspace identity reads come only from the per-tedi Artifacts repo; files
 * that are missing there are reported so the caller can provision defaults.
 * Run: `bun run src/workspace.test.ts`.
 */
import assert from "node:assert/strict";
import {
	readIdentityFilesWithDiagnostics,
	selectIdentityWorkspaceFiles,
} from "./workspace";

{
	const result = await readIdentityFilesWithDiagnostics({
		tediId: "tedi-1",
		files: ["SOUL.md", "IDENTITY.md"],
		artifactsReader: async (path) => (path === "SOUL.md" ? "git soul" : null),
	});

	assert.deepEqual(
		result.files.map((file) => [file.key, file.text]),
		[["SOUL.md", "git soul"]],
		"only the Artifacts repo supplies instruction files",
	);
	assert.equal(result.diagnostics.artifacts.repoFound, true);
	assert.deepEqual(result.diagnostics.provisionedFiles, ["SOUL.md"]);
	assert.deepEqual(result.diagnostics.missingFiles, ["IDENTITY.md"]);
	assert.deepEqual(
		result.diagnostics.files.map((file) => [
			file.path,
			file.source,
			file.artifact.attempted,
		]),
		[
			["SOUL.md", "artifacts", true],
			["IDENTITY.md", "missing", true],
		],
		"diagnostics report each file as found in Artifacts or missing",
	);
}

{
	const { files, diagnostics } = await readIdentityFilesWithDiagnostics({
		tediId: "tedi-1",
		files: ["SOUL.md"],
		artifactsReader: async () => "   ",
	});
	assert.deepEqual(files, [], "blank Artifacts content counts as missing");
	assert.deepEqual(diagnostics.missingFiles, ["SOUL.md"]);
}

assert.deepEqual(
	selectIdentityWorkspaceFiles(
		{
			"SOUL.md": "soul",
			"IDENTITY.md": "identity",
			"MEMORY.md": "memory",
			"USER.md": "user",
			"AGENTS.md": "agents",
			"TOOLS.md": "tools",
		},
		[
			"SOUL.md",
			"IDENTITY.md",
			"USER.md",
			"AGENTS.md",
			"TOOLS.md",
			"memory/MEMORY.md",
		],
	),
	[
		{ path: "SOUL.md", content: "soul" },
		{ path: "IDENTITY.md", content: "identity" },
		{ path: "USER.md", content: "user" },
		{ path: "AGENTS.md", content: "agents" },
		{ path: "TOOLS.md", content: "tools" },
		{ path: "memory/MEMORY.md", content: "memory" },
	],
	"missing isolate identity paths map to API workspace projection files",
);

{
	const { commitDailyLogEntries, commitIdentityWorkspaceFiles } =
		await import("./workspace");
	let active = true,
		calls = 0,
		creates = 0,
		uploads = 0;
	const assertReady = async () => {
		if (!active) throw new Error("original operation held");
	};
	const options = {
		accountId: "account",
		namespace: "tedix-prod",
		tediId: "tedi",
		slug: "tedi",
		assertReady,
	};
	const artifacts = {
		get: async () => {
			calls++;
			throw { code: "NOT_FOUND" };
		},
		create: async () => {
			creates++;
			return { token: "secret" };
		},
	} as unknown as Artifacts;
	assert.equal(
		await commitDailyLogEntries(artifacts, { ...options, batches: [] }),
		null,
	);
	assert.equal(
		await commitIdentityWorkspaceFiles(artifacts, { ...options, files: [] }),
		null,
	);
	assert.equal(
		calls,
		0,
		"empty work returns no fabricated Git receipt or repo side effect",
	);
	const originalFetch = globalThis.fetch;
	const packet = (text: string) =>
		`${(Buffer.byteLength(text) + 4).toString(16).padStart(4, "0")}${text}`;
	try {
		globalThis.fetch = (async (url: any, init: any) => {
			if (init?.method === "POST") {
				uploads++;
				active = false;
				return new Response(
					packet(
						"\x01" +
							packet("unpack ok\n") +
							packet("ok refs/heads/main\n") +
							"0000",
					) + "0000",
					{
						headers: {
							"Content-Type": "application/x-git-receive-pack-result",
						},
					},
				);
			}
			const service = String(url).includes("git-receive-pack")
				? "git-receive-pack"
				: "git-upload-pack";
			return new Response(
				packet(`# service=${service}\n`) +
					"0000" +
					packet(
						"0000000000000000000000000000000000000000 capabilities^{}\0report-status side-band-64k\n",
					) +
					"0000",
				{
					headers: { "Content-Type": `application/x-${service}-advertisement` },
				},
			);
		}) as typeof fetch;
		const receipt = await commitDailyLogEntries(artifacts, {
			...options,
			batches: [
				{
					date: "2026-10-04",
					entries: [
						{
							ts: 1791129600000,
							role: "assistant",
							content: "original result",
							turnId: "original-turn",
						},
					],
				},
			],
		});
		assert.match(receipt!.commitOid, /^[a-f0-9]{40}$/);
		assert.equal(receipt!.fileCount, 1);
		assert.equal(receipt!.pushedRefs["refs/heads/main"]?.ok, true);
		assert.equal(uploads, 1);
		assert.equal(creates, 1);
		const before = calls;
		await assert.rejects(
			commitIdentityWorkspaceFiles(artifacts, {
				...options,
				files: [{ path: "SOUL.md", content: "owned identity" }],
			}),
			/held/,
		);
		assert.equal(calls, before);
	} finally {
		globalThis.fetch = originalFetch;
	}
}
console.log(
	"PASS workspace original Git ACK return, empty input and held identity write",
);

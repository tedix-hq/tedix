import { describe, expect, it } from "vite-plus/test";
import {
	portableTediDestinationId,
	validatePortableTediImportGraph,
	verifyPortableTediSnapshotFiles,
} from "./portable-tedi";

const paths = {
	memoryDomains: "snapshot/memory-domains.ndjson",
	memoryFacts: "snapshot/memory-facts.ndjson",
	memoryEdges: "snapshot/memory-edges.ndjson",
	skills: "snapshot/skills.ndjson",
	rationale: "snapshot/rationale.ndjson",
} as const;

async function fixture() {
	const files: Record<string, Uint8Array> = {};
	const sections: Record<
		string,
		{ path: string; sha256: string; count: number }
	> = {};
	for (const [section, path] of Object.entries(paths)) {
		const bytes = new TextEncoder().encode('{"id":"one"}\n');
		files[path] = bytes;
		const digest = new Uint8Array(
			await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)),
		);
		sections[section] = {
			path,
			sha256: Array.from(digest, (part) =>
				part.toString(16).padStart(2, "0"),
			).join(""),
			count: 1,
		};
	}
	const manifest = {
		format: "tedix-tedi-git-bundle",
		version: 1,
		exportedAt: "2026-09-28T02:00:00.000Z",
		sourceTediId: "a4d6765f-786b-446b-b9d1-3573b4330b9a",
		identity: {
			name: "CTO",
			slug: "cto",
			displayName: null,
			personality: null,
			avatar: null,
			timezone: null,
			language: null,
			tags: [],
			installedSkills: [],
			installedPlugins: [],
		},
		bindings: {
			runtimeProfile: null,
			policyPack: null,
			workspaceTemplateSet: null,
			apps: [],
		},
		artifacts: { defaultBranch: "main", head: "b".repeat(40) },
		files: sections,
	};
	return { files, manifest };
}

describe("portable tedi snapshot bytes", () => {
	it("verifies each named file before import", async () => {
		const { files, manifest } = await fixture();
		expect(await verifyPortableTediSnapshotFiles(manifest, files)).toEqual(
			manifest,
		);
	});

	it("rejects changed bytes even when the NDJSON row count is unchanged", async () => {
		const { files, manifest } = await fixture();
		files[paths.memoryFacts] = new TextEncoder().encode('{"id":"two"}\n');
		await expect(
			verifyPortableTediSnapshotFiles(manifest, files),
		).rejects.toThrow("digest mismatch: memoryFacts");
	});

	it("rejects an undeclared snapshot file", async () => {
		const { files, manifest } = await fixture();
		files["snapshot/credentials.ndjson"] = new TextEncoder().encode("{}\n");
		await expect(
			verifyPortableTediSnapshotFiles(manifest, files),
		).rejects.toThrow("Unlisted portable tedi snapshot");
	});

	it("rejects credential fields without echoing their values", async () => {
		const { files, manifest } = await fixture();
		const bytes = new TextEncoder().encode(
			'{"id":"one","apiKey":"do-not-export"}\n',
		);
		files[paths.skills] = bytes;
		const digest = new Uint8Array(
			await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)),
		);
		manifest.files.skills.sha256 = Array.from(digest, (part) =>
			part.toString(16).padStart(2, "0"),
		).join("");
		await expect(
			verifyPortableTediSnapshotFiles(manifest, files),
		).rejects.toThrow("Credential field in portable tedi: skills[1].apiKey");
	});

	it("rejects credential-shaped text in a normal content field", async () => {
		const { files, manifest } = await fixture();
		const bytes = new TextEncoder().encode(
			JSON.stringify({ id: "one", content: `sk_${"a".repeat(24)}` }) + "\n",
		);
		files[paths.memoryFacts] = bytes;
		const digest = new Uint8Array(
			await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)),
		);
		manifest.files.memoryFacts.sha256 = Array.from(digest, (part) =>
			part.toString(16).padStart(2, "0"),
		).join("");
		await expect(
			verifyPortableTediSnapshotFiles(manifest, files),
		).rejects.toThrow(
			"Credential-shaped content in portable tedi: memoryFacts[1].content",
		);
	});

	it("rejects malformed JSON and an inaccurate row count", async () => {
		const { files, manifest } = await fixture();
		const invalid = new TextEncoder().encode("not-json\n");
		files[paths.skills] = invalid;
		const digest = new Uint8Array(
			await crypto.subtle.digest("SHA-256", Uint8Array.from(invalid)),
		);
		manifest.files.skills.sha256 = Array.from(digest, (part) =>
			part.toString(16).padStart(2, "0"),
		).join("");
		await expect(
			verifyPortableTediSnapshotFiles(manifest, files),
		).rejects.toThrow("Invalid portable tedi JSON: skills row 1");
		manifest.files.skills.count = 2;
		await expect(
			verifyPortableTediSnapshotFiles(manifest, files),
		).rejects.toThrow("row count mismatch: skills");
	});
});

describe("portable tedi import preflight", () => {
	const closedGraph = {
		memoryDomains: [{ id: "domain", parentId: null }],
		memoryFacts: [
			{ id: "fact-a", domainId: "domain", promotedFrom: null },
			{ id: "fact-b", domainId: "domain", promotedFrom: "fact-a" },
		],
		memoryEdges: [
			{ id: "edge", sourceFactId: "fact-a", targetFactId: "fact-b" },
		],
		skills: [
			{
				id: "skill",
				domainId: "domain",
				sourceSkillId: null,
				supersedesId: null,
			},
		],
		rationale: [{ id: "decision" }],
	};

	it("accepts a closed graph and rejects references outside the bundle", () => {
		expect(() => validatePortableTediImportGraph(closedGraph)).not.toThrow();
		expect(() =>
			validatePortableTediImportGraph({
				...closedGraph,
				memoryDomains: [{ id: "domain", parentId: "missing" }],
			}),
		).toThrow("domain parent points outside");
		expect(() =>
			validatePortableTediImportGraph({
				...closedGraph,
				memoryEdges: [
					{ id: "edge", sourceFactId: "fact-a", targetFactId: "foreign" },
				],
			}),
		).toThrow("edge target points outside");
		expect(() =>
			validatePortableTediImportGraph({
				...closedGraph,
				skills: [{ ...closedGraph.skills[0]!, sourceSkillId: "foreign" }],
			}),
		).toThrow("source skill points outside");
		expect(() =>
			validatePortableTediImportGraph({
				...closedGraph,
				rationale: [{ id: "decision" }, { id: "decision" }],
			}),
		).toThrow("Duplicate portable rationale ID");
	});

	it("derives stable destination UUIDs separately for each tedi and section", async () => {
		const first = await portableTediDestinationId(
			"74cd1f9c-7e5d-49a5-aa39-c721839a9532",
			"memoryFacts",
			"source-id",
		);
		expect(first).toMatch(
			/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
		);
		expect(
			await portableTediDestinationId(
				"74cd1f9c-7e5d-49a5-aa39-c721839a9532",
				"memoryFacts",
				"source-id",
			),
		).toBe(first);
		expect(
			await portableTediDestinationId(
				"74cd1f9c-7e5d-49a5-aa39-c721839a9532",
				"skills",
				"source-id",
			),
		).not.toBe(first);
	});
});

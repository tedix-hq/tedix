import { expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	artifactService,
	evidenceDirVariable,
	shardArtifactName,
	uploadEvidenceArtifact,
	uploadShardEvidence,
} from "./upload-artifact.mjs";

test("the artifact service requires the runner's upload coordinates", () => {
	expect(artifactService({})).toBeUndefined();
	expect(
		artifactService({ ACTIONS_RESULTS_URL: "https://r/" }),
	).toBeUndefined();
	const service = artifactService({
		ACTIONS_RESULTS_URL: "https://results.example/run",
		ACTIONS_RUNTIME_TOKEN: "token",
	})!;
	expect(service.url).toBe("https://results.example/run/");
	expect(service.token).toBe("token");
});

test("the shard artifact name is unique per matrix cell and slash-free", () => {
	const name = shardArtifactName({
		WORKSPACE: "apps/os",
		TEST_SCRIPT: "test:browser:viewport",
		TEST_SHARD: "1/2",
		GITHUB_RUN_ATTEMPT: "2",
	});
	expect(name).toBe("browser-diagnostics-apps-os-test-browser-viewport-1-2-a2");
	expect(name).not.toContain("/");
	expect(name).not.toContain(":");
	expect(shardArtifactName({})).toBe(
		"browser-diagnostics-workspace-test-all-a1",
	);
});

const ciEnv = {
	ACTIONS_RESULTS_URL: "https://results.example/run/",
	ACTIONS_RUNTIME_TOKEN: "token",
	WORKSPACE: "apps/os",
};

function recordingFetch() {
	const calls: { url: string; method: string; body: unknown }[] = [];
	const impl = async (
		url: string,
		init: { method?: string; body?: unknown } = {},
	) => {
		calls.push({ url, method: init.method ?? "GET", body: init.body });
		if (String(url).includes("CreateArtifact"))
			return {
				ok: true,
				json: async () => ({
					ok: true,
					signedUploadUrl: "https://upload.example/signed",
				}),
			};
		if (String(url).includes("FinalizeArtifact"))
			return { ok: true, json: async () => ({ ok: true, artifactId: "42" }) };
		return { ok: true, status: 200 };
	};
	return { calls, impl: impl as unknown as typeof fetch };
}

test("a missing service or empty evidence dir uploads nothing", async () => {
	const root = mkdtempSync(join(tmpdir(), "artifact-upload-"));
	try {
		expect(
			await uploadEvidenceArtifact({ dir: root, name: "n", env: {} }),
		).toEqual({ uploaded: false, reason: "no artifact service" });
		expect(
			await uploadEvidenceArtifact({
				dir: join(root, "missing"),
				name: "n",
				env: ciEnv,
			}),
		).toEqual({ uploaded: false, reason: "no evidence" });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("evidence is zipped, uploaded to the signed URL and finalized", async () => {
	const root = mkdtempSync(join(tmpdir(), "artifact-upload-"));
	try {
		const dir = join(root, ".cache");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "error.txt"), "boom");
		const { calls, impl } = recordingFetch();
		const zipped: string[] = [];
		const result = await uploadEvidenceArtifact({
			dir,
			name: "browser-diagnostics-apps-os-test-all-a1",
			env: ciEnv,
			fetchImpl: impl,
			zip: async (source: string, archive: string) => {
				zipped.push(source);
				writeFileSync(archive, "zip-bytes");
				return archive;
			},
		});
		expect(result).toMatchObject({ uploaded: true, artifactId: "42", size: 9 });
		expect(zipped).toEqual([dir]);
		expect(calls.map((call) => call.method)).toEqual(["POST", "PUT", "POST"]);
		expect(calls[0]!.url).toContain("ArtifactService/CreateArtifact");
		const create = JSON.parse(String(calls[0]!.body)) as {
			name: string;
			expiresAt: string;
		};
		expect(create.name).toBe("browser-diagnostics-apps-os-test-all-a1");
		const retentionMs = Date.parse(create.expiresAt) - Date.now();
		expect(retentionMs).toBeGreaterThan(13 * 86_400_000);
		expect(retentionMs).toBeLessThanOrEqual(14 * 86_400_000);
		expect(calls[1]!.url).toBe("https://upload.example/signed");
		expect(calls[2]!.url).toContain("ArtifactService/FinalizeArtifact");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

for (const configured of [undefined, "diagnostics", "absolute"] as const) {
	test(`shard uploads use ${configured ?? "default"} evidence directory`, async () => {
		const root = mkdtempSync(join(tmpdir(), "artifact-upload-"));
		try {
			const workspace = join(root, "apps/os");
			const dir = join(
				configured === "absolute" ? root : workspace,
				configured ? "diagnostics" : "browser-tests/.cache",
			);
			const setting = configured === "absolute" ? dir : configured;
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "error.txt"), "recorded failure");
			const { impl, calls } = recordingFetch();
			const zipped: string[] = [];
			const result = await uploadShardEvidence(
				{ ...ciEnv, WORKSPACE: workspace, [evidenceDirVariable]: setting },
				{
					fetchImpl: impl,
					zip: (source: string, archive: string) => {
						zipped.push(source);
						writeFileSync(archive, "zip-bytes");
					},
				},
			);
			expect(result).toMatchObject({ uploaded: true, artifactId: "42" });
			expect(zipped).toEqual([dir]);
			expect(calls).toHaveLength(3);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}

test("a shard upload failure is reported but never thrown", async () => {
	const root = mkdtempSync(join(tmpdir(), "artifact-upload-"));
	try {
		mkdirSync(join(root, "apps/os/browser-tests/.cache"), {
			recursive: true,
		});
		writeFileSync(
			join(root, "apps/os/browser-tests/.cache", "error.txt"),
			"boom",
		);
		const result = await uploadShardEvidence(
			{ ...ciEnv, WORKSPACE: join(root, "apps/os") },
			{
				zip: async () => {
					throw new Error("zip missing");
				},
			},
		);
		expect(result.uploaded).toBe(false);
		expect(result.reason).toContain("zip missing");
		expect(existsSync(join(root, "apps/os/browser-tests/.cache"))).toBe(true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

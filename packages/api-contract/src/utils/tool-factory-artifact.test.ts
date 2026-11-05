import { describe, expect, it } from "vite-plus/test";
import type { ToolFactoryArtifactManifest } from "../schemas/tool-factory-artifact";
import {
	createToolFactoryTaskReceipt,
	signToolFactoryArtifact,
	verifyAndImportToolFactoryArtifact,
	verifyToolFactoryTaskReceipt,
} from "./tool-factory-artifact";

const encoder = new TextEncoder();

async function digest(value: string): Promise<string> {
	return [
		...new Uint8Array(
			await crypto.subtle.digest("SHA-256", encoder.encode(value)),
		),
	]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

async function fixture() {
	const provider =
		`${"the"}${"rion"}` as ToolFactoryArtifactManifest["tool"]["provider"];
	const toolId = `${provider}_review_input`;
	const payloads = {
		"SKILL.md": "---\nname: reliable-review\n---\nReview one bounded input.\n",
		"workflow.js":
			"export default async ({ input }) => ({ reviewed: input });\n",
	};
	const resources = await Promise.all(
		Object.entries(payloads).map(async ([path, payload]) => ({
			path,
			mediaType: path.endsWith(".md") ? "text/markdown" : "text/javascript",
			sha256: await digest(payload),
			size: encoder.encode(payload).byteLength,
		})),
	);
	const skillId = "cd2c2d90-a7f1-4b5e-9d7b-3103b7fb4383";
	const runId = "ef566ca7-982b-4e7e-af7f-0641484d0ab6";
	const manifest: ToolFactoryArtifactManifest = {
		format: "tedix.tool-factory/v1",
		artifact: {
			id: "925dd6cf-97c9-45cd-a727-cf22ed05b449",
			version: "1.0.0",
			createdAt: "2026-11-05T00:00:00.000Z",
		},
		skill: {
			id: skillId,
			slug: "reliable-review",
			revision: 7,
			lifecycle: "proven",
		},
		evidence: [
			{
				runId,
				executionEpoch: 3,
				status: "completed",
				completedAt: "2026-11-04T23:59:00.000Z",
				manifestSha256: "a".repeat(64),
			},
		],
		resources,
		sbom: {
			bomFormat: "CycloneDX",
			specVersion: "1.6",
			serialNumber: "urn:uuid:925dd6cf-97c9-45cd-a727-cf22ed05b449",
			version: 1,
			metadata: {
				timestamp: "2026-11-05T00:00:00.000Z",
				component: {
					type: "application",
					name: "reliable-review",
					version: "1.0.0",
				},
			},
			components: resources.map((resource) => ({
				type: "file",
				name: resource.path,
				hashes: [{ alg: "SHA-256", content: resource.sha256 }],
			})),
		},
		provenance: {
			predicateType: "https://slsa.dev/provenance/v1",
			buildType: "https://tedix.dev/tool-factory/v1",
			builder: { id: "https://tedix.dev/builders/tool-factory" },
			invocation: { skillId, skillRevision: 7, runIds: [runId] },
			materials: resources.map((resource) => ({
				uri: resource.path,
				sha256: resource.sha256,
			})),
		},
		tool: {
			provider,
			toolId,
			title: "Review input",
			description: "Runs the proven bounded review capability.",
			inputSchema: {
				type: "object",
				properties: { input: { type: "string" } },
				required: ["input"],
				additionalProperties: false,
			},
			outputSchema: {
				type: "object",
				properties: { reviewed: { type: "string" } },
			},
			mcpServerUrl: "https://provider.example.test/mcp",
			requiredScopes: ["mcp:skills.admin"],
			approvalPolicy: "work_item",
			writeCapability: "destructive",
		},
		taskContract: {
			contractId: "f16e860d-6808-4ddb-8754-ad0260bd8f2b",
			version: 1,
			toolId,
			schedule: { kind: "cron", expression: "15 * * * *", timezone: "UTC" },
			input: { source: "factory-inbox" },
		},
	};
	const keys = await crypto.subtle.generateKey("Ed25519", true, [
		"sign",
		"verify",
	]);
	const artifact = await signToolFactoryArtifact({
		manifest,
		payloads,
		keyId: "tool-factory-2026-11",
		privateKey: keys.privateKey,
	});
	return { artifact, keys };
}

describe("signed tool-factory artefacts", () => {
	it("promotes proven execution evidence and imports a scoped provider tool", async () => {
		const { artifact, keys } = await fixture();
		const imported = await verifyAndImportToolFactoryArtifact({
			artifact,
			trustedKeys: new Map([[artifact.signature.keyId, keys.publicKey]]),
		});

		expect(imported.verifiedKeyId).toBe("tool-factory-2026-11");
		expect(imported.tool).toMatchObject({
			toolTypeId: "mcp",
			toolId: artifact.manifest.tool.toolId,
			authRequired: true,
			writeCapability: "destructive",
			config: { transport: "mcp", approvalPolicy: "work_item" },
		});
		expect(imported.gateway).toEqual({
			authMode: "authenticated",
			toolScopes: {
				[artifact.manifest.tool.toolId]: ["mcp:skills.admin"],
			},
		});

		const receipt = await createToolFactoryTaskReceipt({
			imported,
			receiptId: "f2a79f59-c006-495b-ad50-3e69a14d18c9",
			scheduledAt: "2026-11-05T01:15:00.000Z",
			runId: "a7628c8a-b418-4487-94c7-a74c35667ce0",
			status: "completed",
		});
		expect(receipt).toMatchObject({
			contractId: imported.taskContract.contractId,
			contractVersion: 1,
			status: "completed",
		});
		expect(await verifyToolFactoryTaskReceipt({ receipt, imported })).toBe(
			true,
		);
	});

	it("rejects a modified payload on re-import", async () => {
		const { artifact, keys } = await fixture();
		const modified = structuredClone(artifact);
		modified.payloads["workflow.js"] += "// modified";
		await expect(
			verifyAndImportToolFactoryArtifact({
				artifact: modified,
				trustedKeys: new Map([[artifact.signature.keyId, keys.publicKey]]),
			}),
		).rejects.toThrow("payload size mismatch");
	});

	it("rejects a changed manifest and an untrusted signer", async () => {
		const { artifact, keys } = await fixture();
		const changed = structuredClone(artifact);
		changed.manifest.tool.approvalPolicy = "always";
		await expect(
			verifyAndImportToolFactoryArtifact({
				artifact: changed,
				trustedKeys: new Map([[artifact.signature.keyId, keys.publicKey]]),
			}),
		).rejects.toThrow("manifest digest");
		await expect(
			verifyAndImportToolFactoryArtifact({
				artifact,
				trustedKeys: new Map(),
			}),
		).rejects.toThrow("signer is not trusted");
	});
});

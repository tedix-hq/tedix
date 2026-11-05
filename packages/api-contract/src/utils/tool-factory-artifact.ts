import {
	SignedToolFactoryArtifactSchema,
	ToolFactoryArtifactManifestSchema,
	ToolFactoryTaskReceiptSchema,
	type SignedToolFactoryArtifact,
	type ToolFactoryArtifactManifest,
	type ToolFactoryTaskReceipt,
} from "../schemas/tool-factory-artifact";

const encoder = new TextEncoder();

function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "string")
		return JSON.stringify(value);
	if (typeof value === "number" && Number.isFinite(value)) return `${value}`;
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
			.join(",")}}`;
	}
	throw new TypeError("Tool-factory artefacts must contain JSON values only");
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function toBase64(value: ArrayBuffer): string {
	return btoa(String.fromCharCode(...new Uint8Array(value)));
}

function fromBase64(value: string): ArrayBuffer {
	try {
		const decoded = Uint8Array.from(atob(value), (character) =>
			character.charCodeAt(0),
		);
		return new Uint8Array(decoded).buffer;
	} catch {
		throw new Error("Artifact signature is not valid base64");
	}
}

async function verifyManifestBindings(
	manifest: ToolFactoryArtifactManifest,
	payloads: Record<string, string>,
): Promise<void> {
	const resourcePaths = new Set(
		manifest.resources.map((resource) => resource.path),
	);
	if (
		Object.keys(payloads).length !== resourcePaths.size ||
		Object.keys(payloads).some((path) => !resourcePaths.has(path))
	) {
		throw new Error("Artifact payload set does not match its signed manifest");
	}
	for (const resource of manifest.resources) {
		const payload = payloads[resource.path];
		if (payload === undefined)
			throw new Error(`Missing payload: ${resource.path}`);
		if (encoder.encode(payload).byteLength !== resource.size)
			throw new Error(`Artifact payload size mismatch: ${resource.path}`);
		if ((await sha256(payload)) !== resource.sha256)
			throw new Error(`Artifact payload digest mismatch: ${resource.path}`);
	}
	const sbomHashes = new Map(
		manifest.sbom.components.flatMap((component) =>
			component.hashes.map((hash) => [component.name, hash.content] as const),
		),
	);
	for (const resource of manifest.resources) {
		if (sbomHashes.get(resource.path) !== resource.sha256)
			throw new Error(`SBOM does not bind artifact resource: ${resource.path}`);
	}
	const provenanceMaterials = new Map(
		manifest.provenance.materials.map((material) => [
			material.uri,
			material.sha256,
		]),
	);
	for (const resource of manifest.resources) {
		if (provenanceMaterials.get(resource.path) !== resource.sha256)
			throw new Error(
				`Provenance does not bind artifact resource: ${resource.path}`,
			);
	}
}

export async function signToolFactoryArtifact(input: {
	manifest: ToolFactoryArtifactManifest;
	payloads: Record<string, string>;
	keyId: string;
	privateKey: CryptoKey;
	verifyExecutionEvidence: (
		evidence: ToolFactoryArtifactManifest["evidence"][number],
		skill: ToolFactoryArtifactManifest["skill"],
	) => Promise<boolean>;
}): Promise<SignedToolFactoryArtifact> {
	const manifest = ToolFactoryArtifactManifestSchema.parse(input.manifest);
	const evidenceVerified = await Promise.all(
		manifest.evidence.map((evidence) =>
			input.verifyExecutionEvidence(evidence, manifest.skill),
		),
	);
	if (evidenceVerified.some((verified) => !verified))
		throw new Error(
			"Skill promotion requires canonical successful-run evidence",
		);
	await verifyManifestBindings(manifest, input.payloads);
	const serialized = canonicalJson(manifest);
	const signedDigest = await sha256(serialized);
	const signature = await crypto.subtle.sign(
		"Ed25519",
		input.privateKey,
		encoder.encode(serialized),
	);
	return SignedToolFactoryArtifactSchema.parse({
		manifest,
		payloads: input.payloads,
		signature: {
			algorithm: "Ed25519",
			keyId: input.keyId,
			signedDigest,
			value: toBase64(signature),
		},
	});
}

export interface ImportedToolFactoryArtifact {
	artifactDigest: string;
	verifiedKeyId: string;
	tool: {
		toolTypeId: "mcp";
		toolId: string;
		title: string;
		description: string;
		inputSchema: ToolFactoryArtifactManifest["tool"]["inputSchema"];
		outputSchema?: ToolFactoryArtifactManifest["tool"]["outputSchema"];
		authRequired: true;
		writeCapability: ToolFactoryArtifactManifest["tool"]["writeCapability"];
		config: {
			transport: "mcp";
			mcpServerUrl: string;
			mcpToolName: string;
			approvalPolicy: ToolFactoryArtifactManifest["tool"]["approvalPolicy"];
		};
		schemaSource: "mcp";
		schemaSourceRef: string;
		schemaSourceHash: string;
	};
	gateway: {
		authMode: "authenticated";
		toolScopes: Record<string, string[]>;
	};
	taskContract: ToolFactoryArtifactManifest["taskContract"];
}

export async function verifyAndImportToolFactoryArtifact(input: {
	artifact: SignedToolFactoryArtifact;
	trustedKeys: ReadonlyMap<string, CryptoKey>;
}): Promise<ImportedToolFactoryArtifact> {
	const artifact = SignedToolFactoryArtifactSchema.parse(input.artifact);
	const publicKey = input.trustedKeys.get(artifact.signature.keyId);
	if (!publicKey) throw new Error("Artifact signer is not trusted");
	const serialized = canonicalJson(artifact.manifest);
	const artifactDigest = await sha256(serialized);
	if (artifactDigest !== artifact.signature.signedDigest)
		throw new Error("Artifact manifest digest does not match its signature");
	const verified = await crypto.subtle.verify(
		"Ed25519",
		publicKey,
		fromBase64(artifact.signature.value),
		encoder.encode(serialized),
	);
	if (!verified) throw new Error("Artifact signature verification failed");
	await verifyManifestBindings(artifact.manifest, artifact.payloads);

	const { tool, artifact: identity } = artifact.manifest;
	return {
		artifactDigest,
		verifiedKeyId: artifact.signature.keyId,
		tool: {
			toolTypeId: "mcp",
			toolId: tool.toolId,
			title: tool.title,
			description: tool.description,
			inputSchema: tool.inputSchema,
			...(tool.outputSchema === undefined
				? {}
				: { outputSchema: tool.outputSchema }),
			authRequired: true,
			writeCapability: tool.writeCapability,
			config: {
				transport: "mcp",
				mcpServerUrl: tool.mcpServerUrl,
				mcpToolName: tool.toolId,
				approvalPolicy: tool.approvalPolicy,
			},
			schemaSource: "mcp",
			schemaSourceRef: `${identity.id}@${identity.version}`,
			schemaSourceHash: artifactDigest,
		},
		gateway: {
			authMode: "authenticated",
			toolScopes: { [tool.toolId]: [...tool.requiredScopes] },
		},
		taskContract: artifact.manifest.taskContract,
	};
}

export async function createToolFactoryTaskReceipt(input: {
	imported: ImportedToolFactoryArtifact;
	receiptId: string;
	scheduledAt: string;
	runId: string;
	status: "completed" | "failed";
}): Promise<ToolFactoryTaskReceipt> {
	return ToolFactoryTaskReceiptSchema.parse({
		receiptId: input.receiptId,
		contractId: input.imported.taskContract.contractId,
		contractVersion: input.imported.taskContract.version,
		artifactDigest: input.imported.artifactDigest,
		contractDigest: await sha256(canonicalJson(input.imported.taskContract)),
		scheduledAt: input.scheduledAt,
		runId: input.runId,
		status: input.status,
	});
}

export async function verifyToolFactoryTaskReceipt(input: {
	receipt: ToolFactoryTaskReceipt;
	imported: ImportedToolFactoryArtifact;
}): Promise<boolean> {
	const receipt = ToolFactoryTaskReceiptSchema.parse(input.receipt);
	return (
		receipt.contractId === input.imported.taskContract.contractId &&
		receipt.contractVersion === input.imported.taskContract.version &&
		receipt.artifactDigest === input.imported.artifactDigest &&
		receipt.contractDigest ===
			(await sha256(canonicalJson(input.imported.taskContract)))
	);
}

import * as z from "zod";
import {
	ToolInputJsonSchemaSchema,
	ToolJsonSchemaSchema,
	ToolWriteCapabilitySchema,
} from "./tools";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const ArtifactVersionSchema = z.string().regex(/^[1-9]\d*\.\d+\.\d+$/);
const ResourcePathSchema = z
	.string()
	.min(1)
	.max(240)
	.refine(
		(path) =>
			!path.startsWith("/") &&
			!path.includes("\\") &&
			!path.split("/").includes(".."),
		"Artifact resource paths must be relative and may not traverse directories",
	);

export const ToolFactoryResourceSchema = z
	.object({
		path: ResourcePathSchema,
		mediaType: z.string().min(1),
		sha256: Sha256Schema,
		size: z.number().int().nonnegative(),
	})
	.strict();

export const ToolFactoryExecutionEvidenceSchema = z
	.object({
		runId: z.uuid(),
		executionEpoch: z.number().int().nonnegative(),
		status: z.literal("completed"),
		completedAt: z.iso.datetime(),
		manifestSha256: Sha256Schema,
	})
	.strict();

export const ToolFactorySbomSchema = z
	.object({
		bomFormat: z.literal("CycloneDX"),
		specVersion: z.literal("1.6"),
		serialNumber: z.string().regex(/^urn:uuid:[0-9a-f-]{36}$/),
		version: z.literal(1),
		metadata: z
			.object({
				timestamp: z.iso.datetime(),
				component: z
					.object({
						type: z.literal("application"),
						name: z.string().min(1),
						version: ArtifactVersionSchema,
					})
					.strict(),
			})
			.strict(),
		components: z.array(
			z
				.object({
					type: z.enum(["file", "library"]),
					name: z.string().min(1),
					version: z.string().min(1).optional(),
					hashes: z
						.array(
							z
								.object({ alg: z.literal("SHA-256"), content: Sha256Schema })
								.strict(),
						)
						.min(1),
				})
				.strict(),
		),
	})
	.strict();

export const ToolFactoryProvenanceSchema = z
	.object({
		predicateType: z.literal("https://slsa.dev/provenance/v1"),
		buildType: z.literal("https://tedix.dev/tool-factory/v1"),
		builder: z.object({ id: z.string().min(1) }).strict(),
		invocation: z
			.object({
				skillId: z.uuid(),
				skillRevision: z.number().int().positive(),
				runIds: z.array(z.uuid()).min(1),
			})
			.strict(),
		materials: z
			.array(
				z.object({ uri: z.string().min(1), sha256: Sha256Schema }).strict(),
			)
			.min(1),
	})
	.strict();

export const ToolFactoryTaskContractSchema = z
	.object({
		contractId: z.uuid(),
		version: z.number().int().positive(),
		toolId: z.string().regex(/^factory_[a-z0-9_]+$/),
		schedule: z
			.object({
				kind: z.literal("cron"),
				expression: z.string().regex(/^(\S+\s+){4}\S+$/),
				timezone: z.literal("UTC"),
			})
			.strict(),
		input: z.record(z.string(), z.json()),
	})
	.strict();

export const ToolFactoryArtifactManifestSchema = z
	.object({
		format: z.literal("tedix.tool-factory/v1"),
		artifact: z
			.object({
				id: z.uuid(),
				version: ArtifactVersionSchema,
				createdAt: z.iso.datetime(),
			})
			.strict(),
		skill: z
			.object({
				id: z.uuid(),
				slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
				revision: z.number().int().positive(),
				lifecycle: z.literal("proven"),
			})
			.strict(),
		evidence: z.array(ToolFactoryExecutionEvidenceSchema).min(1),
		resources: z.array(ToolFactoryResourceSchema).min(1),
		sbom: ToolFactorySbomSchema,
		provenance: ToolFactoryProvenanceSchema,
		tool: z
			.object({
				provider: z.literal("factory"),
				toolId: z.string().regex(/^factory_[a-z0-9_]+$/),
				title: z.string().min(1),
				description: z.string().min(1),
				inputSchema: ToolInputJsonSchemaSchema,
				outputSchema: ToolJsonSchemaSchema.optional(),
				mcpServerUrl: z.url(),
				requiredScopes: z.array(z.string().min(1)).min(1),
				approvalPolicy: z.enum(["always", "work_item"]),
				writeCapability: ToolWriteCapabilitySchema,
			})
			.strict(),
		taskContract: ToolFactoryTaskContractSchema,
	})
	.strict()
	.superRefine((manifest, context) => {
		const paths = manifest.resources.map((resource) => resource.path);
		if (new Set(paths).size !== paths.length) {
			context.addIssue({
				code: "custom",
				message: "Artifact resource paths must be unique",
				path: ["resources"],
			});
		}
		const evidenceSlots = manifest.evidence.map(
			(item) => `${item.runId}:${item.executionEpoch}`,
		);
		if (new Set(evidenceSlots).size !== evidenceSlots.length) {
			context.addIssue({
				code: "custom",
				message: "Successful execution evidence must name unique run epochs",
				path: ["evidence"],
			});
		}
		if (manifest.taskContract.toolId !== manifest.tool.toolId) {
			context.addIssue({
				code: "custom",
				message: "Task Contract tool must match the promoted tool",
				path: ["taskContract", "toolId"],
			});
		}
		if (
			manifest.provenance.invocation.skillId !== manifest.skill.id ||
			manifest.provenance.invocation.skillRevision !== manifest.skill.revision
		) {
			context.addIssue({
				code: "custom",
				message: "Provenance must name the promoted skill revision",
				path: ["provenance", "invocation"],
			});
		}
		const evidenceRuns = new Set(manifest.evidence.map((item) => item.runId));
		if (
			manifest.provenance.invocation.runIds.some(
				(runId) => !evidenceRuns.has(runId),
			)
		) {
			context.addIssue({
				code: "custom",
				message: "Provenance run IDs must have successful execution evidence",
				path: ["provenance", "invocation", "runIds"],
			});
		}
	});

export const SignedToolFactoryArtifactSchema = z
	.object({
		manifest: ToolFactoryArtifactManifestSchema,
		payloads: z.record(ResourcePathSchema, z.string()),
		signature: z
			.object({
				algorithm: z.literal("Ed25519"),
				keyId: z.string().min(1),
				signedDigest: Sha256Schema,
				value: z.string().min(1),
			})
			.strict(),
	})
	.strict();

export const ToolFactoryTaskReceiptSchema = z
	.object({
		receiptId: z.uuid(),
		contractId: z.uuid(),
		contractVersion: z.number().int().positive(),
		artifactDigest: Sha256Schema,
		contractDigest: Sha256Schema,
		scheduledAt: z.iso.datetime(),
		runId: z.uuid(),
		status: z.enum(["completed", "failed"]),
	})
	.strict();

export type ToolFactoryArtifactManifest = z.infer<
	typeof ToolFactoryArtifactManifestSchema
>;
export type SignedToolFactoryArtifact = z.infer<
	typeof SignedToolFactoryArtifactSchema
>;
export type ToolFactoryTaskReceipt = z.infer<
	typeof ToolFactoryTaskReceiptSchema
>;

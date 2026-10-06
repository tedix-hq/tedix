import * as z from "zod";
import { SkillEntrySchema } from "./cognitive";
import { DomainSchema, EdgeSchema, FactSchema } from "./memory-graph";
import { RationaleRecordSchema } from "./rationale-records";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const SnapshotPathSchema = z
	.string()
	.regex(/^snapshot\/[a-z][a-z0-9-]*\.ndjson$/);

/**
 * The manifest describes the portable snapshot without putting the potentially
 * large memory graph in one JSON document. Each NDJSON file is content-addressed
 * so import can validate every byte before creating a destination tedi.
 */
export const PortableTediSnapshotFileSchema = z.strictObject({
	path: SnapshotPathSchema,
	sha256: Sha256Schema,
	count: z.number().int().nonnegative(),
});

export const PortableTediControlBindingSchema = z.strictObject({
	scope: z.enum(["system", "organization"]),
	slug: z.string().min(1),
	version: z.number().int().positive(),
});

export const PortableTediIdentitySchema = z.strictObject({
	name: z.string().min(1),
	slug: z.string().min(1),
	displayName: z.string().nullable(),
	personality: z.string().nullable(),
	avatar: z.string().nullable(),
	timezone: z.string().nullable(),
	language: z.string().nullable(),
	tags: z.array(z.string()),
	installedSkills: z.array(z.string()),
	installedPlugins: z.array(z.string()),
});

export const PortableTediBindingsSchema = z.strictObject({
	runtimeProfile: PortableTediControlBindingSchema.nullable(),
	policyPack: PortableTediControlBindingSchema.nullable(),
	workspaceTemplateSet: PortableTediControlBindingSchema.nullable(),
	apps: z.array(z.string()),
});

export const PortableTediManifestSchema = z
	.strictObject({
		format: z.literal("tedix-tedi-git-bundle"),
		version: z.literal(1),
		exportedAt: z.iso.datetime(),
		sourceTediId: z.uuid(),
		identity: PortableTediIdentitySchema,
		/** Descriptive identities only; destination-owned IDs are rebound. */
		bindings: PortableTediBindingsSchema,
		artifacts: z.strictObject({
			defaultBranch: z.literal("main"),
			/** Null only when the source tedi has not initialized its Artifacts repo. */
			head: z
				.string()
				.regex(/^[a-f0-9]{40}$/)
				.nullable(),
		}),
		files: z.strictObject({
			memoryDomains: PortableTediSnapshotFileSchema,
			memoryFacts: PortableTediSnapshotFileSchema,
			memoryEdges: PortableTediSnapshotFileSchema,
			skills: PortableTediSnapshotFileSchema,
			rationale: PortableTediSnapshotFileSchema,
		}),
	})
	.superRefine((manifest, ctx) => {
		const expectedPaths = {
			memoryDomains: "snapshot/memory-domains.ndjson",
			memoryFacts: "snapshot/memory-facts.ndjson",
			memoryEdges: "snapshot/memory-edges.ndjson",
			skills: "snapshot/skills.ndjson",
			rationale: "snapshot/rationale.ndjson",
		} as const;
		for (const [key, expectedPath] of Object.entries(expectedPaths)) {
			if (
				manifest.files[key as keyof typeof expectedPaths].path !== expectedPath
			) {
				ctx.addIssue({
					code: "custom",
					path: ["files", key, "path"],
					message: `Expected ${expectedPath}`,
				});
			}
		}
	});

export type PortableTediManifest = z.infer<typeof PortableTediManifestSchema>;

export const PortableTediSnapshotSectionSchema = z.enum([
	"memoryDomains",
	"memoryFacts",
	"memoryEdges",
	"skills",
	"rationale",
]);

export const PortableTediSnapshotPageInputSchema = z.strictObject({
	tediId: z.uuid(),
	section: PortableTediSnapshotSectionSchema,
	afterId: z.string().min(1).optional(),
	limit: z.number().int().min(1).max(100).optional(),
});
export type PortableTediSnapshotPageInput = z.infer<
	typeof PortableTediSnapshotPageInputSchema
>;

/** The read credential is short lived and must never be written into a bundle. */
export const PortableTediGitReadAccessInputSchema = z.strictObject({
	tediId: z.uuid(),
});
const PortableTediSnapshotAccessSchema = z.strictObject({
	url: z.url().startsWith("https://"),
	token: z.string().min(1),
	expiresAt: z.iso.datetime(),
});
export const PortableTediGitReadAccessOutputSchema = z.discriminatedUnion(
	"repoFound",
	[
		z.strictObject({
			repoFound: z.literal(false),
			identity: PortableTediIdentitySchema,
			bindings: PortableTediBindingsSchema,
			snapshot: PortableTediSnapshotAccessSchema,
		}),
		z.strictObject({
			repoFound: z.literal(true),
			identity: PortableTediIdentitySchema,
			bindings: PortableTediBindingsSchema,
			snapshot: PortableTediSnapshotAccessSchema,
			remote: z.url().startsWith("https://"),
			token: z.string().min(1),
			expiresAt: z.iso.datetime(),
		}),
	],
);

export const PortableTediDomainSchema = DomainSchema.omit({
	organizationId: true,
});
export const PortableTediFactSchema = FactSchema.omit({
	organizationId: true,
	tediId: true,
	embeddingId: true,
}).extend({
	// Preserve historical values even if the active fact taxonomy later narrows.
	factType: z.string().min(1),
});
export const PortableTediEdgeSchema = EdgeSchema.extend({
	// Historical D1 strengths exceed 1; portability must preserve stored values.
	strength: z.number().finite(),
});
export const PortableTediSkillSchema = SkillEntrySchema.omit({
	organizationId: true,
	tediId: true,
	r2Path: true,
});
export const PortableTediRationaleSchema = RationaleRecordSchema.omit({
	orgId: true,
	tediId: true,
});

/** A user starts import into a fresh, paused destination identity. */
export const PortableTediImportBeginInputSchema = z.strictObject({
	manifest: PortableTediManifestSchema,
	destinationSlug: z
		.string()
		.min(1)
		.max(50)
		.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
});

export const PortableTediImportBeginOutputSchema = z.strictObject({
	tediId: z.uuid(),
	manifestSha256: Sha256Schema,
	snapshot: PortableTediSnapshotAccessSchema,
	git: z.strictObject({
		remote: z.url().startsWith("https://"),
		token: z.string().min(1),
		expiresAt: z.iso.datetime(),
	}),
});

/** Signed bulk HTTP uploads are bounded by row count and validated per section. */
export const PortableTediImportPageSchema = z.discriminatedUnion("section", [
	z.strictObject({
		section: z.literal("memoryDomains"),
		rows: z.array(PortableTediDomainSchema).max(100),
	}),
	z.strictObject({
		section: z.literal("memoryFacts"),
		rows: z.array(PortableTediFactSchema).max(100),
	}),
	z.strictObject({
		section: z.literal("memoryEdges"),
		rows: z.array(PortableTediEdgeSchema).max(100),
	}),
	z.strictObject({
		section: z.literal("skills"),
		rows: z.array(PortableTediSkillSchema).max(100),
	}),
	z.strictObject({
		section: z.literal("skillLinks"),
		rows: z.array(PortableTediSkillSchema).max(100),
	}),
	z.strictObject({
		section: z.literal("rationale"),
		rows: z.array(PortableTediRationaleSchema).max(100),
	}),
]);

const pageResult = {
	nextAfterId: z.string().nullable(),
};
export const PortableTediSnapshotPageOutputSchema = z.discriminatedUnion(
	"section",
	[
		z.strictObject({
			...pageResult,
			section: z.literal("memoryDomains"),
			rows: z.array(PortableTediDomainSchema),
		}),
		z.strictObject({
			...pageResult,
			section: z.literal("memoryFacts"),
			rows: z.array(PortableTediFactSchema),
		}),
		z.strictObject({
			...pageResult,
			section: z.literal("memoryEdges"),
			rows: z.array(PortableTediEdgeSchema),
		}),
		z.strictObject({
			...pageResult,
			section: z.literal("skills"),
			rows: z.array(PortableTediSkillSchema),
		}),
		z.strictObject({
			...pageResult,
			section: z.literal("rationale"),
			rows: z.array(PortableTediRationaleSchema),
		}),
	],
);

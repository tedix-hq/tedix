import * as z from "zod";
import { JsonValueSchema } from "./common";
import { REPOSITORY_CANDIDATE_MAX_FILES } from "../utils/repository-candidate";

const GitRevisionSchema = z.string().regex(/^[a-f0-9]{40}$/);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const RepositoryCandidatePathSchema = z
	.string()
	.min(1)
	.max(1024)
	.refine(
		(path) =>
			!path.startsWith("/") &&
			!path.includes("\\") &&
			!/[\u0000-\u001f]/.test(path) &&
			path.split("/").length <= 32 &&
			path
				.split("/")
				.every((part) => part !== "" && part !== "." && part !== ".."),
		"Use a repository-relative path without traversal",
	);
export const RepositoryCandidateSelectedPathsSchema = z
	.array(RepositoryCandidatePathSchema)
	.min(1)
	.max(REPOSITORY_CANDIDATE_MAX_FILES)
	.refine(
		(paths) => new Set(paths).size === paths.length,
		"Choose distinct files",
	);

/** Server-reserved discovery data on an Attempt; never a replacement for its authority. */
export const RepositoryCandidateDescriptorSchema = z.strictObject({
	version: z.literal(1),
	organizationId: z.string().min(1),
	workItemId: z.uuid(),
	attemptId: z.uuid(),
	admissionId: z.uuid(),
	repositoryId: z.string().min(1).max(300),
	repositoryName: z.string().min(1).max(128),
	baseRevision: GitRevisionSchema,
	files: z
		.array(
			z.strictObject({
				path: RepositoryCandidatePathSchema,
				blobRevision: GitRevisionSchema,
				bytes: z.number().int().nonnegative().max(65536),
			}),
		)
		.min(1)
		.max(REPOSITORY_CANDIDATE_MAX_FILES),
	selectionDigest: DigestSchema,
	roomName: z.string().min(1).max(500),
	docKey: z.string().min(1).max(500),
	createdAt: z.iso.datetime(),
});
export type RepositoryCandidateDescriptor = z.infer<
	typeof RepositoryCandidateDescriptorSchema
>;
export const RepositoryCandidatePositionSchema = z.strictObject({
	generation: z.number().int().nonnegative(),
	revision: z.number().int().nonnegative(),
});
export const RepositoryCandidateSubmissionSchema = z.strictObject({
	generation: z.number().int().nonnegative(),
	revision: z.number().int().nonnegative(),
	clientId: z.string().regex(/^[0-9A-Za-z_-]{1,64}$/),
	seq: z.number().int().positive(),
	change: JsonValueSchema.describe(
		"Existing OT CodeChange JSON; only text edits to the frozen selected paths are accepted",
	),
});
export const RepositoryCandidateStateSchema = z.strictObject({
	snapshot: z.strictObject({
		position: RepositoryCandidatePositionSchema,
		canonical: z.strictObject({
			revision: z.literal(0),
			revisionId: GitRevisionSchema,
		}),
		files: z.record(z.string(), z.string()),
	}),
	contentDigest: DigestSchema,
	sealed: z.boolean(),
	seal: z
		.strictObject({
			position: RepositoryCandidatePositionSchema,
			contentDigest: DigestSchema,
		})
		.nullable(),
});
export type RepositoryCandidateState = z.infer<
	typeof RepositoryCandidateStateSchema
>;
export const RepositoryCandidateInputSchema = z.strictObject({
	id: z.uuid(),
	attemptId: z.uuid(),
});
export const InitializeRepositoryCandidateInputSchema =
	RepositoryCandidateInputSchema.extend({
		expectedBaseRevision: GitRevisionSchema,
		paths: RepositoryCandidateSelectedPathsSchema,
	}).strict();
export const SubmitRepositoryCandidateInputSchema =
	RepositoryCandidateInputSchema.extend({
		submission: RepositoryCandidateSubmissionSchema,
	}).strict();
export const SealRepositoryCandidateInputSchema =
	RepositoryCandidateInputSchema.extend({
		expectedPosition: RepositoryCandidatePositionSchema,
		expectedContentDigest: DigestSchema,
	}).strict();
export const RepositoryCandidateResultSchema = z.strictObject({
	descriptor: RepositoryCandidateDescriptorSchema,
	state: RepositoryCandidateStateSchema,
	writtenToRepository: z.literal(false),
});

export const RepositoryCandidateActorSchema = z.strictObject({
	key: z.string().min(1).max(128),
	kind: z.enum(["human", "tedi", "external_agent"]),
	displayName: z.string().min(1).max(128),
	role: z.literal("build"),
	verified: z.literal(true),
});
/** Only an existing namespace binding can reach this transport. */
export const RepositoryCandidateRoomRequestSchema = z.strictObject({
	operation: z.enum(["initialize", "read", "submit", "seal"]),
	descriptor: RepositoryCandidateDescriptorSchema,
	actor: RepositoryCandidateActorSchema,
	files: z.record(z.string(), z.string()).optional(),
	submission: RepositoryCandidateSubmissionSchema.optional(),
	expectedPosition: RepositoryCandidatePositionSchema.optional(),
	expectedContentDigest: DigestSchema.optional(),
});
export const RepositoryCandidateAccessInputSchema = z.strictObject({
	descriptor: RepositoryCandidateDescriptorSchema,
	userIds: z.array(z.string().min(1)).max(32),
});

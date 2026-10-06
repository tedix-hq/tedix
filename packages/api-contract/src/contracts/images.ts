import "@orpc/openapi/extensions/route";
/**
 * Images Contract for oRPC
 * Upload and manage images for organizations, apps, and tedis via Cloudflare
 * Images Direct Creator Upload. The browser uploads straight to a one-time
 * upload URL (avoiding Worker body limits); the server persists the public
 * delivery URL and serves on-the-fly variants from the stored original.
 */

import { oc } from "@orpc/contract";
import * as z from "zod";

// =============================================================================
// SCHEMAS
// =============================================================================

const ALLOWED_CONTENT_TYPES = [
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/svg+xml",
	"image/gif",
] as const;

const ENTITY_TYPES = ["organization", "app", "tedi"] as const;

const EntityRefSchema = z.object({
	entityType: z.enum(ENTITY_TYPES),
	entityId: z.uuid({ message: "Entity ID must be a valid UUID" }),
});

/**
 * Server-side upload (base64) — programmatic/MCP path. Browsers use the
 * Direct Creator Upload flow (requestUpload + confirmUpload) instead.
 */
export const ImageUploadInputSchema = z.object({
	entityType: z.enum(ENTITY_TYPES),
	entityId: z.uuid({ message: "Entity ID must be a valid UUID" }),
	/** Base64-encoded image data */
	fileData: z.string().min(1, "File data is required"),
	contentType: z.enum(ALLOWED_CONTENT_TYPES),
	filename: z.string().min(1).max(255),
});

export const ImageUploadOutputSchema = z.object({
	url: z.string().url(),
	key: z.string(),
});

/** Step 1: mint a Direct Creator Upload URL for the entity. */
export const ImageRequestUploadInputSchema = EntityRefSchema;

export const ImageRequestUploadOutputSchema = z.object({
	/** Cloudflare image id; equals the id the uploaded image will have. */
	imageId: z.string().min(1),
	/** One-time URL the browser POSTs the file to (multipart/form-data, field `file`). */
	uploadURL: z.url(),
});

/** Step 2: confirm the upload landed and bind it to the entity. */
export const ImageConfirmUploadInputSchema = EntityRefSchema.extend({
	imageId: z.string().min(1, "imageId is required"),
});

export const ImageConfirmUploadOutputSchema = z.object({
	url: z.url(),
	imageId: z.string().min(1),
});

export const ImageDeleteInputSchema = EntityRefSchema;

export const ImageDeleteOutputSchema = z.object({
	success: z.boolean(),
});

/**
 * Platform-admin one-off: migrate entity images stored on legacy r2.dev URLs
 * into Cloudflare Images (URL-import) and rewrite the columns. Idempotent —
 * rows already on imagedelivery.net are skipped. Defaults to a dry run.
 */
export const ImageBackfillInputSchema = z.object({
	dryRun: z.boolean().default(true),
	entityTypes: z.array(z.enum(ENTITY_TYPES)).optional(),
	/** Max rows processed per entity type. */
	limit: z.number().int().positive().max(5000).default(1000),
});

const BackfillCountsSchema = z.object({
	scanned: z.number().int(),
	migrated: z.number().int(),
	skipped: z.number().int(),
	failed: z.number().int(),
});

export const ImageBackfillOutputSchema = z.object({
	dryRun: z.boolean(),
	results: z.object({
		organization: BackfillCountsSchema,
		app: BackfillCountsSchema,
		tedi: BackfillCountsSchema,
	}),
	migrated: z.array(
		z.object({
			entityType: z.enum(ENTITY_TYPES),
			entityId: z.string(),
			oldUrl: z.string(),
			newUrl: z.string(),
		}),
	),
	errors: z.array(
		z.object({
			entityType: z.enum(ENTITY_TYPES),
			entityId: z.string(),
			error: z.string(),
		}),
	),
});

// =============================================================================
// CONTRACT
// =============================================================================

export const imagesContract = oc.route({ prefix: "/images" }).router({
	upload: oc
		.route({
			method: "POST",
			path: "/upload",
			summary: "Upload an image for an entity (org, app, or tedi)",
		})
		.input(ImageUploadInputSchema)
		.output(ImageUploadOutputSchema),

	requestUpload: oc
		.route({
			method: "POST",
			path: "/request-upload",
			summary: "Mint a Direct Creator Upload URL for an entity image",
		})
		.input(ImageRequestUploadInputSchema)
		.output(ImageRequestUploadOutputSchema),

	confirmUpload: oc
		.route({
			method: "POST",
			path: "/confirm-upload",
			summary: "Confirm a Direct Creator Upload and bind it to the entity",
		})
		.input(ImageConfirmUploadInputSchema)
		.output(ImageConfirmUploadOutputSchema),

	delete: oc
		.route({
			method: "DELETE",
			path: "/delete",
			summary: "Delete an image for an entity",
		})
		.input(ImageDeleteInputSchema)
		.output(ImageDeleteOutputSchema),

	backfill: oc
		.route({
			method: "POST",
			path: "/backfill",
			summary:
				"Platform-admin: migrate r2.dev entity images to Cloudflare Images",
		})
		.input(ImageBackfillInputSchema)
		.output(ImageBackfillOutputSchema),
});

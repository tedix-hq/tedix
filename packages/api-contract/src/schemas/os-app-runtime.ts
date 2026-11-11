import * as z from "zod";
import { JsonValueSchema } from "./common";
import { ToolJsonSchemaSchema } from "./tools";
import { nextSkillScheduleFireAt } from "../utils/skill-schedule";

/**
 * A workspace app that runs its own code. The manifest entry
 * `tedix:runtime/v1` says "this gadget is a program": a `server.js` that runs
 * as an isolated server-side instance with its own storage, and a `client.js`
 * that renders inside the OS sandbox. The files are stored per gadget revision
 * in `os_gadget_code`, never in the manifest. Every tenant choice (which sheet,
 * which columns, who reviews) is data in the manifest's `config` or in
 * `resourceGrants`; the code is the same for every tenant.
 */
export const APP_RUNTIME_ENTRY = "tedix:runtime/v1";

/** Self-reported attribution, never a verified member identity. */
export const AppRuntimeGuestNameSchema = z
	.string()
	.trim()
	.min(1)
	.max(80)
	.refine(
		(name) => !/[\p{Cc}\p{Cf}]/u.test(name),
		"Use a name without control characters",
	);

export const APP_RUNTIME_SERVER_MODULE = "server.js";
export const APP_RUNTIME_CLIENT_MODULE = "client.js";
/**
 * Upper bound for all files of one revision together, as UTF-8 bytes of the
 * JSON text that stores them. The files are kept as one database value, and
 * the database holds at most 2,000,000 bytes per value; a draft keeps the
 * same files inside a slightly larger value, so this leaves it room. There is
 * no separate limit on the number of files or on one file.
 */
export const APP_RUNTIME_MAX_FILES_BYTES = 1_800_000;

/** The size of a set of files as it is stored: UTF-8 bytes of its JSON text. */
export function appRuntimeFilesBytes(files: Record<string, string>): number {
	return new TextEncoder().encode(JSON.stringify(files)).length;
}

const appRuntimeFilePath = z
	.string()
	.regex(
		/^(README\.md|[a-z0-9][a-z0-9._-]{0,78}\.(js|json|txt))$/,
		"file names are README.md or lowercase, one segment, ending in .js, .json or .txt",
	);

/** The source files of one app revision, keyed by file name. */
export const AppRuntimeFilesSchema = z
	.record(appRuntimeFilePath, z.string())
	.refine((files) => APP_RUNTIME_SERVER_MODULE in files, {
		message: `${APP_RUNTIME_SERVER_MODULE} is required`,
	})
	.refine((files) => APP_RUNTIME_CLIENT_MODULE in files, {
		message: `${APP_RUNTIME_CLIENT_MODULE} is required`,
	})
	.refine(
		(files) => appRuntimeFilesBytes(files) <= APP_RUNTIME_MAX_FILES_BYTES,
		{
			message: `all files together must stay under ${APP_RUNTIME_MAX_FILES_BYTES} bytes`,
		},
	);
export type AppRuntimeFiles = z.infer<typeof AppRuntimeFilesSchema>;

export const AppRuntimeMethodSchema = z
	.string()
	.regex(/^[a-zA-Z][a-zA-Z0-9]{0,79}$/)
	.refine(
		(name) =>
			![
				"constructor",
				"alarm",
				"webSocketMessage",
				"webSocketClose",
				"webSocketError",
			].includes(name),
		"App lifecycle methods are private",
	);
export const AppRuntimeArgumentsSchema = z
	.array(JsonValueSchema)
	.max(50)
	.refine(
		(args) => new TextEncoder().encode(JSON.stringify(args)).length <= 65536,
		"App arguments exceed 64 KiB",
	);
/** Public app methods take one named-parameter object, passed as args[0]. */
export const AppRuntimePublicOperationSchema = z.strictObject({
	name: AppRuntimeMethodSchema,
	description: z.string().trim().min(1).max(1000),
	input: ToolJsonSchemaSchema.extend({ type: z.literal("object") }).superRefine(
		(schema, ctx) => {
			if (JSON.stringify(schema).length > 16000) {
				ctx.addIssue({
					code: "custom",
					message: "Operation input schema exceeds 16,000 characters",
				});
				return;
			}
			try {
				z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
			} catch {
				ctx.addIssue({
					code: "custom",
					message: "Operation input must be a supported JSON Schema",
				});
			}
		},
	),
	effect: z
		.enum(["read", "write", "destructive"])
		.describe(
			"Author-declared effect for planning; never grants authority or proves behavior",
		),
	outputSlot: z
		.string()
		.min(1)
		.max(160)
		.optional()
		.describe(
			"Output resource slot read or changed by this operation; must have an Output grant",
		),
});

export const AppRuntimePublicOperationsSchema = z
	.array(AppRuntimePublicOperationSchema)
	.max(50)
	.refine(
		(operations) =>
			new Set(operations.map((operation) => operation.name)).size ===
			operations.length,
		"Operation names must be unique",
	);

/** One app method a trigger calls, with optional leading arguments. */
const appRuntimeTriggerBase = {
	id: z
		.string()
		.regex(/^[a-z][a-z0-9-]{0,39}$/)
		.describe("Stable trigger name; part of the webhook address"),
	method: AppRuntimeMethodSchema,
	args: AppRuntimeArgumentsSchema.optional().describe(
		"Arguments passed before the trigger event; omitted means only the event",
	),
};

/**
 * Something that runs an app method without anyone clicking. The method is
 * called with `args` followed by one event object
 * (`{trigger, kind, firedAt, ...}`), under a machine session that carries the
 * app's grants and the live access of the person who saved the revision.
 */
export const AppRuntimeTriggerSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("schedule"),
		cron: z
			.string()
			.min(9)
			.max(120)
			.refine((cron) => {
				try {
					nextSkillScheduleFireAt(cron, new Date(0).toISOString());
					return true;
				} catch {
					return false;
				}
			}, "cron must be a valid five-field UTC cron expression")
			.describe("Five-field UTC cron; checked every two minutes"),
		...appRuntimeTriggerBase,
	}),
	z.strictObject({
		kind: z.literal("webhook"),
		...appRuntimeTriggerBase,
	}),
	z.strictObject({
		kind: z.literal("interaction"),
		methods: z
			.array(AppRuntimeMethodSchema)
			.min(1)
			.max(20)
			.describe(
				"Successful live app methods that immediately start this background trigger; previews and triggers do not emit interactions",
			),
		...appRuntimeTriggerBase,
	}),
	z.strictObject({
		kind: z.literal("skill"),
		slot: z
			.string()
			.min(1)
			.max(160)
			.describe(
				"Workspace resource slot bound to the skill whose finished runs fire this trigger",
			),
		...appRuntimeTriggerBase,
	}),
]);
export type AppRuntimeTrigger = z.infer<typeof AppRuntimeTriggerSchema>;

/** Non-secret settings of a runtime app; the code reads them as `env.CONFIG`. */
export const AppRuntimeConfigSchema = z.strictObject({
	version: z.literal(1),
	recordsGuestInput: z
		.boolean()
		.optional()
		.describe(
			"Ask guests for a name before opening an app that records their input",
		),
	compatibilityDate: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.optional()
		.describe(
			"Workers compatibility date the server code is loaded with; omitted means the host's default",
		),
	settings: z
		.record(z.string().max(80), JsonValueSchema)
		.optional()
		.describe(
			"Tenant data the app reads at run time (sheet id, column names, reviewer label); never code and never secrets",
		),
	triggers: z
		.array(AppRuntimeTriggerSchema)
		.max(10)
		.refine(
			(triggers) =>
				new Set(triggers.map((trigger) => trigger.id)).size === triggers.length,
			"trigger ids must be unique",
		)
		.optional()
		.describe(
			"Interactions, schedules, webhooks and skill results that run an app method",
		),
});
export type AppRuntimeConfig = z.infer<typeof AppRuntimeConfigSchema>;

/**
 * Who is calling an app. `owner` and `build` may change the app and write what
 * it is granted; `use` may run it and read; `viewer` only looks. The
 * collaborator graph resolves the role; the runtime only consumes it.
 */
export const AppRuntimeRoleSchema = z.enum(["owner", "build", "use", "viewer"]);
export type AppRuntimeRole = z.infer<typeof AppRuntimeRoleSchema>;

/**
 * Every operation an app may ask the host for. Anything else does not exist.
 * `outputs.patch` edits a granted Output in place (document blocks, slides or
 * a sheet range) against an expected revision, so an app that does not render
 * some part of the Output can never delete it; `outputs.write` replaces the
 * whole body and is for apps that own the Output's entire content.
 */
export const APP_RUNTIME_OPERATIONS = [
	"app.call",
	"outputs.read",
	"outputs.patch",
	"outputs.write",
	"connections.call",
	"skills.read",
	"skills.run",
	"work.read",
] as const;
export const AppRuntimeOperationSchema = z.enum(APP_RUNTIME_OPERATIONS);
export type AppRuntimeOperation = z.infer<typeof AppRuntimeOperationSchema>;

/** Read evidence only from the skill bound to the granted workspace slot. */
export const AppRuntimeSkillReadSchema = z.discriminatedUnion("view", [
	z.strictObject({ view: z.literal("run"), runId: z.string().min(1).max(200) }),
	z.strictObject({
		view: z.literal("artifacts"),
		runId: z.string().min(1).max(200),
		limit: z.number().int().min(1).max(200).default(200),
		offset: z.number().int().min(0).max(10000).default(0),
	}),
	z.strictObject({
		view: z.literal("artifact"),
		runId: z.string().min(1).max(200),
		path: z
			.string()
			.max(512)
			.regex(/^outputs\/[^/]+\.json$/),
	}),
	z.strictObject({
		view: z.literal("timeline"),
		runId: z.string().min(1).max(200),
	}),
]);

/** Page through the Work board of the project bound to the granted slot. */
export const AppRuntimeWorkReadSchema = z.strictObject({
	limit: z.number().int().min(1).max(50).default(50),
	offset: z.number().int().min(0).max(10000).default(0),
	/** Optional guard: when given it must be the bound project. */
	projectId: z.string().min(1).max(200).optional(),
});

/** Hex SHA-256 of an app revision's stored files; equal files share it. */
export const AppRuntimeFilesSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const AppRuntimeCodeSchema = z.object({
	revisionId: z.string().uuid(),
	revision: z.number().int().positive(),
	filesSha256: AppRuntimeFilesSha256Schema.describe(
		"Names the files' content. Files with the same hash are identical, so a reader may keep them and skip the download next time.",
	),
	files: AppRuntimeFilesSchema.optional().describe(
		"Omitted only when the request listed this hash in knownFilesSha256",
	),
	codeLength: z.number().int().nonnegative(),
	createdAt: z.string(),
});
export type AppRuntimeCode = z.infer<typeof AppRuntimeCodeSchema>;

export const AppRuntimeScopeSchema = z.object({
	workspaceId: z.uuid(),
	gadgetId: z.uuid(),
});

export const AppDraftRoomScopeSchema = AppRuntimeScopeSchema.extend({
	proposalId: z.uuid(),
	expectedRevisionId: z.uuid(),
	expectedSequence: z.number().int().nonnegative(),
}).strict();

export const AppDraftRoomSubmissionSchema = z.strictObject({
	generation: z.number().int().nonnegative(),
	revision: z.number().int().nonnegative(),
	clientId: z.string().regex(/^[0-9A-Za-z_-]{1,64}$/),
	seq: z.number().int().positive(),
	change: JsonValueSchema.describe(
		"CodeChange compact JSON: [path, {edit: ChangeSet JSON} | {set: text} | {remove: true}] entries; validated by the existing OT authority.",
	),
});

export const AppDraftRoomSnapshotSchema = z.strictObject({
	position: z.strictObject({
		generation: z.number().int().nonnegative(),
		revision: z.number().int().nonnegative(),
	}),
	canonical: z.strictObject({
		revision: z.number().int().nonnegative(),
		revisionId: z.string().nullable(),
	}),
	files: z.record(z.string(), z.string()),
});

export const AppDraftRoomSubmitResultSchema = z.discriminatedUnion("ok", [
	z.strictObject({
		ok: z.literal(true),
		duplicate: z.boolean(),
		generation: z.number().int().nonnegative(),
		revision: z.number().int().nonnegative(),
	}),
	z.strictObject({
		ok: z.literal(false),
		code: z.enum(["malformed", "sequence", "stream-gone", "capacity", "busy"]),
		message: z.string(),
	}),
]);
export const AppRuntimeSessionResultSchema = z.object({
	session: z.string(),
	expiresAt: z.number().int(),
	role: AppRuntimeRoleSchema,
	revisionId: z.uuid(),
});

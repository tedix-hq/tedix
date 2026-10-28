import * as z from "zod";
import { JsonValueSchema } from "./common";
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
/** Upper bound for all files of one revision together, in UTF-16 code units. */
export const APP_RUNTIME_MAX_CODE_LENGTH = 512_000;
export const APP_RUNTIME_MAX_FILES = 24;

const appRuntimeFilePath = z
	.string()
	.regex(
		/^(README\.md|[a-z0-9][a-z0-9._-]{0,78}\.(js|json|txt))$/,
		"file names are README.md or lowercase, one segment, ending in .js, .json or .txt",
	);

/** The source files of one app revision, keyed by file name. */
export const AppRuntimeFilesSchema = z
	.record(appRuntimeFilePath, z.string().max(APP_RUNTIME_MAX_CODE_LENGTH))
	.refine((files) => APP_RUNTIME_SERVER_MODULE in files, {
		message: `${APP_RUNTIME_SERVER_MODULE} is required`,
	})
	.refine((files) => APP_RUNTIME_CLIENT_MODULE in files, {
		message: `${APP_RUNTIME_CLIENT_MODULE} is required`,
	})
	.refine((files) => Object.keys(files).length <= APP_RUNTIME_MAX_FILES, {
		message: `at most ${APP_RUNTIME_MAX_FILES} files`,
	})
	.refine(
		(files) =>
			Object.values(files).reduce((sum, text) => sum + text.length, 0) <=
			APP_RUNTIME_MAX_CODE_LENGTH,
		{
			message: `all files together must stay under ${APP_RUNTIME_MAX_CODE_LENGTH} characters`,
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
		.describe("Schedules, webhooks and skill results that run an app method"),
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

export const AppRuntimeCodeSchema = z.object({
	revisionId: z.string().uuid(),
	revision: z.number().int().positive(),
	files: AppRuntimeFilesSchema,
	codeLength: z.number().int().nonnegative(),
	createdAt: z.string(),
});
export type AppRuntimeCode = z.infer<typeof AppRuntimeCodeSchema>;

export const AppRuntimeScopeSchema = z.object({
	workspaceId: z.uuid(),
	gadgetId: z.uuid(),
});
export const AppRuntimeSessionResultSchema = z.object({
	session: z.string(),
	expiresAt: z.number().int(),
	role: AppRuntimeRoleSchema,
	revisionId: z.uuid(),
});

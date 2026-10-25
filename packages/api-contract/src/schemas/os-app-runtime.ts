import * as z from "zod";
import { JsonValueSchema } from "./common";

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

export const APP_RUNTIME_SERVER_MODULE = "server.js";
export const APP_RUNTIME_CLIENT_MODULE = "client.js";
/** Upper bound for all files of one revision together, in UTF-16 code units. */
export const APP_RUNTIME_MAX_CODE_LENGTH = 512_000;
export const APP_RUNTIME_MAX_FILES = 24;

const appRuntimeFilePath = z
	.string()
	.regex(
		/^[a-z0-9][a-z0-9._-]{0,78}\.(js|json|txt)$/,
		"file names are lowercase, one segment, ending in .js, .json or .txt",
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
});
export type AppRuntimeConfig = z.infer<typeof AppRuntimeConfigSchema>;

/**
 * Who is calling an app. `owner` and `build` may change the app and write what
 * it is granted; `use` may run it and read; `viewer` only looks. The
 * collaborator graph resolves the role; the runtime only consumes it.
 */
export const AppRuntimeRoleSchema = z.enum(["owner", "build", "use", "viewer"]);
export type AppRuntimeRole = z.infer<typeof AppRuntimeRoleSchema>;

/** Every operation an app may ask the host for. Anything else does not exist. */
export const APP_RUNTIME_OPERATIONS = [
	"app.call",
	"outputs.read",
	"outputs.write",
	"connections.call",
	"skills.run",
] as const;
export const AppRuntimeOperationSchema = z.enum(APP_RUNTIME_OPERATIONS);
export type AppRuntimeOperation = z.infer<typeof AppRuntimeOperationSchema>;

export const AppRuntimeCodeSchema = z.object({
	revisionId: z.string().uuid(),
	revision: z.number().int().positive(),
	files: AppRuntimeFilesSchema,
	codeLength: z.number().int().nonnegative(),
	createdAt: z.string(),
});
export type AppRuntimeCode = z.infer<typeof AppRuntimeCodeSchema>;

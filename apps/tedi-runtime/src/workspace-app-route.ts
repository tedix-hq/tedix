import { AppRuntimeFilesSchema } from "@tedix/api-contract/schemas/os-app-runtime";
import { loadAppRuntimeWorker } from "@tedix/api-contract/utils/app-runtime";
import { withDynamicWorkerLoaderDiagnostics } from "@tedix/tedi-codemode-core/model-authored-code-loader";
import { z } from "zod";
import {
	JsonValueSchema,
	type JsonValue,
} from "@tedix/api-contract/schemas/common";
import { durableObjectStubByName } from "@tedix/worker-kit/durable-objects";
import { isServiceBinding } from "@tedix/worker-kit/request-auth";
import { verifyWorkspaceAppSession } from "@tedix/auth/workspace-app-session";
import type { WorkspaceAppHostDO } from "./workspace-app-host-do";

export const WORKSPACE_APP_CALL_PATH = "/__internal/workspace-app/call";
export const WORKSPACE_APP_REVOKE_PATH = "/__internal/workspace-app/revoke";

type WorkspaceAppRouteEnv = {
	SECRETS_MASTER_KEY: string;
	WORKSPACE_APP_HOST?: DurableObjectNamespace<WorkspaceAppHostDO>;
};

const RevokeSchema = z
	.object({
		organizationId: z.string().min(1).max(200),
		workspaceId: z.uuid(),
		principalIds: z.array(z.string().min(1).max(200)).max(500),
		at: z.number().int().positive(),
	})
	.strict();

/** Cut the named principals' live app sessions and restart the workspace's apps. */
export async function handleWorkspaceAppRevoke(
	request: Request,
	env: WorkspaceAppRouteEnv,
) {
	if (!isServiceBinding(request.headers))
		return new Response("Forbidden", { status: 403 });
	if (request.method !== "POST")
		return new Response("Method not allowed", { status: 405 });
	if (!env.WORKSPACE_APP_HOST)
		return new Response("App runtime unavailable", { status: 503 });
	const parsed = RevokeSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success)
		return new Response("Invalid revocation", { status: 400 });
	const host = durableObjectStubByName(
		env.WORKSPACE_APP_HOST,
		env,
		`${parsed.data.organizationId}:${parsed.data.workspaceId}`,
	);
	return Response.json(await host.revokeSessions(parsed.data));
}

export async function handleWorkspaceAppCall(
	request: Request,
	env: WorkspaceAppRouteEnv,
) {
	if (!isServiceBinding(request.headers))
		return new Response("Forbidden", { status: 403 });
	if (request.method !== "POST")
		return new Response("Method not allowed", { status: 405 });
	if (!env.WORKSPACE_APP_HOST)
		return new Response("App runtime unavailable", { status: 503 });
	let input: Parameters<WorkspaceAppHostDO["call"]>[0];
	let session;
	try {
		input = await request.json();
		session = await verifyWorkspaceAppSession(
			env.SECRETS_MASTER_KEY,
			input.session,
		);
	} catch {
		return new Response("Invalid app session", { status: 403 });
	}
	const host = durableObjectStubByName(
		env.WORKSPACE_APP_HOST,
		env,
		`${session.organizationId}:${session.workspaceId}`,
	);
	const started = Date.now();
	const { value, capabilityMs } = await host.callTimed(input);
	// The API forwards these so a slow app call names its slow hop.
	return Response.json(value, {
		headers: {
			"Server-Timing": `rt-host;dur=${Date.now() - started}, rt-capability;dur=${capabilityMs}`,
		},
	});
}

export const WORKSPACE_APP_CLOSE_DRAFT_PATH =
	"/__internal/workspace-app/close-draft";
export async function handleWorkspaceAppCloseDraft(
	request: Request,
	env: WorkspaceAppRouteEnv,
) {
	if (!isServiceBinding(request.headers))
		return new Response("Forbidden", { status: 403 });
	if (request.method !== "POST")
		return new Response("Method not allowed", { status: 405 });
	if (!env.WORKSPACE_APP_HOST)
		return new Response("App runtime unavailable", { status: 503 });
	const parsed = z
		.object({
			organizationId: z.string().min(1).max(200),
			workspaceId: z.uuid(),
			gadgetId: z.uuid(),
			proposalId: z.uuid(),
			baseRevisionId: z.uuid(),
			merged: z.boolean(),
		})
		.strict()
		.safeParse(await request.json().catch(() => null));
	if (!parsed.success)
		return new Response("Invalid draft closure", { status: 400 });
	const host = durableObjectStubByName(
		env.WORKSPACE_APP_HOST,
		env,
		`${parsed.data.organizationId}:${parsed.data.workspaceId}`,
	);
	return Response.json(await host.closeDraft(parsed.data));
}

export const WORKSPACE_APP_VALIDATE_PATH = "/__internal/workspace-app/validate";
/** Fresh, capability-free isolate: no app storage, API binding or outbound network. */
export async function handleWorkspaceAppValidate(
	request: Request,
	env: { LOADER: WorkerLoader },
) {
	if (!isServiceBinding(request.headers))
		return new Response("Forbidden", { status: 403 });
	if (request.method !== "POST")
		return new Response("Method not allowed", { status: 405 });
	const parsed = z
		.object({
			files: AppRuntimeFilesSchema,
			compatibilityDate: z
				.string()
				.regex(/^\d{4}-\d{2}-\d{2}$/)
				.optional(),
		})
		.strict()
		.safeParse(await request.json().catch(() => null));
	if (!parsed.success)
		return new Response("Invalid app source", { status: 400 });
	try {
		const worker = loadAppRuntimeWorker(
			withDynamicWorkerLoaderDiagnostics(env.LOADER, {
				surface: "workspace_app_validation",
				reason: "workspace_app_validation",
			}),
			`validate:${crypto.randomUUID()}`,
			parsed.data.files,
			{ compatibilityDate: parsed.data.compatibilityDate, validation: true },
		);
		return await worker.getEntrypoint().fetch(new Request("https://validate/"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return new Response(`server.js:1:1: App dry-load failed: ${message}`, {
			status: 400,
		});
	}
}

export const WORKSPACE_APP_IMPORT_PLAN_PATH =
	"/__internal/workspace-app/import-plan";
export const WORKSPACE_APP_IMPORT_PATH = "/__internal/workspace-app/import";

const RecoveredArchiveSchema = z
	.object({
		prefix: z
			.string()
			.max(300)
			.regex(/^account-recovery\/[A-Za-z0-9._/-]+\/$/),
		manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
	})
	.strict();
type RecoveredArchiveEnv = WorkspaceAppRouteEnv & { TEDI_STORAGE?: R2Bucket };
type RecoveredApp = {
	organizationId: string;
	workspaceId: string;
	gadgetId: string;
	entries: { key: string; value: JsonValue }[];
};

async function sha256Hex(bytes: ArrayBuffer) {
	return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Read the app-host export from the runtime's own bucket. The manifest must
 * hash to the expected value and every file must match its manifest hash.
 */
async function readRecoveredApps(
	bucket: R2Bucket,
	archive: z.infer<typeof RecoveredArchiveSchema>,
): Promise<RecoveredApp[]> {
	const read = async (path: string) => {
		const object = await bucket.get(`${archive.prefix}${path}`);
		if (!object) throw new Error(`Recovered archive file missing: ${path}`);
		const bytes = await object.arrayBuffer();
		return { bytes, sha256: await sha256Hex(bytes) };
	};
	const manifestFile = await read("manifest.json");
	if (manifestFile.sha256 !== archive.manifestSha256)
		throw new Error("Recovered archive manifest hash mismatch");
	const manifest = z
		.array(z.object({ key: z.string(), sha256: z.string() }))
		.parse(JSON.parse(new TextDecoder().decode(manifestFile.bytes)));
	const hashes = new Map(
		manifest.map((entry) => [
			entry.key.slice(entry.key.indexOf("/app-host-export/") + 17),
			entry.sha256,
		]),
	);
	const readLines = async (path: string) => {
		const expected = hashes.get(path);
		if (!expected)
			throw new Error(`Recovered archive file not in manifest: ${path}`);
		const file = await read(path);
		if (file.sha256 !== expected)
			throw new Error(`Recovered archive file hash mismatch: ${path}`);
		return new TextDecoder()
			.decode(file.bytes)
			.split("\n")
			.filter((line) => line.trim())
			.map((line) =>
				z
					.object({ key: z.string().min(1), value: JsonValueSchema })
					.parse(JSON.parse(line)),
			);
	};
	const apps: RecoveredApp[] = [];
	for (const path of hashes.keys()) {
		const match =
			/^([0-9a-f]{64})\/facets\/app%3A([0-9a-f-]{36})\/kv\.0000\.jsonl$/.exec(
				path,
			);
		if (!match) continue;
		const scope = (await readLines(`${match[1]}/kv.0000.jsonl`)).find(
			(entry) => entry.key === "scope",
		)?.value;
		if (typeof scope !== "string" || !scope.includes(":"))
			throw new Error(`Recovered archive host has no scope: ${match[1]}`);
		const [organizationId, workspaceId] = scope.split(":") as [string, string];
		apps.push({
			organizationId,
			workspaceId,
			gadgetId: match[2]!,
			entries: await readLines(path),
		});
	}
	return apps;
}

/** List the apps in a recovered archive: scope and key count, never values. */
export async function handleWorkspaceAppImportPlan(
	request: Request,
	env: RecoveredArchiveEnv,
) {
	if (!isServiceBinding(request.headers))
		return new Response("Forbidden", { status: 403 });
	if (request.method !== "POST")
		return new Response("Method not allowed", { status: 405 });
	if (!env.TEDI_STORAGE)
		return new Response("Recovery storage unavailable", { status: 503 });
	const parsed = RecoveredArchiveSchema.safeParse(
		await request.json().catch(() => null),
	);
	if (!parsed.success)
		return new Response("Invalid recovered archive", { status: 400 });
	const apps = await readRecoveredApps(env.TEDI_STORAGE, parsed.data);
	return Response.json({
		apps: apps.map(({ entries, ...app }) => ({
			...app,
			entryCount: entries.length,
		})),
	});
}

/** One-time import of one app's recovered storage; writes only absent keys. */
export async function handleWorkspaceAppImport(
	request: Request,
	env: RecoveredArchiveEnv,
) {
	if (!isServiceBinding(request.headers))
		return new Response("Forbidden", { status: 403 });
	if (request.method !== "POST")
		return new Response("Method not allowed", { status: 405 });
	if (!env.WORKSPACE_APP_HOST || !env.TEDI_STORAGE)
		return new Response("App runtime unavailable", { status: 503 });
	const parsed = RecoveredArchiveSchema.extend({
		session: z.string().min(1).max(16000),
		files: AppRuntimeFilesSchema,
		apply: z.boolean(),
	})
		.strict()
		.safeParse(await request.json().catch(() => null));
	if (!parsed.success)
		return new Response("Invalid recovered import", { status: 400 });
	let session;
	try {
		session = await verifyWorkspaceAppSession(
			env.SECRETS_MASTER_KEY,
			parsed.data.session,
		);
	} catch {
		return new Response("Invalid app session", { status: 403 });
	}
	const app = (
		await readRecoveredApps(env.TEDI_STORAGE, {
			prefix: parsed.data.prefix,
			manifestSha256: parsed.data.manifestSha256,
		})
	).find(
		(candidate) =>
			candidate.gadgetId === session.gadgetId &&
			candidate.organizationId === session.organizationId &&
			candidate.workspaceId === session.workspaceId,
	);
	if (!app)
		return new Response("App not in recovered archive", { status: 404 });
	const host = durableObjectStubByName(
		env.WORKSPACE_APP_HOST,
		env,
		`${session.organizationId}:${session.workspaceId}`,
	);
	const result = await host.importRecoveredStorage({
		session: parsed.data.session,
		files: parsed.data.files,
		entries: app.entries,
		apply: parsed.data.apply,
	});
	return Response.json({
		revisionId: result.revisionId,
		results: result.results,
	});
}

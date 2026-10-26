/**
 * Triggers for workspace apps: a schedule, a signed webhook or a finished
 * skill run calls a named method of a runtime app without anyone clicking.
 *
 * Triggers are data in the app's manifest (`config.triggers`). Each event runs
 * through the same host call as a click (`runAppRuntimeCall`), so it lands in
 * the app's Runs with its receipt. The machine session carries the app's
 * grants and acts for the person who saved the current revision: the
 * capability endpoint re-checks that person's live access on every resource
 * call, so a trigger can never do more than its author could, and an author
 * who left the organization leaves the app able to run only its own code.
 *
 * Every event derives its receipt id from what happened (fire time, skill run
 * id, signed webhook delivery), so a repeat is recognised and skipped.
 */
import type { Context } from "hono";
import {
	JsonValueSchema,
	type JsonValue,
} from "@tedix/api-contract/schemas/common";
import {
	AppRuntimeArgumentsSchema,
	AppRuntimeConfigSchema,
	type AppRuntimeTrigger,
} from "@tedix/api-contract/schemas/os-app-runtime";
import { nextSkillScheduleFireAt } from "@tedix/api-contract/utils/skill-schedule";
import { mintWorkspaceAppSession } from "@tedix/auth/workspace-app-session";
import { ROLE_PERMISSION_GRANTS, type Role } from "@tedix/auth/rbac";
import { createDbClient } from "@tedix/db/client";
import { getMemberByUserId } from "@tedix/db/queries/organization-members";
import { getOsGadgetExecution } from "@tedix/db/queries/os-workspaces/executions";
import {
	getOsGadget,
	getOsGadgetRevision,
	listTriggeredRuntimeApps,
} from "@tedix/db/queries/os-workspaces/gadgets";
import { listOsWorkspaceResources } from "@tedix/db/queries/os-workspaces/resources";
import { getOsWorkspace } from "@tedix/db/queries/os-workspaces/workspaces";
import { getLatestReportedSkillRun } from "@tedix/db/queries/skill-runs";
import {
	loadAppRuntimeRevision,
	runAppRuntimeCall,
} from "./os-app-runtime-code";
import { SKIPPED_RUN_RESULT_STATUSES } from "./workspace-schedules";

export const APP_TRIGGER_PRINCIPAL_KIND = "app_trigger";
/** The platform tick that checks schedules and skill results runs every two minutes. */
export const APP_TRIGGER_TICK_MS = 120_000;
/** A signed webhook delivery older or newer than this is refused. */
export const APP_TRIGGER_WEBHOOK_SKEW_SECONDS = 300;
const APP_LIMIT = 200;
const WEBHOOK_BODY_LIMIT = 60_000;

type Db = ReturnType<typeof createDbClient>;

export interface TriggeredApp {
	organizationId: string;
	workspaceId: string;
	gadgetId: string;
	revisionId: string;
	/** When the current revision was saved; events before it never fire. */
	revisionCreatedAt: string;
	createdByKind: string;
	createdById: string;
}

async function hmacHex(key: string, message: string): Promise<string> {
	const imported = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(key),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"HMAC",
		imported,
		new TextEncoder().encode(message),
	);
	return Array.from(new Uint8Array(signature), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

/** A UUID-shaped receipt id derived from the event, so the same event runs once. */
export async function appTriggerExecutionId(parts: string[]): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(parts.join("\n")),
	);
	const hex = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The signing secret of one webhook trigger; renaming the trigger rotates it. */
export function appTriggerWebhookSecret(
	masterKey: string,
	scope: { organizationId: string; gadgetId: string; triggerId: string },
): Promise<string> {
	if (!masterKey) throw new Error("App trigger signing unavailable");
	return hmacHex(
		masterKey,
		`tedix:app-trigger-webhook:v1:${scope.organizationId}:${scope.gadgetId}:${scope.triggerId}`,
	);
}

export function appTriggerWebhookPath(scope: {
	organizationId: string;
	gadgetId: string;
	triggerId: string;
}): string {
	return `/webhooks/app-triggers/${encodeURIComponent(scope.organizationId)}/${scope.gadgetId}/${scope.triggerId}`;
}

/** SQLite `datetime('now')` text is UTC without a zone; read it as UTC. */
function utcMillis(value: string): number {
	return Date.parse(/T/.test(value) ? value : `${value.replace(" ", "T")}Z`);
}

function triggersOf(manifestText: string): AppRuntimeTrigger[] {
	try {
		const manifest = JSON.parse(manifestText) as { config?: unknown };
		const config = AppRuntimeConfigSchema.safeParse(manifest.config);
		return config.success ? (config.data.triggers ?? []) : [];
	} catch {
		return [];
	}
}

/**
 * Run one trigger event. Returns `duplicate` when the event already has a
 * receipt. A failed call is recorded as a failed run and is not retried.
 */
export async function fireAppTrigger(
	env: Pick<
		CloudflareEnv,
		"TEDI_SERVICE" | "ENVIRONMENT" | "SECRETS_MASTER_KEY"
	>,
	db: Db,
	app: TriggeredApp,
	trigger: AppRuntimeTrigger,
	event: Record<string, JsonValue>,
	executionId: string,
): Promise<"ran" | "duplicate"> {
	if (
		await getOsGadgetExecution(db, {
			organizationId: app.organizationId,
			executionId,
		})
	)
		return "duplicate";
	const code = await loadAppRuntimeRevision(db, app, app.revisionId);
	const member =
		app.createdByKind === "user"
			? await getMemberByUserId(db, app.organizationId, app.createdById)
			: undefined;
	const actor = member?.status === "active" ? member : undefined;
	const role = actor ? "build" : "use";
	const session = await mintWorkspaceAppSession(env.SECRETS_MASTER_KEY, {
		organizationId: app.organizationId,
		workspaceId: app.workspaceId,
		gadgetId: app.gadgetId,
		revisionId: app.revisionId,
		revision: code.revision,
		principal: {
			kind: APP_TRIGGER_PRINCIPAL_KIND,
			id: `${app.gadgetId}:${trigger.id}`,
		},
		role,
		grants: actor ? code.grants : [],
		...(actor
			? {
					actorUserId: app.createdById,
					actorPermissions: [
						...(ROLE_PERMISSION_GRANTS[actor.role as Role] ?? []),
					],
				}
			: {}),
		codeDigest: code.digest,
		config: code.config,
		compatibilityDate: code.compatibilityDate,
	});
	await runAppRuntimeCall(env, db, {
		organizationId: app.organizationId,
		workspaceId: app.workspaceId,
		gadgetId: app.gadgetId,
		revisionId: app.revisionId,
		code,
		role,
		session: session.token,
		method: trigger.method,
		args: AppRuntimeArgumentsSchema.parse([...(trigger.args ?? []), event]),
		createdBy: { kind: "service", id: `app-trigger:${trigger.id}` },
		policy: {
			trigger: { id: trigger.id, kind: trigger.kind },
			actorUserId: actor ? app.createdById : null,
		},
		executionId,
	});
	return "ran";
}

export type AppTriggerScanResult = {
	apps: number;
	ran: number;
	duplicate: number;
	failed: number;
};

/**
 * One platform tick: run every schedule trigger with a fire time in the last
 * two minutes and every skill trigger whose skill finished a run since its
 * last receipt. Webhook triggers fire only on delivery.
 */
export async function dispatchDueAppTriggers(
	env: Pick<
		CloudflareEnv,
		"DB" | "TEDI_SERVICE" | "ENVIRONMENT" | "SECRETS_MASTER_KEY"
	>,
	scheduledTime: number,
): Promise<AppTriggerScanResult> {
	const db = createDbClient(env.DB);
	const rows = await listTriggeredRuntimeApps(db, { limit: APP_LIMIT });
	const result: AppTriggerScanResult = {
		apps: rows.length,
		ran: 0,
		duplicate: 0,
		failed: 0,
	};
	const windowStart = new Date(scheduledTime - APP_TRIGGER_TICK_MS);
	const resources = new Map<
		string,
		Awaited<ReturnType<typeof listOsWorkspaceResources>>
	>();
	for (const { gadget, revision } of rows) {
		const app: TriggeredApp = {
			organizationId: gadget.organizationId,
			workspaceId: gadget.workspaceId,
			gadgetId: gadget.id,
			revisionId: revision.id,
			revisionCreatedAt: revision.createdAt,
			createdByKind: revision.createdByKind,
			createdById: revision.createdById,
		};
		const savedAt = utcMillis(app.revisionCreatedAt);
		for (const trigger of triggersOf(revision.manifest)) {
			try {
				let event: Record<string, JsonValue> | null = null;
				let parts: string[] = [];
				if (trigger.kind === "schedule") {
					const firedAt = nextSkillScheduleFireAt(trigger.cron, windowStart);
					const at = Date.parse(firedAt);
					if (at > scheduledTime || at < savedAt) continue;
					event = { trigger: trigger.id, kind: "schedule", firedAt };
					parts = ["schedule", firedAt];
				} else if (trigger.kind === "skill") {
					const key = `${app.organizationId}:${app.workspaceId}`;
					if (!resources.has(key))
						resources.set(
							key,
							await listOsWorkspaceResources(db, {
								organizationId: app.organizationId,
								workspaceId: app.workspaceId,
								status: "active",
								limit: 200,
							}),
						);
					const resource = resources
						.get(key)!
						.find(
							(row) =>
								row.slot === trigger.slot &&
								row.providerId === "tedix" &&
								row.resourceType === "skill",
						);
					if (!resource) continue;
					const run = await getLatestReportedSkillRun(db, {
						organizationId: app.organizationId,
						skillId: resource.providerResourceId,
						runtimeEnvironment: env.ENVIRONMENT,
						skippedResultStatuses: SKIPPED_RUN_RESULT_STATUSES,
					});
					if (!run?.completedAt || utcMillis(run.completedAt) < savedAt)
						continue;
					event = {
						trigger: trigger.id,
						kind: "skill",
						firedAt: run.completedAt,
						run: JsonValueSchema.parse({ ...run }),
					};
					parts = ["skill", run.id];
				}
				if (!event) continue;
				const executionId = await appTriggerExecutionId([
					app.gadgetId,
					trigger.id,
					...parts,
				]);
				const outcome = await fireAppTrigger(
					env,
					db,
					app,
					trigger,
					event,
					executionId,
				);
				result[outcome === "ran" ? "ran" : "duplicate"]++;
			} catch {
				// The receipt, when one was written, already records the failure.
				result.failed++;
			}
		}
	}
	return result;
}

function timingSafeEqual(left: string, right: string): boolean {
	if (left.length !== right.length) return false;
	let diff = 0;
	for (let index = 0; index < left.length; index++)
		diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
	return diff === 0;
}

/**
 * `POST /webhooks/app-triggers/:orgId/:gadgetId/:triggerId`. The sender signs
 * `<timestamp>.<raw body>` with the trigger's secret (HMAC-SHA256, hex) and
 * sends `X-Tedix-Timestamp` (Unix seconds) and `X-Tedix-Signature:
 * sha256=<hex>`. Anything unverifiable answers 401 without saying why.
 */
export async function handleAppTriggerWebhook(
	c: Context<{ Bindings: CloudflareEnv }>,
): Promise<Response> {
	const organizationId = c.req.param("orgId") ?? "";
	const gadgetId = c.req.param("gadgetId") ?? "";
	const triggerId = c.req.param("triggerId") ?? "";
	const denied = () => c.json({ error: "Invalid signature" }, 401);
	const timestamp = c.req.header("x-tedix-timestamp") ?? "";
	const signature = c.req.header("x-tedix-signature") ?? "";
	const seconds = Number(timestamp);
	if (
		!/^\d{1,12}$/.test(timestamp) ||
		!/^sha256=[0-9a-f]{64}$/.test(signature) ||
		Math.abs(Date.now() / 1000 - seconds) > APP_TRIGGER_WEBHOOK_SKEW_SECONDS
	)
		return denied();
	const body = await c.req.text();
	if (body.length > WEBHOOK_BODY_LIMIT)
		return c.json({ error: "Payload too large" }, 413);
	const expected = await appTriggerWebhookSecret(c.env.SECRETS_MASTER_KEY, {
		organizationId,
		gadgetId,
		triggerId,
	}).then((secret) => hmacHex(secret, `${timestamp}.${body}`));
	if (!timingSafeEqual(signature, `sha256=${expected}`)) return denied();
	const db = createDbClient(c.env.DB);
	const gadget = await getOsGadget(db, { organizationId, gadgetId });
	const revision = gadget?.currentRevisionId
		? await getOsGadgetRevision(db, {
				organizationId,
				revisionId: gadget.currentRevisionId,
			})
		: undefined;
	const workspace = gadget
		? await getOsWorkspace(db, {
				organizationId,
				workspaceId: gadget.workspaceId,
			})
		: undefined;
	const trigger = revision
		? triggersOf(revision.manifest).find(
				(candidate) =>
					candidate.kind === "webhook" && candidate.id === triggerId,
			)
		: undefined;
	if (
		!gadget ||
		gadget.status !== "active" ||
		workspace?.status !== "active" ||
		!revision ||
		revision.gadgetId !== gadget.id ||
		!trigger
	)
		return denied();
	let payload: JsonValue = null;
	if (body.length > 0) {
		try {
			payload = JsonValueSchema.parse(JSON.parse(body));
		} catch {
			return c.json({ error: "Body must be JSON" }, 400);
		}
	}
	const executionId = await appTriggerExecutionId([
		gadget.id,
		trigger.id,
		"webhook",
		timestamp,
		signature,
	]);
	try {
		const outcome = await fireAppTrigger(
			c.env,
			db,
			{
				organizationId,
				workspaceId: gadget.workspaceId,
				gadgetId: gadget.id,
				revisionId: revision.id,
				revisionCreatedAt: revision.createdAt,
				createdByKind: revision.createdByKind,
				createdById: revision.createdById,
			},
			trigger,
			{
				trigger: trigger.id,
				kind: "webhook",
				firedAt: new Date(seconds * 1000).toISOString(),
				body: payload,
			},
			executionId,
		);
		return c.json({ runId: executionId, status: outcome });
	} catch {
		return c.json({ runId: executionId, status: "failed" }, 502);
	}
}

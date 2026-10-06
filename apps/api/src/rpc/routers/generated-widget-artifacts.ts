/**
 * Generated Widget Artifacts oRPC Router
 *
 * Durable GenUI control plane for chat-generated widget surfaces:
 * create draft layouts, attach Browser QA evidence, and publish renderable
 * MCP UI resource metadata.
 */

import { implement } from "@orpc/server";
import { generatedWidgetArtifactsContract } from "@tedix/api-contract/contracts/generated-widget-artifacts";
import type { TediArtifact } from "@tedix/api-contract/schemas/cognitive-runtime";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type { GeneratedWidgetArtifact } from "@tedix/api-contract/schemas/generated-widget-artifacts";
import type { DbClient } from "@tedix/db/client";
import { getAppById } from "@tedix/db/queries/app-records";
import {
	createGeneratedWidgetArtifact,
	type GeneratedWidgetArtifactRow,
	getGeneratedWidgetArtifact,
	listGeneratedWidgetArtifacts,
	updateGeneratedWidgetArtifact,
	upsertGeneratedWidgetTediArtifact,
} from "@tedix/db/queries/generated-widget-artifacts";
import {
	getToolByAppAndToolIdForOrganization,
	getToolByIdForOrganization,
} from "@tedix/db/queries/tools";
import { getWidgetTestRunById } from "@tedix/db/queries/widget-test-runs";
import { publishMcpSubscriptionEventSoon } from "../../lib/mcp-subscriptions";
import {
	buildGeneratedWidgetQaSummary,
	formatBrowserQaGateFailure,
	validateGeneratedWidgetBrowserQaRun,
	validateGeneratedWidgetProgressStatus,
} from "../../services/generated-widget-qa-gate";
import { auditActor, emitAuditEvent } from "../audit-helpers";
import { requireOrgId } from "../org-scope";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";

const generatedWidgetArtifactsOs = implement(
	generatedWidgetArtifactsContract,
).$context<BaseContext>();
const authed = generatedWidgetArtifactsOs.use(withAuth);

function nowIso() {
	return new Date().toISOString();
}

async function emitGeneratedWidgetArtifactAudit(
	context: BaseContext,
	params: {
		action: string;
		organizationId: string;
		resourceId: string;
		metadata?: Record<string, unknown>;
	},
) {
	const actor = auditActor(context);
	await emitAuditEvent(context.db, {
		organizationId: params.organizationId,
		actorId: actor.actorId,
		actorType: actor.actorType,
		action: params.action,
		resourceType: "generated_widget_artifact",
		resourceId: params.resourceId,
		metadata: {
			...actor.actorMetadata,
			...params.metadata,
		},
		ipAddress: context.headers.get("CF-Connecting-IP"),
		userAgent: context.headers.get("User-Agent"),
	});
}

function nullableRecord(value: unknown): Record<string, JsonValue> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, JsonValue>;
}

function normalizeArtifact(
	row: GeneratedWidgetArtifactRow,
	tediArtifact?: TediArtifact | null,
): GeneratedWidgetArtifact {
	return {
		id: row.id,
		organizationId: row.organizationId,
		appId: row.appId,
		appSlug: row.appSlug,
		appToolId: row.appToolId ?? null,
		toolId: row.toolId ?? null,
		toolName: row.toolName ?? null,
		kind: row.kind,
		source: row.source,
		status: row.status,
		title: row.title,
		description: row.description ?? null,
		layoutSpec: nullableRecord(row.layoutSpec),
		inputSnapshot: nullableRecord(row.inputSnapshot),
		outputSnapshot: nullableRecord(row.outputSnapshot),
		resourceUri: row.resourceUri ?? null,
		widgetUrl: row.widgetUrl ?? null,
		previewUrl: row.previewUrl ?? null,
		screenshotUrl: row.screenshotUrl ?? null,
		widgetTestRunId: row.widgetTestRunId ?? null,
		workflowId: row.workflowId ?? null,
		progressMessage: row.progressMessage ?? null,
		qaSummary: nullableRecord(row.qaSummary),
		metadata: nullableRecord(row.metadata),
		...(tediArtifact ? { tediArtifact } : {}),
		createdBy: row.createdBy ?? null,
		publishedAt: row.publishedAt ?? null,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

interface GeneratedWidgetArtifactOwnershipRecord {
	id: string;
	appId: string;
	appSlug: string;
	appToolId?: string | null;
	createdAt: string;
	inputSnapshot?: Record<string, unknown> | null;
	kind: string;
	metadata?: Record<string, unknown> | null;
	outputSnapshot?: Record<string, unknown> | null;
	previewUrl?: string | null;
	publishedAt?: string | null;
	resourceUri?: string | null;
	screenshotUrl?: string | null;
	status: string;
	title: string;
	toolId?: string | null;
	toolName?: string | null;
	widgetTestRunId?: string | null;
	widgetUrl?: string | null;
}

const TEDI_OWNERSHIP_TEDI_KEYS = [
	"tediId",
	"tedi_id",
	"activeTediId",
	"active_tedi_id",
	"ownerTediId",
	"owner_tedi_id",
] as const;
const TEDI_OWNERSHIP_CONVERSATION_KEYS = [
	"conversationId",
	"conversation_id",
	"sessionKey",
	"session_key",
] as const;
const TEDI_OWNERSHIP_RUN_KEYS = ["runId", "run_id"] as const;
const TEDI_OWNERSHIP_MESSAGE_KEYS = ["messageId", "message_id"] as const;

function compactMetadataRecord(
	record: Record<string, unknown>,
): Record<string, unknown> | undefined {
	const entries = Object.entries(record).filter(([, value]) => {
		if (value === undefined || value === null) return false;
		if (typeof value === "string" && value.trim() === "") return false;
		return true;
	});
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function stringFromRecords(
	records: Array<Record<string, unknown> | null | undefined>,
	keys: readonly string[],
): string | undefined {
	for (const record of records) {
		if (!record) continue;
		for (const key of keys) {
			const value = record[key];
			if (typeof value === "string" && value.trim()) return value.trim();
		}
	}
	return undefined;
}

function ownershipRecordsFromGeneratedWidget(
	record: GeneratedWidgetArtifactOwnershipRecord,
): Array<Record<string, unknown>> {
	const records: Array<Record<string, unknown>> = [];
	for (const candidate of [
		record.metadata,
		record.inputSnapshot,
		record.outputSnapshot,
	]) {
		if (!candidate || typeof candidate !== "object") continue;
		records.push(candidate);
		for (const key of [
			"artifact",
			"context",
			"runtime",
			"runtimeContext",
			"tediArtifact",
		]) {
			const nested = candidate[key];
			if (nested && typeof nested === "object" && !Array.isArray(nested)) {
				records.push(nested as Record<string, unknown>);
			}
		}
	}
	return records;
}

function generatedWidgetArtifactKind(kind: string): TediArtifact["kind"] {
	return kind === "browser_qa_report" ? "document" : "widget";
}

function generatedWidgetArtifactMimeType(kind: string): string {
	return kind === "browser_qa_report"
		? "application/json"
		: "application/vnd.tedix.widget+json";
}

function validIsoOrNow(value: string | null | undefined): string {
	if (value) {
		const date = new Date(value);
		if (Number.isFinite(date.getTime())) return date.toISOString();
	}
	return nowIso();
}

function generatedWidgetArtifactEventId(artifact: TediArtifact): string {
	return [
		"runtime",
		artifact.tediId,
		"event",
		"generated-widget-artifact",
		"artifact.created",
		artifact.id,
	]
		.filter(Boolean)
		.join(":");
}

export function generatedWidgetTediArtifactFromRecord(
	record: GeneratedWidgetArtifactOwnershipRecord,
): TediArtifact | null {
	const ownershipRecords = ownershipRecordsFromGeneratedWidget(record);
	const tediId = stringFromRecords(ownershipRecords, TEDI_OWNERSHIP_TEDI_KEYS);
	if (!tediId) return null;

	const conversationId = stringFromRecords(
		ownershipRecords,
		TEDI_OWNERSHIP_CONVERSATION_KEYS,
	);
	const runId = stringFromRecords(ownershipRecords, TEDI_OWNERSHIP_RUN_KEYS);
	const messageId = stringFromRecords(
		ownershipRecords,
		TEDI_OWNERSHIP_MESSAGE_KEYS,
	);
	const uri =
		record.resourceUri ??
		record.widgetUrl ??
		record.previewUrl ??
		record.screenshotUrl ??
		undefined;
	const metadata = compactMetadataRecord({
		appId: record.appId,
		appSlug: record.appSlug,
		appToolId: record.appToolId,
		generatedWidgetArtifactId: record.id,
		generatedWidgetKind: record.kind,
		previewUrl: record.previewUrl,
		publishedAt: record.publishedAt,
		resourceUri: record.resourceUri,
		screenshotUrl: record.screenshotUrl,
		source: "generated_widget_artifact",
		status: record.status,
		toolId: record.toolId,
		toolName: record.toolName,
		widgetTestRunId: record.widgetTestRunId,
		widgetUrl: record.widgetUrl,
	});

	return {
		id: record.id,
		tediId,
		...(conversationId ? { conversationId } : {}),
		...(runId ? { runId } : {}),
		...(messageId ? { messageId } : {}),
		kind: generatedWidgetArtifactKind(record.kind),
		name: record.title,
		mimeType: generatedWidgetArtifactMimeType(record.kind),
		...(uri ? { uri } : {}),
		...(metadata ? { metadata } : {}),
		createdAt: validIsoOrNow(record.createdAt),
	};
}

export async function recordGeneratedWidgetTediArtifact(
	db: DbClient,
	organizationId: string,
	record: GeneratedWidgetArtifactOwnershipRecord,
): Promise<TediArtifact | null> {
	const artifact = generatedWidgetTediArtifactFromRecord(record);
	if (!artifact) return null;

	const stored = await upsertGeneratedWidgetTediArtifact(db, {
		organizationId,
		artifact,
		eventId: generatedWidgetArtifactEventId(artifact),
		externalId: record.id,
	});
	return stored
		? {
				...artifact,
				uri: undefined,
				metadata: undefined,
				accessClassification: "runtime_private",
			}
		: null;
}

async function requireArtifact(
	db: DbClient,
	organizationId: string,
	id: string,
) {
	const artifact = await getGeneratedWidgetArtifact(db, { organizationId, id });
	if (!artifact) {
		throw createError(
			ErrorCodes.NOT_FOUND,
			`Generated widget artifact not found: ${id}`,
		);
	}
	return artifact;
}

async function requireAppForOrg(
	db: DbClient,
	organizationId: string,
	appId: string,
) {
	const app = await getAppById(db, appId);
	if (!app || app.organizationId !== organizationId) {
		throw createError(ErrorCodes.NOT_FOUND, "App not found");
	}
	return app;
}

async function resolveToolForArtifact(
	db: DbClient,
	organizationId: string,
	appId: string,
	appToolId: string | undefined,
	toolId: string | undefined,
) {
	if (!appToolId && !toolId) return null;

	const byId = appToolId
		? await getToolByIdForOrganization(db, {
				organizationId,
				toolId: appToolId,
			})
		: undefined;
	const tool =
		byId?.appId === appId
			? byId
			: toolId
				? await getToolByAppAndToolIdForOrganization(db, {
						organizationId,
						appId,
						toolId,
					})
				: undefined;
	if (!tool) {
		throw createError(ErrorCodes.NOT_FOUND, "App tool not found");
	}
	return tool;
}

async function updateArtifact(
	db: DbClient,
	organizationId: string,
	id: string,
	data: Partial<GeneratedWidgetArtifactRow>,
) {
	const artifact = await updateGeneratedWidgetArtifact(db, {
		organizationId,
		id,
		patch: data,
	});
	if (!artifact) {
		throw createError(
			ErrorCodes.NOT_FOUND,
			`Generated widget artifact not found: ${id}`,
		);
	}
	return { artifact: normalizeArtifact(artifact) };
}

export const generatedWidgetArtifactsContractRouter =
	generatedWidgetArtifactsOs.router({
		create: authed.create
			.use(AUTHZ.appsWrite)
			.handler(async ({ input, context }) => {
				const organizationId = requireOrgId(context);
				const app = await requireAppForOrg(
					context.db,
					organizationId,
					input.appId,
				);
				const tool = await resolveToolForArtifact(
					context.db,
					organizationId,
					app.id,
					input.appToolId,
					input.toolId,
				);
				const id = crypto.randomUUID();
				const createdBy =
					context.user?.sub ??
					context.descopeUserId ??
					context.apiKey?.id ??
					context.serviceAccount?.clientId ??
					null;

				await createGeneratedWidgetArtifact(context.db, {
					id,
					organizationId,
					appId: app.id,
					appSlug: app.slug,
					appToolId: tool?.id ?? input.appToolId ?? null,
					toolId: tool?.toolId ?? input.toolId ?? null,
					toolName: input.toolName ?? tool?.toolId ?? input.toolId ?? null,
					kind: input.kind,
					source: input.source,
					status: "draft",
					title: input.title,
					description: input.description ?? null,
					layoutSpec: input.layoutSpec,
					inputSnapshot: input.inputSnapshot,
					outputSnapshot: input.outputSnapshot,
					resourceUri: input.resourceUri ?? null,
					widgetUrl: input.widgetUrl ?? null,
					previewUrl: input.previewUrl ?? null,
					metadata: input.metadata,
					createdBy,
					updatedAt: nowIso(),
				});

				const artifact = await requireArtifact(context.db, organizationId, id);
				const tediArtifact = await recordGeneratedWidgetTediArtifact(
					context.db,
					organizationId,
					artifact,
				);
				await emitGeneratedWidgetArtifactAudit(context, {
					action: "generated_widget_artifact.created",
					organizationId,
					resourceId: id,
					metadata: {
						appId: app.id,
						appSlug: app.slug,
						appToolId: tool?.id ?? input.appToolId ?? null,
						toolId: tool?.toolId ?? input.toolId ?? null,
						kind: input.kind,
						source: input.source,
						status: "draft",
					},
				});
				return { artifact: normalizeArtifact(artifact, tediArtifact) };
			}),

		list: authed.list
			.use(AUTHZ.appsRead)
			.handler(async ({ input, context }) => {
				const organizationId = requireOrgId(context);
				const rows = await listGeneratedWidgetArtifacts(context.db, {
					organizationId,
					...input,
				});

				return { artifacts: rows.map((row) => normalizeArtifact(row)) };
			}),

		get: authed.get.use(AUTHZ.appsRead).handler(async ({ input, context }) => {
			const organizationId = requireOrgId(context);
			const artifact = await requireArtifact(
				context.db,
				organizationId,
				input.id,
			);
			return { artifact: normalizeArtifact(artifact) };
		}),

		recordProgress: authed.recordProgress
			.use(AUTHZ.appsWrite)
			.handler(async ({ input, context }) => {
				const organizationId = requireOrgId(context);
				const blockedProgressStatus = validateGeneratedWidgetProgressStatus(
					input.status,
				);
				if (blockedProgressStatus) {
					throw createError(ErrorCodes.BAD_REQUEST, blockedProgressStatus);
				}
				const previous = await requireArtifact(
					context.db,
					organizationId,
					input.id,
				);
				const result = await updateArtifact(
					context.db,
					organizationId,
					input.id,
					{
						status: input.status,
						workflowId: input.workflowId,
						progressMessage: input.progressMessage,
						qaSummary: input.qaSummary,
						screenshotUrl: input.screenshotUrl,
						previewUrl: input.previewUrl,
						metadata: input.metadata,
					},
				);
				await emitGeneratedWidgetArtifactAudit(context, {
					action: "generated_widget_artifact.progress_recorded",
					organizationId,
					resourceId: input.id,
					metadata: {
						appId: previous.appId,
						appSlug: previous.appSlug,
						appToolId: previous.appToolId,
						toolId: previous.toolId,
						previousStatus: previous.status,
						status: result.artifact.status,
						workflowId: input.workflowId ?? previous.workflowId ?? null,
					},
				});
				const tediArtifact = await recordGeneratedWidgetTediArtifact(
					context.db,
					organizationId,
					result.artifact,
				);
				return {
					artifact: tediArtifact
						? { ...result.artifact, tediArtifact }
						: result.artifact,
				};
			}),

		attachQaRun: authed.attachQaRun
			.use(AUTHZ.appsWrite)
			.handler(async ({ input, context }) => {
				const organizationId = requireOrgId(context);
				const previous = await requireArtifact(
					context.db,
					organizationId,
					input.id,
				);
				const run = await getWidgetTestRunById(
					context.db,
					input.widgetTestRunId,
					organizationId,
				);
				if (!run) {
					throw createError(
						ErrorCodes.NOT_FOUND,
						`Widget test run not found: ${input.widgetTestRunId}`,
					);
				}

				const qaGate = validateGeneratedWidgetBrowserQaRun(previous, run);
				if (run.passed && !qaGate.ok) {
					throw createError(
						ErrorCodes.CONFLICT,
						formatBrowserQaGateFailure(qaGate),
					);
				}
				const result = await updateArtifact(
					context.db,
					organizationId,
					input.id,
					{
						status: qaGate.ok ? "qa_passed" : "qa_failed",
						widgetTestRunId: run.id,
						previewUrl: run.previewUrl ?? undefined,
						screenshotUrl: qaGate.evidence.screenshotUrl ?? undefined,
						progressMessage:
							input.progressMessage ??
							(qaGate.ok ? "Browser QA passed" : "Browser QA failed"),
						qaSummary: buildGeneratedWidgetQaSummary(run, qaGate) as Record<
							string,
							JsonValue
						>,
					},
				);
				await emitGeneratedWidgetArtifactAudit(context, {
					action: "generated_widget_artifact.qa_attached",
					organizationId,
					resourceId: input.id,
					metadata: {
						appId: previous.appId,
						appSlug: previous.appSlug,
						appToolId: previous.appToolId,
						toolId: previous.toolId,
						previousStatus: previous.status,
						status: qaGate.ok ? "qa_passed" : "qa_failed",
						widgetTestRunId: run.id,
						passed: run.passed,
						gatePassed: qaGate.ok,
						gateFailures: qaGate.failures,
						previewUrl: run.previewUrl ?? null,
					},
				});
				const tediArtifact = await recordGeneratedWidgetTediArtifact(
					context.db,
					organizationId,
					result.artifact,
				);
				return {
					artifact: tediArtifact
						? { ...result.artifact, tediArtifact }
						: result.artifact,
				};
			}),

		publish: authed.publish
			.use(AUTHZ.appsWrite)
			.handler(async ({ input, context }) => {
				const organizationId = requireOrgId(context);
				const artifact = await requireArtifact(
					context.db,
					organizationId,
					input.id,
				);
				if (
					artifact.status !== "qa_passed" &&
					artifact.status !== "published"
				) {
					throw createError(
						ErrorCodes.CONFLICT,
						"Generated widget artifact must pass Browser QA before publishing",
					);
				}
				if (!artifact.widgetTestRunId) {
					throw createError(
						ErrorCodes.CONFLICT,
						"Generated widget artifact must attach a Browser QA run before publishing",
					);
				}
				const run = await getWidgetTestRunById(
					context.db,
					artifact.widgetTestRunId,
					organizationId,
				);
				if (!run) {
					throw createError(
						ErrorCodes.CONFLICT,
						`Attached Browser QA run not found: ${artifact.widgetTestRunId}`,
					);
				}
				const qaGate = validateGeneratedWidgetBrowserQaRun(artifact, run);
				if (!qaGate.ok) {
					throw createError(
						ErrorCodes.CONFLICT,
						formatBrowserQaGateFailure(qaGate),
					);
				}
				const resourceUri = input.resourceUri ?? artifact.resourceUri;
				if (!resourceUri) {
					throw createError(
						ErrorCodes.BAD_REQUEST,
						"resourceUri is required to publish a generated widget artifact",
					);
				}
				const result = await updateArtifact(
					context.db,
					organizationId,
					input.id,
					{
						status: "published",
						resourceUri,
						widgetUrl: input.widgetUrl,
						previewUrl: input.previewUrl,
						screenshotUrl: qaGate.evidence.screenshotUrl ?? undefined,
						progressMessage:
							input.progressMessage ?? "Generated widget artifact published",
						qaSummary: buildGeneratedWidgetQaSummary(run, qaGate) as Record<
							string,
							JsonValue
						>,
						metadata: input.metadata ?? artifact.metadata ?? undefined,
						publishedAt: nowIso(),
					},
				);
				await emitGeneratedWidgetArtifactAudit(context, {
					action: "generated_widget_artifact.published",
					organizationId,
					resourceId: input.id,
					metadata: {
						appId: artifact.appId,
						appSlug: artifact.appSlug,
						appToolId: artifact.appToolId,
						toolId: artifact.toolId,
						previousStatus: artifact.status,
						status: "published",
						resourceUri,
						widgetUrl: input.widgetUrl ?? artifact.widgetUrl ?? null,
						previewUrl: input.previewUrl ?? artifact.previewUrl ?? null,
						widgetTestRunId: run.id,
						qaEvidence: qaGate.evidence,
					},
				});
				// A published widget adds/updates a ui:// resource on the app: nudge
				// live MCP subscribers with both the list change and the updated URI.
				publishMcpSubscriptionEventSoon(context.waitUntil, context.env, {
					appId: artifact.appId,
					organizationId,
					method: "notifications/resources/list_changed",
				});
				publishMcpSubscriptionEventSoon(context.waitUntil, context.env, {
					appId: artifact.appId,
					organizationId,
					method: "notifications/resources/updated",
					uri: resourceUri,
				});
				const tediArtifact = await recordGeneratedWidgetTediArtifact(
					context.db,
					organizationId,
					result.artifact,
				);
				return {
					artifact: tediArtifact
						? { ...result.artifact, tediArtifact }
						: result.artifact,
				};
			}),
	});

export type GeneratedWidgetArtifactsContractRouter =
	typeof generatedWidgetArtifactsContractRouter;

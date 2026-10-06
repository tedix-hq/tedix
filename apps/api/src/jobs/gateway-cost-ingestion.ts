/**
 * AI Gateway log → tedi_call_costs ingestion job.
 *
 * Cost ledger source of truth is now the Cloudflare AI Gateway Logs REST API,
 * not runtime-side instrumentation. Every 15 minutes this pages the
 * active account gateway(s) forward from a persisted cursor and writes one
 * `tedi_call_costs` row per gateway log row.
 *
 * Includes the `default` gateway even though it currently carries managed
 * AI Search/catalog embeddings. Those rows are real platform cost and must be
 * visible as unattributed rather than disappearing from the ledger.
 *
 * Cost basis:
 *  - `workers-ai` rows: the gateway's own `cost` field is Cloudflare's
 *    authoritative wholesale charge — used as-is.
 *  - `azure-openai` rows (BYOK): the gateway's `cost` is unreliable (Azure is
 *    the true biller), so cost is recomputed from token counts via the
 *    governed event-time rates joined through immutable execution evidence.
 *  - Failed or unpriced requests remain held usage evidence; a stored zero
 *    under quarantine does not establish that the provider consumed no resources.
 */

import { decodeAiGatewayAttribution } from "@tedix/api-contract/schemas/ai-gateway-attribution";
import type { DbClient } from "@tedix/db/client";
import {
	getGatewayLogIngestionCursor,
	loadKnownGatewayAttributionIds,
	advanceGatewayLogIngestionCursor,
} from "@tedix/db/queries/platform-job-storage";
import {
	getExistingGatewayLogIds,
	insertCallCosts,
} from "@tedix/db/queries/tedi-usage";
import type { NewTediCallCost } from "@tedix/db/schema/tedis";
import { getProviderExecutionsByIds } from "@tedix/db/queries/provider-executions";
import type { ProviderExecutionAttemptRow } from "@tedix/db/schema/provider-executions";
import { priceProviderUsage } from "../services/provider-model-pricing";
import type { FleetAuthorityEnv } from "../lib/fleet-authority";

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

type GatewayId = string;

/** 50 rows/page is the observed max `per_page` for the Logs API. */
const PER_PAGE = 50;
/** Cap per gateway per tick (2000 rows) so one cron invocation stays bounded. */
const MAX_PAGES_PER_RUN = 40;
/** The extra two-minute catch-up path is capped at 500 rows per gateway. */
export const CATCHUP_PAGES_PER_RUN = 10;
/** Bounded first-run backfill window — NOT a full historical backfill. */
const INITIAL_BACKFILL_MS = 24 * 60 * 60 * 1000;

interface GatewayCostIngestionEnv extends FleetAuthorityEnv {
	TEDIX_BILLING_SETTLEMENT_MODE?: string;
	EMAIL?: SendEmail;
	HEALTH_ALERT_EMAIL?: string;
	HEALTH_ALERT_WEBHOOK?: string;
	CF_ACCOUNT_ID: string;
	AI_GATEWAY_LLM_ID: string;
	/**
	 * The AI-Gateway-scoped credential (`CLOUDFLARE_AI_GATEWAY_API_TOKEN` in the
	 * secret provider).
	 *
	 * Cloudflare rejects `CF_ANALYTICS_TOKEN` for the AI Gateway REST API (error
	 * 9106 "Authentication failed"). `CF_AI_GATEWAY_TOKEN` is the correct,
	 * least-privilege credential: it is the same token already used for
	 * `cf-aig-authorization` on the inference path, and it works for both the
	 * logs REST API and gateway
	 * inference. It is already declared in `wrangler.jsonc` `secrets.required`
	 * for every environment.
	 */
	CF_AI_GATEWAY_TOKEN: string;
	STRIPE_SECRET_KEY?: string;
	STRIPE_TEST_SECRET_KEY?: string;
	STRIPE_WEBHOOK_SECRET?: string;
	STRIPE_TEST_WEBHOOK_SECRET?: string;
	STRIPE_BILLING_PORTAL_CONFIGURATION_ID?: string;
	STRIPE_TEST_BILLING_PORTAL_CONFIGURATION_ID?: string;
	TEDIX_STRIPE_MODE?: string;
	ENVIRONMENT?: string;
}

export interface AiGatewayLogRow {
	path?: string;
	id: string;
	created_at: string;
	provider: string;
	model: string;
	success: boolean;
	cached: boolean;
	cost: number | null;
	tokens_in: number | null;
	tokens_out: number | null;
	usage_metadata?: {
		input_tokens?: number;
		output_tokens?: number;
		input_cached_tokens?: number;
		total_tokens?: number;
	} | null;
	metadata?: Record<string, unknown> | null;
}

interface AiGatewayLogsResponse {
	success: boolean;
	errors?: Array<{ code: number; message: string }>;
	result: AiGatewayLogRow[];
	result_info?: { total_count?: number };
}

interface GatewayProviderUsage {
	kind:
		| "voice_stt"
		| "voice_tts"
		| "image_generation"
		| "workstation_compute"
		| "other";
	unit: "seconds" | "characters" | "images" | "compute_seconds" | "units";
	quantity: number;
}

function decodeGatewayProviderUsage(
	value: unknown,
): GatewayProviderUsage | null {
	if (typeof value !== "string" || value.length === 0) return null;
	try {
		const parsed = JSON.parse(value) as {
			k?: unknown;
			u?: unknown;
			q?: unknown;
		};
		const kinds = new Set([
			"voice_stt",
			"voice_tts",
			"image_generation",
			"workstation_compute",
			"other",
		]);
		const units = new Set([
			"seconds",
			"characters",
			"images",
			"compute_seconds",
			"units",
		]);
		if (
			typeof parsed.k !== "string" ||
			!kinds.has(parsed.k) ||
			typeof parsed.u !== "string" ||
			!units.has(parsed.u) ||
			typeof parsed.q !== "number" ||
			!Number.isSafeInteger(parsed.q) ||
			parsed.q <= 0
		) {
			return null;
		}
		return {
			kind: parsed.k as GatewayProviderUsage["kind"],
			unit: parsed.u as GatewayProviderUsage["unit"],
			quantity: parsed.q,
		};
	} catch {
		return null;
	}
}

export interface GatewayIngestionResult {
	gatewayId: GatewayId;
	ingested: number;
	skipped: number;
	/** Another tick advanced this gateway first; this is not a provider failure. */
	contended?: boolean;
	/**
	 * The fetch error that ended this gateway's page loop, if any.
	 *
	 * Without this, a total failure and a genuinely-quiet tick are the same
	 * observable: `ingested=0 skipped=0`, while `tedi_call_costs` stays empty
	 * and cost reads report zero. The scheduled handler logs this via
	 * console.error (log errors in every environment), so a broken pipeline is
	 * visible in `wrangler tail` instead of hiding behind a zero.
	 */
	failure: string | null;
}

function authHeaders(env: GatewayCostIngestionEnv): HeadersInit {
	return { Authorization: `Bearer ${env.CF_AI_GATEWAY_TOKEN}` };
}

async function fetchLogsPage(
	env: GatewayCostIngestionEnv,
	gatewayId: GatewayId,
	page: number,
	sinceIso: string,
): Promise<AiGatewayLogsResponse> {
	const query = new URLSearchParams({
		page: String(page),
		per_page: String(PER_PAGE),
		order_by: "created_at",
		order_by_direction: "asc",
		filters: JSON.stringify([
			{ key: "created_at", operator: "gt", value: [sinceIso] },
		]),
	});
	const res = await fetch(
		`${CF_API_BASE}/accounts/${env.CF_ACCOUNT_ID}/ai-gateway/gateways/${gatewayId}/logs?${query.toString()}`,
		{ headers: authHeaders(env) },
	);
	const body = (await res.json()) as AiGatewayLogsResponse;
	if (!res.ok || !body.success) {
		const detail = body.errors
			?.map((e) => `${e.code}: ${e.message}`)
			.join("; ");
		throw new Error(
			`AI Gateway logs fetch failed for ${gatewayId} page ${page}: ${detail || res.status}`,
		);
	}
	return body;
}

export function mapRowToCallCost(
	row: AiGatewayLogRow,
	gatewayId: GatewayId,
	priced: {
		execution: ProviderExecutionAttemptRow | null;
		costUsd: number | null;
		rateVersionId: string | null;
		reason: string | null;
	} = {
		execution: null,
		costUsd: null,
		rateVersionId: null,
		reason: "missing_execution",
	},
): NewTediCallCost {
	const metadata = row.metadata ?? {};
	const execution = priced.execution;
	const decodedUsage = decodeGatewayProviderUsage(metadata.usage);
	// Non-token voice producers predate token admission. Only native provider/model
	// evidence can select that path; a token caller cannot claim it via metadata.
	const nativeAudioPath =
		row.provider === "azure-openai"
			? /^[a-z0-9-]+\/[^/%]+\/audio\/(speech|transcriptions)(?:\?[^#]*)?$/i.exec(
					row.path ?? "",
				)?.[1]
			: null;
	const nativeVoiceKind =
		nativeAudioPath === "speech" ||
		(row.provider === "workers-ai" && row.model === "@cf/deepgram/aura-1")
			? "voice_tts"
			: nativeAudioPath === "transcriptions" ||
				  (row.provider === "workers-ai" &&
						[
							"@cf/openai/whisper",
							"@cf/deepgram/flux",
							"@cf/deepgram/nova-3",
						].includes(row.model))
				? "voice_stt"
				: null;
	const providerUsage =
		decodedUsage &&
		decodedUsage.kind === nativeVoiceKind &&
		(nativeVoiceKind === "voice_tts"
			? decodedUsage.unit === "characters"
			: ["units", "seconds"].includes(decodedUsage.unit))
			? decodedUsage
			: null;
	const orgId =
		execution?.organizationId ??
		(nativeVoiceKind && typeof metadata.orgId === "string"
			? metadata.orgId
			: null);
	const tediId =
		execution?.tediId ??
		(nativeVoiceKind && typeof metadata.tediId === "string"
			? metadata.tediId
			: null);
	const triggerSource =
		execution?.source ??
		(nativeVoiceKind ? nativeVoiceKind.replace("_", "-") : null);
	const attribution = nativeVoiceKind
		? decodeAiGatewayAttribution(metadata.attribution)
		: null;
	const sessionKeyHash =
		nativeVoiceKind && typeof metadata.sessionKeyHash === "string"
			? metadata.sessionKeyHash.trim().slice(0, 200)
			: null;
	const sessionType: "tedi" | "tedi_observer" | "kernel" | "unattributed" =
		tediId
			? execution?.source === "observer"
				? "tedi_observer"
				: "tedi"
			: orgId
				? "kernel"
				: "unattributed";

	const isWorkersAi = row.provider === "workers-ai";
	const inputTokens = row.usage_metadata?.input_tokens ?? row.tokens_in ?? 0;
	const outputTokens = row.usage_metadata?.output_tokens ?? row.tokens_out ?? 0;
	const cacheReadTokens = row.usage_metadata?.input_cached_tokens ?? 0;
	const totalTokens =
		row.usage_metadata?.total_tokens ?? inputTokens + outputTokens;

	let estimatedCostUsd: number | null = null;
	let dataQuality: "ok" | "quarantined_no_pricing" | "quarantined_failed" =
		"quarantined_no_pricing";
	if (!row.success) dataQuality = "quarantined_failed";
	else if (
		isWorkersAi &&
		typeof row.cost === "number" &&
		Number.isFinite(row.cost) &&
		row.cost >= 0 &&
		Number.isSafeInteger(Math.round(row.cost * 1000000))
	) {
		estimatedCostUsd = row.cost;
		dataQuality = "ok";
	} else if (!isWorkersAi && !providerUsage && priced.costUsd !== null) {
		// A Gateway cache hit never reaches the provider. Preserve admission and
		// governed-rate evidence; the returned token usage remains meterable.
		estimatedCostUsd =
			row.cached && execution && priced.rateVersionId && priced.reason === null
				? 0
				: priced.costUsd;
		dataQuality = "ok";
	}

	return {
		id: crypto.randomUUID(),
		tediId,
		orgId,
		gatewayLogId: row.id,
		gatewayId,
		snapshotAt: row.created_at,
		model: row.model,
		provider: row.provider,
		providerResource: execution?.providerResource ?? null,
		providerBaseUrl: execution?.providerOrigin ?? null,
		deployment: execution?.deployment ?? null,
		runId: execution?.runId ?? attribution?.runId ?? null,
		workItemId: execution?.workItemId ?? attribution?.workItemId ?? null,
		billingReservationId:
			execution?.billingReservationId ??
			attribution?.billingReservationId ??
			null,
		sessionKeyHash,
		sessionType,
		source: triggerSource
			? `ai-gateway-log:${triggerSource}`
			: "ai-gateway-log",
		usageKind: providerUsage?.kind ?? null,
		usageUnit: providerUsage?.unit ?? null,
		usageQuantity: providerUsage?.quantity ?? null,
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens: 0,
		totalTokens,
		estimatedCostUsd,
		executionId: execution?.id ?? null,
		rawReportedCostUsd:
			typeof row.cost === "number" && Number.isFinite(row.cost)
				? row.cost
				: null,
		rateVersionId: priced.rateVersionId,
		costBasis:
			estimatedCostUsd === null
				? "unknown"
				: isWorkersAi
					? "gateway_reported"
					: "governed_estimate",
		costReason:
			estimatedCostUsd === null
				? isWorkersAi && row.success
					? "invalid_reported_cost"
					: (priced.reason ?? "invalid_reported_cost")
				: null,
		sessionCount: 1,
		success: row.success,
		cached: row.cached,
		dataQuality,
	};
}

/**
 * Demote attribution ids that do not exist to NULL.
 *
 * A gateway log's `cf-aig-metadata` is CALLER-SUPPLIED and is not trustworthy as
 * a foreign key, but `tedi_call_costs.org_id` / `.tedi_id` are REAL FKs. One row
 * naming an org or tedi that does not exist — a deleted row, or a synthetic id
 * like `b3b5a1c0-0000-0000-0000-000000000000` — raises
 * `FOREIGN KEY constraint failed`. That aborts the whole BATCHED insert, and
 * because the cursor is only advanced AFTER a successful insert, the next tick
 * re-fetches the same page, hits the same row, and fails identically. The ledger
 * wedges permanently on a single poisoned row.
 *
 * Not hypothetical: ingestion wedged on exactly this at 2026-07-07T10:15Z and
 * wrote ZERO rows for the next 7 days. Org usage, per-tedi cost, and Stripe
 * metering all silently flat-lined — and the `cost-latency-anomaly-watcher`
 * (which diffs the last 24h against a 7d baseline) could never fire, because
 * BOTH windows were empty. A broken watcher is indistinguishable from a quiet
 * one, so nothing surfaced it.
 *
 * Unknown ids are demoted to NULL rather than dropped: the row's tokens and cost
 * are still real and worth recording. NULL attribution is already a first-class
 * state here — `sessionType: "unattributed"` rows carry a NULL org_id.
 *
 * Pure, so the wedge condition is unit-testable without a live D1.
 */
export function demoteUnknownAttribution(
	rows: NewTediCallCost[],
	knownOrgIds: ReadonlySet<string>,
	knownTediIds: ReadonlySet<string>,
): {
	rows: NewTediCallCost[];
	unknownOrgIds: string[];
	unknownTediIds: string[];
} {
	const unknownOrgIds = new Set<string>();
	const unknownTediIds = new Set<string>();

	const sanitized = rows.map((row) => {
		let { orgId, tediId } = row;
		if (orgId && !knownOrgIds.has(orgId)) {
			unknownOrgIds.add(orgId);
			orgId = null;
		}
		if (tediId && !knownTediIds.has(tediId)) {
			unknownTediIds.add(tediId);
			tediId = null;
		}
		return orgId === row.orgId && tediId === row.tediId
			? row
			: { ...row, orgId, tediId };
	});

	return {
		rows: sanitized,
		unknownOrgIds: [...unknownOrgIds],
		unknownTediIds: [...unknownTediIds],
	};
}

/** Resolve which of the batch's referenced orgs/tedis actually exist. */
async function loadKnownAttribution(
	db: DbClient,
	rows: NewTediCallCost[],
): Promise<{ orgIds: Set<string>; tediIds: Set<string> }> {
	const orgIds = [
		...new Set(rows.map((r) => r.orgId).filter((v): v is string => !!v)),
	];
	const tediIds = [
		...new Set(rows.map((r) => r.tediId).filter((v): v is string => !!v)),
	];

	const known = await loadKnownGatewayAttributionIds(db, {
		organizationIds: orgIds,
		tediIds,
	});

	return {
		orgIds: new Set(known.organizationIds),
		tediIds: new Set(known.tediIds),
	};
}

async function getCursor(db: DbClient, gatewayId: GatewayId) {
	return getGatewayLogIngestionCursor(db, gatewayId);
}

async function advanceCursor(
	db: DbClient,
	gatewayId: GatewayId,
	expected: { lastLogCreatedAt: string; lastLogId: string } | null,
	lastLogCreatedAt: string,
	lastLogId: string,
): Promise<boolean> {
	return advanceGatewayLogIngestionCursor(db, {
		gatewayId,
		expected,
		lastLogCreatedAt,
		lastLogId,
		updatedAt: new Date().toISOString(),
	});
}

async function ingestGateway(
	db: DbClient,
	env: GatewayCostIngestionEnv,
	gatewayId: GatewayId,
	maxPages: number,
): Promise<GatewayIngestionResult> {
	const cursor = await getCursor(db, gatewayId);
	let expectedCursor = cursor
		? { lastLogCreatedAt: cursor.lastLogCreatedAt, lastLogId: cursor.lastLogId }
		: null;
	let sinceIso = cursor?.lastLogCreatedAt ?? "";
	// The provider sorts by created_at only. A saved ID is not a secondary
	// ordering key, and older cursors may already point inside a timestamp tie.
	// Replay that entire millisecond; gateway_log_id makes writes idempotent.
	if (cursor && Number.isFinite(Date.parse(sinceIso))) {
		sinceIso = new Date(Date.parse(sinceIso) - 1).toISOString();
	}
	if (!cursor) {
		sinceIso = new Date(Date.now() - INITIAL_BACKFILL_MS).toISOString();
	}

	let ingested = 0;
	let skipped = 0;
	let closedCreatedAt = cursor?.lastLogCreatedAt ?? sinceIso;
	let closedLogId = cursor?.lastLogId ?? "";
	let pendingLastRow: AiGatewayLogRow | undefined;
	let failure: string | null = null;
	let contended = false;

	for (let page = 1; page <= maxPages; page++) {
		let body: AiGatewayLogsResponse;
		try {
			body = await fetchLogsPage(env, gatewayId, page, sinceIso);
		} catch (error) {
			// Surfaced on the result (see GatewayIngestionResult.failure) so a
			// persistent auth/network failure cannot masquerade as "nothing new".
			failure = error instanceof Error ? error.message : String(error);
			console.error(
				`[gateway-cost-ingestion] ${gatewayId} page ${page} fetch FAILED — no rows will be ingested this tick:`,
				error,
			);
			break;
		}

		const rows = body.result ?? [];
		// A short page closes its final timestamp. A full page does not: more
		// rows with that timestamp may be on the following page, in any ID order.
		const lastTimestamp = rows.at(-1)?.created_at;
		const closedWithinPage =
			rows.length < PER_PAGE
				? rows.at(-1)
				: [...rows].reverse().find((row) => row.created_at !== lastTimestamp);
		const previousPageClosed =
			pendingLastRow &&
			(!rows[0] || pendingLastRow.created_at < rows[0].created_at)
				? pendingLastRow
				: undefined;
		const closedRow =
			closedWithinPage &&
			(!previousPageClosed ||
				closedWithinPage.created_at >= previousPageClosed.created_at)
				? closedWithinPage
				: previousPageClosed;
		// Jev has a canonical provider-response receipt keyed by execution ID.
		// Its metadata-only Gateway log is for cost observation, not another
		// tedi_call_costs row: no caller attribution is sent to the Gateway.
		// Keep the original page for cursor advancement and pagination.
		const costRows = rows.filter((row) => row.model !== "typesafe/jev");
		const executions = await getProviderExecutionsByIds(
			db,
			costRows.flatMap((row) => {
				const id = decodeAiGatewayAttribution(
					row.metadata?.attribution,
				)?.executionId;
				return id ? [id] : [];
			}),
		);
		const executionMap = new Map(
			executions.map((execution) => [execution.id, execution]),
		);
		const toInsert: NewTediCallCost[] = [];
		for (const row of costRows) {
			const id = decodeAiGatewayAttribution(
				row.metadata?.attribution,
			)?.executionId;
			const candidate = id ? (executionMap.get(id) ?? null) : null;
			const execution = matchesGatewayExecution(
				row,
				gatewayId,
				env.CF_ACCOUNT_ID,
				candidate,
			)
				? candidate
				: null;
			const priced = execution
				? await priceProviderUsage(
						env,
						{
							provider: execution.provider,
							modelId: execution.requestModel,
							deploymentScope: execution.deploymentScope,
							occurredAt: row.created_at,
						},
						{
							inputTokens: row.usage_metadata?.input_tokens ?? row.tokens_in,
							outputTokens: row.usage_metadata?.output_tokens ?? row.tokens_out,
							cacheReadTokens: row.usage_metadata?.input_cached_tokens ?? 0,
							cacheWriteTokens: 0,
						},
					)
				: {
						costUsd: null,
						rateVersionId: null,
						reason: "unverified_execution",
					};
			toInsert.push(mapRowToCallCost(row, gatewayId, { ...priced, execution }));
		}

		if (toInsert.length > 0) {
			// Never insert a dangling foreign key — see demoteUnknownAttribution.
			const known = await loadKnownAttribution(db, toInsert);
			const {
				rows: safeRows,
				unknownOrgIds,
				unknownTediIds,
			} = demoteUnknownAttribution(toInsert, known.orgIds, known.tediIds);
			if (unknownOrgIds.length || unknownTediIds.length) {
				console.warn(
					`[gateway-cost-ingestion] ${gatewayId} page ${page}: demoted unknown attribution to NULL — orgs=[${unknownOrgIds.join(", ")}] tedis=[${unknownTediIds.join(", ")}]`,
				);
			}

			let inserted: Awaited<ReturnType<typeof insertCallCosts>> = [];
			try {
				inserted = await insertCallCosts(db, safeRows);
			} catch (error) {
				// Backstop: a batched insert is all-or-nothing, so ANY single bad row
				// would otherwise abort the batch, block the cursor, and re-fail on
				// every subsequent tick — forever. Fall back to per-row so the
				// offenders are isolated and dropped while everything else lands and
				// the cursor still advances. The ledger must degrade, never wedge.
				console.warn(
					`[gateway-cost-ingestion] ${gatewayId} page ${page} batch insert failed; retrying row-by-row:`,
					error,
				);
				for (const row of safeRows) {
					try {
						inserted.push(...(await insertCallCosts(db, [row])));
					} catch (rowError) {
						// Counted via (safeRows.length - inserted.length) below.
						console.warn(
							`[gateway-cost-ingestion] ${gatewayId} dropping unwritable row gatewayLogId=${row.gatewayLogId}:`,
							rowError,
						);
					}
				}
			}

			ingested += inserted.length;
			skipped += safeRows.length - inserted.length;

			if (inserted.length === 0) {
				// ON CONFLICT DO NOTHING returns zero when every page row was
				// already written before the cursor advanced. Do not mistake that
				// idempotent replay for a D1 outage. Require exact durable IDs from
				// this gateway; an incomplete or failed read must hold the cursor.
				const pageIds = new Set(safeRows.map((row) => row.gatewayLogId));
				let allDurable = false;
				try {
					const existing = await getExistingGatewayLogIds(db, gatewayId, [
						...pageIds,
					]);
					const durableIds = new Set(existing);
					allDurable = [...pageIds].every((id) => durableIds.has(id));
				} catch (readError) {
					console.error(
						`[gateway-cost-ingestion] ${gatewayId} page ${page} durability read failed:`,
						readError,
					);
				}
				if (!allDurable) {
					failure = `page ${page}: 0/${safeRows.length} rows written and not all page IDs confirmed durable; cursor held for retry`;
					console.error(
						`[gateway-cost-ingestion] ${gatewayId} page ${page}: page durability incomplete — holding cursor at (${closedCreatedAt}, ${closedLogId}) so the page retries next tick`,
					);
					break;
				}
			}
		}

		if (closedRow && closedRow.created_at > closedCreatedAt) {
			const advanced = await advanceCursor(
				db,
				gatewayId,
				expectedCursor,
				closedRow.created_at,
				closedRow.id,
			);
			if (!advanced) {
				// Page offsets came from the old cursor. Another tick now owns the
				// newer offset, so continuing would risk skipping a timestamp tie.
				contended = true;
				break;
			}
			closedCreatedAt = closedRow.created_at;
			closedLogId = closedRow.id;
			expectedCursor = {
				lastLogCreatedAt: closedCreatedAt,
				lastLogId: closedLogId,
			};
		}
		pendingLastRow = rows.at(-1);

		if (rows.length < PER_PAGE) {
			// Caught up — nothing more to page through this tick.
			break;
		}
		if (page === maxPages) {
			// One bounded lookahead distinguishes a closed final-page timestamp
			// from a tie crossing the cap. Never persist that timestamp merely
			// because the page budget ran out.
			try {
				const lookahead = await fetchLogsPage(
					env,
					gatewayId,
					page + 1,
					sinceIso,
				);
				if (lookahead.result?.[0]?.created_at === lastTimestamp) {
					failure = `page ${page}: timestamp tie crosses the page cap; cursor held for retry`;
				} else if (lastTimestamp && lastTimestamp > closedCreatedAt) {
					const advanced = await advanceCursor(
						db,
						gatewayId,
						expectedCursor,
						lastTimestamp,
						rows.at(-1)!.id,
					);
					if (advanced) {
						closedCreatedAt = lastTimestamp;
						closedLogId = rows.at(-1)!.id;
					} else contended = true;
				}
			} catch (error) {
				failure = `page ${page + 1} lookahead failed; cursor held: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
	}

	return { gatewayId, ingested, skipped, failure, contended };
}

/**
 * Ingest new AI Gateway log rows for every active platform gateway, writing
 * one `tedi_call_costs` row per gateway log row and advancing each gateway's
 * cursor. Errors on one gateway do not block the other (each is isolated by
 * `fetchLogsPage`'s own try/catch — a hard failure there just breaks that
 * gateway's page loop for this tick, leaving its cursor unadvanced past the
 * last successfully processed page so the next tick resumes forward).
 */
export async function ingestGatewayLogCosts(
	db: DbClient,
	env: GatewayCostIngestionEnv,
	options?: { maxPagesPerGateway?: number },
): Promise<GatewayIngestionResult[]> {
	const maxPages = options?.maxPagesPerGateway ?? MAX_PAGES_PER_RUN;
	if (
		!Number.isSafeInteger(maxPages) ||
		maxPages < 1 ||
		maxPages > MAX_PAGES_PER_RUN
	)
		throw new Error("Gateway ingestion page budget must be between 1 and 40");
	const configuredGateway = env.AI_GATEWAY_LLM_ID?.trim();
	if (!configuredGateway)
		throw new Error(
			"AI_GATEWAY_LLM_ID is not set — configure the installation's gateway before ingesting costs.",
		);
	// Include platform-unattributed AI Search/catalog spend, without duplicate reads.
	const gatewayIds = [...new Set([configuredGateway, "default"])];
	// Fail LOUD on a missing credential rather than firing 40 pages of doomed
	// requests per gateway and reporting them as an ordinary fetch failure. An
	// unset secret is an operator problem, and it must read like one.
	if (!env.CF_AI_GATEWAY_TOKEN?.trim()) {
		const failure =
			"CF_AI_GATEWAY_TOKEN is not set — the cost ledger CANNOT be written. Set the Worker secret (see wrangler.jsonc secrets.required).";
		console.error(`[gateway-cost-ingestion] ${failure}`);
		return gatewayIds.map((gatewayId) => ({
			gatewayId,
			ingested: 0,
			skipped: 0,
			failure,
		}));
	}

	const results: GatewayIngestionResult[] = [];
	// Sequential, not parallel — keeps D1 write pressure and CF API burst modest.
	for (const gatewayId of gatewayIds) {
		results.push(await ingestGateway(db, env, gatewayId, maxPages));
	}

	return results;
}

export function matchesGatewayExecution(
	row: AiGatewayLogRow,
	gatewayId: string,
	accountId: string,
	execution: ProviderExecutionAttemptRow | null,
): boolean {
	if (
		!execution ||
		execution.gatewayAccountId !== accountId ||
		execution.gatewayId !== gatewayId ||
		execution.provider !== row.provider
	)
		return false;
	const time = Date.parse(row.created_at);
	if (
		!Number.isFinite(time) ||
		time < Date.parse(execution.authorizedAt) ||
		time > Date.parse(execution.sendBefore)
	)
		return false;
	const meta = row.metadata ?? {};
	if (
		meta.orgId !== execution.organizationId ||
		(meta.tediId && meta.tediId !== execution.tediId)
	)
		return false;
	const packed = decodeAiGatewayAttribution(meta.attribution);
	if (
		packed?.executionId !== execution.id ||
		(packed.billingReservationId ?? null) !== execution.billingReservationId ||
		(execution.runId && packed.runId !== execution.runId) ||
		(execution.workItemId && packed.workItemId !== execution.workItemId)
	)
		return false;
	if (execution.provider === "workers-ai")
		return row.model === execution.requestModel;
	const path = row.path?.split("?")[0];
	const expected =
		execution.apiKind === "azure-chat"
			? `${execution.providerResource}/${execution.deployment}/chat/completions`
			: `${execution.providerResource}/openai/v1/responses`;
	return (
		path === expected &&
		(row.model === execution.requestModel ||
			row.model === `openai/${execution.requestModel}`)
	);
}

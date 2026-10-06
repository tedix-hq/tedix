const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const MAX_TRACE_IDS_PER_QUERY = 50;
const MAX_EVENTS_PER_QUERY = 2_000;

type ObservabilityEnv = Pick<
	CloudflareEnv,
	"CF_ACCOUNT_ID" | "CF_OBSERVABILITY_TOKEN"
>;

interface TelemetryEnvelope {
	success?: unknown;
	errors?: unknown;
	result?: unknown;
}

interface TelemetryEvent {
	$metadata?: { traceId?: unknown };
	[key: string]: unknown;
}

interface TelemetryTrace {
	id?: unknown;
	traceId?: unknown;
	services?: unknown;
	spans?: unknown;
	traceDurationMs?: unknown;
	traceStartMs?: unknown;
	traceEndMs?: unknown;
	errors?: unknown;
}

export interface CloudflareTraceEvidence {
	cloudflareTraceId: string;
	durationMs: number;
	errorCount: number;
	serviceNames: string[];
	spanCount: number;
	traceEndAt: string;
	traceStartAt: string;
}

export interface WorkersTraceEvidenceQuery {
	fromMs: number;
	toMs: number;
	traceIds: string[];
}

export function hasWorkersObservabilityConfig(
	env: Partial<ObservabilityEnv>,
): env is ObservabilityEnv {
	return Boolean(env.CF_ACCOUNT_ID && env.CF_OBSERVABILITY_TOKEN);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readPath(value: unknown, path: string): unknown {
	if (!isObject(value)) return undefined;
	if (path in value) return value[path];
	let current: unknown = value;
	for (const segment of path.split(".")) {
		if (!isObject(current)) return undefined;
		current = current[segment];
	}
	return current;
}

function chunks<T>(values: T[], size: number): T[][] {
	const result: T[][] = [];
	for (let offset = 0; offset < values.length; offset += size) {
		result.push(values.slice(offset, offset + size));
	}
	return result;
}

function isoFromEpochMs(value: unknown): string | null {
	const ms = numberValue(value);
	if (ms == null) return null;
	const date = new Date(ms);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function runTelemetryQuery(
	env: ObservabilityEnv,
	body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const response = await fetch(
		`${CLOUDFLARE_API_BASE}/accounts/${env.CF_ACCOUNT_ID}/workers/observability/telemetry/query`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${env.CF_OBSERVABILITY_TOKEN}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		},
	);
	const envelope = (await response.json()) as TelemetryEnvelope;
	if (!response.ok || envelope.success !== true || !isObject(envelope.result)) {
		throw new Error(`Workers Observability query failed (${response.status})`);
	}
	return envelope.result;
}

function queryBody(input: {
	fromMs: number;
	toMs: number;
	view: "events" | "traces";
	filterKey: string;
	filterValues: string[];
}): Record<string, unknown> {
	return {
		queryId: `tedix-activity-review-${input.view}`,
		timeframe: { from: input.fromMs, to: input.toMs },
		dry: true,
		view: input.view,
		limit: MAX_EVENTS_PER_QUERY,
		parameters: {
			datasets: [],
			filterCombination: "and",
			filters: [
				{
					kind: "filter",
					key: input.filterKey,
					operation: "in",
					type: "string",
					value: input.filterValues.join(","),
				},
			],
			limit: MAX_EVENTS_PER_QUERY,
		},
	};
}

function readEvents(result: Record<string, unknown>): TelemetryEvent[] {
	const eventsContainer = result.events;
	if (!isObject(eventsContainer) || !Array.isArray(eventsContainer.events)) {
		return [];
	}
	return eventsContainer.events.filter(isObject) as TelemetryEvent[];
}

function readTraces(result: Record<string, unknown>): TelemetryTrace[] {
	return Array.isArray(result.traces)
		? (result.traces.filter(isObject) as TelemetryTrace[])
		: [];
}

function parseTraceEvidence(
	trace: TelemetryTrace,
): CloudflareTraceEvidence | null {
	const cloudflareTraceId = stringValue(trace.traceId) ?? stringValue(trace.id);
	const durationMs = numberValue(trace.traceDurationMs);
	const spanCount = numberValue(trace.spans);
	const traceStartAt = isoFromEpochMs(trace.traceStartMs);
	const traceEndAt = isoFromEpochMs(trace.traceEndMs);
	if (
		!cloudflareTraceId ||
		durationMs == null ||
		spanCount == null ||
		!traceStartAt ||
		!traceEndAt
	) {
		return null;
	}
	return {
		cloudflareTraceId,
		durationMs,
		errorCount: Array.isArray(trace.errors) ? trace.errors.length : 0,
		serviceNames: Array.isArray(trace.services)
			? trace.services.filter(
					(service): service is string => typeof service === "string",
				)
			: [],
		spanCount,
		traceEndAt,
		traceStartAt,
	};
}

/**
 * Resolve org-scoped Tedix trace IDs to sampled Cloudflare trace summaries.
 *
 * Cloudflare re-roots Worker traces to a 32-hex trace ID. The custom MCP span
 * carries only `tedix.trace_id`, so the first bounded query discovers that
 * sampled Cloudflare ID and the second reads the `traces` summary. No log
 * messages, prompts, tool inputs, or tool outputs leave this module.
 */
export async function queryWorkersTraceEvidence(
	env: ObservabilityEnv,
	input: WorkersTraceEvidenceQuery,
): Promise<Map<string, CloudflareTraceEvidence>> {
	const uniqueTraceIds = Array.from(new Set(input.traceIds)).slice(0, 100);
	if (uniqueTraceIds.length === 0) return new Map();

	const tedixTraceIdByCloudflareTraceId = new Map<string, string>();
	for (const traceIds of chunks(uniqueTraceIds, MAX_TRACE_IDS_PER_QUERY)) {
		const result = await runTelemetryQuery(
			env,
			queryBody({
				fromMs: input.fromMs,
				toMs: input.toMs,
				view: "events",
				filterKey: "tedix.trace_id",
				filterValues: traceIds,
			}),
		);
		for (const event of readEvents(result)) {
			const tedixTraceId = stringValue(readPath(event, "tedix.trace_id"));
			const cloudflareTraceId = stringValue(event.$metadata?.traceId);
			if (tedixTraceId && cloudflareTraceId) {
				tedixTraceIdByCloudflareTraceId.set(cloudflareTraceId, tedixTraceId);
			}
		}
	}

	const cloudflareTraceIds = Array.from(tedixTraceIdByCloudflareTraceId.keys());
	if (cloudflareTraceIds.length === 0) return new Map();

	const evidenceByTedixTraceId = new Map<string, CloudflareTraceEvidence>();
	for (const traceIds of chunks(cloudflareTraceIds, MAX_TRACE_IDS_PER_QUERY)) {
		const result = await runTelemetryQuery(
			env,
			queryBody({
				fromMs: input.fromMs,
				toMs: input.toMs,
				view: "traces",
				filterKey: "$metadata.traceId",
				filterValues: traceIds,
			}),
		);
		for (const trace of readTraces(result)) {
			const evidence = parseTraceEvidence(trace);
			if (!evidence) continue;
			const tedixTraceId = tedixTraceIdByCloudflareTraceId.get(
				evidence.cloudflareTraceId,
			);
			if (tedixTraceId) evidenceByTedixTraceId.set(tedixTraceId, evidence);
		}
	}

	return evidenceByTedixTraceId;
}

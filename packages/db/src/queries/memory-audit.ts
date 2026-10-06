export type BrainAuditScope = "self" | "org" | "visible" | "all";
export type BrainAuditTopicKeyState = "any" | "missing" | "present";
export type BrainAuditOrderBy = "created_desc" | "updated_desc";

export type BrainAuditInput = {
	scope?: BrainAuditScope;
	topic_key_state?: BrainAuditTopicKeyState;
	review_status?: string;
	priority?: string;
	use_policy?: string;
	fact_type?: string;
	status?: string;
	source_session_id?: string;
	source_prefix?: string;
	producer?: string;
	search?: string;
	include_archived?: boolean;
	limit?: number;
	offset?: number;
	order_by?: BrainAuditOrderBy;
};

export type BrainAuditFact = {
	id: string;
	tediId: string | null;
	contentPreview: string;
	summary: string | null;
	factType: string;
	confidence: number;
	status: string | null;
	source: string | null;
	sourceSessionId: string | null;
	topicKey: string | null;
	memoryScope: string | null;
	usePolicy: string | null;
	reviewStatus: string | null;
	metadata: unknown;
	producer: string | null;
	sourceKind: string | null;
	priority: string | null;
	visibility: string | null;
	promotedFrom: string | null;
	promotedAt: string | null;
	archivedAt: string | null;
	createdAt: string | null;
	updatedAt: string | null;
};

export type BrainAuditResult = {
	ok: true;
	filters: Required<
		Pick<
			BrainAuditInput,
			| "scope"
			| "topic_key_state"
			| "include_archived"
			| "limit"
			| "offset"
			| "order_by"
		>
	> &
		Omit<
			BrainAuditInput,
			| "scope"
			| "topic_key_state"
			| "include_archived"
			| "limit"
			| "offset"
			| "order_by"
		>;
	counts: {
		total: number;
		activePendingMissingTopicKey: number;
		byReviewStatus: Record<string, number>;
		byPriority: Record<string, number>;
		byFactType: Record<string, number>;
		byProducer: Record<string, number>;
	};
	facts: BrainAuditFact[];
	nextOffset: number | null;
};

type QueryValue = string | number | null;

export interface BrainAuditDeps {
	db: {
		prepare(sql: string): {
			bind(...args: QueryValue[]): {
				first<T>(): Promise<T | null>;
				all<T>(): Promise<{ results?: T[] }>;
			};
		};
	};
	organizationId: string;
	tediId: string;
}

type WhereClause = {
	sql: string;
	params: QueryValue[];
	scopeOnlySql: string;
	scopeOnlyParams: QueryValue[];
};

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

const GROUP_COLUMNS = {
	review_status: "review_status",
	priority: "priority",
	fact_type: "fact_type",
	producer: "json_extract(metadata, '$.producer')",
} as const;

const ORDER_BY_SQL: Record<BrainAuditOrderBy, string> = {
	created_desc: "created_at DESC, id ASC",
	updated_desc: "updated_at DESC, id ASC",
};

export async function auditMemoryGraph(
	deps: BrainAuditDeps,
	input: BrainAuditInput = {},
): Promise<BrainAuditResult> {
	const filters = normalizeInput(input);
	const where = buildWhereClause(deps, filters);
	const orderBy = ORDER_BY_SQL[filters.order_by];

	const facts = await runAll<MemoryFactRow>(
		deps.db,
		`
			SELECT
				id,
				tedi_id AS tediId,
				substr(content, 1, 1200) AS contentPreview,
				summary,
				fact_type AS factType,
				confidence,
				status,
				source,
				source_session_id AS sourceSessionId,
				topic_key AS topicKey,
				memory_scope AS memoryScope,
				use_policy AS usePolicy,
				review_status AS reviewStatus,
				metadata,
				json_extract(metadata, '$.producer') AS producer,
				json_extract(metadata, '$.sourceKind') AS sourceKind,
				priority,
				visibility,
				promoted_from AS promotedFrom,
				promoted_at AS promotedAt,
				archived_at AS archivedAt,
				created_at AS createdAt,
				updated_at AS updatedAt
			FROM memory_facts
			${where.sql}
			ORDER BY ${orderBy}
			LIMIT ? OFFSET ?
		`,
		[...where.params, filters.limit, filters.offset],
	);

	const totalRow = await runFirst<CountRow>(
		deps.db,
		`SELECT COUNT(*) AS count FROM memory_facts ${where.sql}`,
		where.params,
	);
	const activePendingMissingTopicKeyRow = await runFirst<CountRow>(
		deps.db,
		`
			SELECT COUNT(*) AS count
			FROM memory_facts
			${where.scopeOnlySql}
			  AND archived_at IS NULL
			  AND review_status = 'pending'
			  AND priority = 'active'
			  AND (topic_key IS NULL OR trim(topic_key) = '')
		`,
		where.scopeOnlyParams,
	);

	const total = numberFromCount(totalRow?.count);
	return {
		ok: true,
		filters,
		counts: {
			total,
			activePendingMissingTopicKey: numberFromCount(
				activePendingMissingTopicKeyRow?.count,
			),
			byReviewStatus: await groupCounts(
				deps.db,
				GROUP_COLUMNS.review_status,
				where,
			),
			byPriority: await groupCounts(deps.db, GROUP_COLUMNS.priority, where),
			byFactType: await groupCounts(deps.db, GROUP_COLUMNS.fact_type, where),
			byProducer: await groupCounts(deps.db, GROUP_COLUMNS.producer, where),
		},
		facts: facts.map(shapeFact),
		nextOffset:
			filters.offset + facts.length < total
				? filters.offset + facts.length
				: null,
	};
}

function normalizeInput(input: BrainAuditInput): BrainAuditResult["filters"] {
	const scope = isOneOf(input.scope, ["self", "org", "visible", "all"])
		? input.scope
		: "self";
	const topicKeyState = isOneOf(input.topic_key_state, [
		"any",
		"missing",
		"present",
	])
		? input.topic_key_state
		: "any";
	const orderBy = isOneOf(input.order_by, ["created_desc", "updated_desc"])
		? input.order_by
		: "created_desc";
	return {
		scope,
		topic_key_state: topicKeyState,
		review_status: cleanOptional(input.review_status),
		priority: cleanOptional(input.priority),
		use_policy: cleanOptional(input.use_policy),
		fact_type: cleanOptional(input.fact_type),
		status: cleanOptional(input.status),
		source_session_id: cleanOptional(input.source_session_id),
		source_prefix: cleanOptional(input.source_prefix),
		producer: cleanOptional(input.producer),
		search: cleanOptional(input.search),
		include_archived: input.include_archived === true,
		limit: clampInteger(input.limit, DEFAULT_LIMIT, 1, MAX_LIMIT),
		offset: clampInteger(input.offset, 0, 0, 100_000),
		order_by: orderBy,
	};
}

function buildWhereClause(
	deps: BrainAuditDeps,
	input: BrainAuditResult["filters"],
): WhereClause {
	const scope = buildScopeClause(deps, input.scope);
	const clauses = [...scope.clauses];
	const params = [...scope.params];

	if (!input.include_archived) {
		clauses.push("archived_at IS NULL");
	}
	if (input.topic_key_state === "missing") {
		clauses.push("(topic_key IS NULL OR trim(topic_key) = '')");
	}
	if (input.topic_key_state === "present") {
		clauses.push("(topic_key IS NOT NULL AND trim(topic_key) <> '')");
	}
	addExactFilter(clauses, params, "review_status", input.review_status);
	addExactFilter(clauses, params, "priority", input.priority);
	addExactFilter(clauses, params, "use_policy", input.use_policy);
	addExactFilter(clauses, params, "fact_type", input.fact_type);
	addExactFilter(clauses, params, "status", input.status);
	addExactFilter(clauses, params, "source_session_id", input.source_session_id);
	if (input.source_prefix) {
		clauses.push("source LIKE ?");
		params.push(`${escapeLike(input.source_prefix)}%`);
	}
	if (input.producer) {
		clauses.push("json_extract(metadata, '$.producer') = ?");
		params.push(input.producer);
	}
	if (input.search) {
		clauses.push("(content LIKE ? OR summary LIKE ?)");
		const pattern = `%${escapeLike(input.search)}%`;
		params.push(pattern, pattern);
	}

	return {
		sql: `WHERE ${clauses.join(" AND ")}`,
		params,
		scopeOnlySql: `WHERE ${scope.clauses.join(" AND ")}`,
		scopeOnlyParams: scope.params,
	};
}

function buildScopeClause(
	deps: BrainAuditDeps,
	scope: BrainAuditScope,
): { clauses: string[]; params: QueryValue[] } {
	const clauses = ["organization_id = ?"];
	const params: QueryValue[] = [deps.organizationId];
	if (scope === "self") {
		clauses.push("tedi_id = ?");
		params.push(deps.tediId);
	}
	if (scope === "org") {
		clauses.push(
			"(tedi_id IS NULL OR memory_scope IN ('org', 'kernel') OR visibility IN ('shared', 'org'))",
		);
	}
	if (scope === "visible") {
		clauses.push(
			"(tedi_id = ? OR tedi_id IS NULL OR memory_scope IN ('org', 'kernel') OR visibility IN ('shared', 'org'))",
		);
		params.push(deps.tediId);
	}
	return { clauses, params };
}

function addExactFilter(
	clauses: string[],
	params: QueryValue[],
	column: string,
	value: string | undefined,
): void {
	if (!value || value === "any") return;
	clauses.push(`${column} = ?`);
	params.push(value);
}

async function groupCounts(
	db: BrainAuditDeps["db"],
	columnSql: string,
	where: WhereClause,
): Promise<Record<string, number>> {
	const rows = await runAll<GroupCountRow>(
		db,
		`
			SELECT COALESCE(${columnSql}, '__null__') AS value, COUNT(*) AS count
			FROM memory_facts
			${where.sql}
			GROUP BY ${columnSql}
			ORDER BY count DESC, value ASC
			LIMIT 50
		`,
		where.params,
	);
	return Object.fromEntries(
		rows.map((row) => [String(row.value), numberFromCount(row.count)]),
	);
}

async function runFirst<T>(
	db: BrainAuditDeps["db"],
	sql: string,
	params: QueryValue[],
): Promise<T | null> {
	return db
		.prepare(sql)
		.bind(...params)
		.first<T>();
}

async function runAll<T>(
	db: BrainAuditDeps["db"],
	sql: string,
	params: QueryValue[],
): Promise<T[]> {
	const result = await db
		.prepare(sql)
		.bind(...params)
		.all<T>();
	return result.results ?? [];
}

function shapeFact(row: MemoryFactRow): BrainAuditFact {
	return {
		...row,
		confidence:
			typeof row.confidence === "number"
				? row.confidence
				: Number(row.confidence ?? 0),
		metadata: parseMetadata(row.metadata),
	};
}

function parseMetadata(value: unknown): unknown {
	if (typeof value !== "string") return value ?? null;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

function cleanOptional(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function clampInteger(
	value: unknown,
	fallback: number,
	min: number,
	max: number,
): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(Math.max(Math.trunc(value), min), max);
}

function isOneOf<T extends string>(
	value: unknown,
	allowed: readonly T[],
): value is T {
	return typeof value === "string" && allowed.includes(value as T);
}

function escapeLike(value: string): string {
	return value
		.replaceAll("\\", "\\\\")
		.replaceAll("%", "\\%")
		.replaceAll("_", "\\_");
}

function numberFromCount(value: unknown): number {
	return typeof value === "number" ? value : Number(value ?? 0);
}

type CountRow = { count: number | string | null };
type GroupCountRow = { value: string | null; count: number | string | null };
type MemoryFactRow = Omit<BrainAuditFact, "metadata"> & {
	metadata: unknown;
	confidence: number | string | null;
};

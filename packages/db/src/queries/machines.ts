/**
 * Machines and the queue of tool calls for them. A machine is known
 * by the name its runners send with their health reports; a call is queued for
 * that name, claimed by a runner on the machine and answered once.
 */

import {
	and,
	asc,
	desc,
	eq,
	gt,
	gte,
	inArray,
	isNotNull,
	lt,
	lte,
	or,
	sql,
} from "drizzle-orm";
import { alias as sqliteAlias } from "drizzle-orm/sqlite-core";
import { alias as pgAlias } from "drizzle-orm/pg-core";
import { coreStore } from "../core-store/dialect";
import {
	MACHINE_COMMAND_ANSWER_WINDOW_MS,
	MACHINE_FILE_ANSWER_WINDOW_MS,
	MACHINE_ONLINE_WINDOW_MS,
	MACHINE_TOOL_CALL_ANSWER_WINDOW_MS,
	MACHINE_TOOL_CALL_CLAIM_WINDOW_MS,
	MACHINE_TOOL_CALL_STATUS_VALUES,
	MACHINE_TOOL_CALL_TIMEOUT_ERROR,
	MACHINE_TOOL_ERROR_MAX_CHARS,
	MACHINE_TOOL_NAMES,
	MACHINE_TOOL_RESULT_MAX_CHARS,
	MACHINE_WRITE_TOOL_NAMES,
	type MachineToolName,
} from "@tedix/api-contract/schemas/machines";
import { coreTable } from "../core-store/client";
import type { DbQueryClient } from "../query-client";
import { dispatcherHealthReports as schemaDispatcherHealthReports } from "../schema/dispatcher-health";
import {
	machineToolCalls as schemaMachineToolCalls,
	machineToolPolls as schemaMachineToolPolls,
	type MachineToolCallRequesterType,
	type MachineToolCallRow,
} from "../schema/machines";

export interface ListMachinesResult {
	machineName: string;
	executors: string[];
	lastSeenAt: string;
	cliVersion: string | null;
	machineTools: MachineToolName[];
	online: boolean;
}

const KNOWN_TOOLS = new Set<string>(MACHINE_TOOL_NAMES);

/**
 * Machines of exactly one organization, grouped by the name their runners
 * report. The newest report of a machine decides the tools it accepts.
 */
export async function listMachines(
	db: DbQueryClient,
	params: { orgId: string; at?: string },
): Promise<ListMachinesResult[]> {
	const dispatcherHealthReports = coreTable(db, schemaDispatcherHealthReports);
	const machineToolPolls = coreTable(db, schemaMachineToolPolls);
	const now = Date.parse(params.at ?? new Date().toISOString());
	const [rows, polls] = await db.batch([
		db
			.select({
				machineName: dispatcherHealthReports.machineName,
				executor: dispatcherHealthReports.executor,
				reportedAt: dispatcherHealthReports.reportedAt,
				cliVersion: dispatcherHealthReports.cliVersion,
				machineTools: dispatcherHealthReports.machineTools,
			})
			.from(dispatcherHealthReports)
			.where(
				and(
					eq(dispatcherHealthReports.orgId, params.orgId),
					isNotNull(dispatcherHealthReports.machineName),
				),
			)
			.orderBy(asc(dispatcherHealthReports.reportedAt)),
		db
			.select({
				machineName: machineToolPolls.machineName,
				lastPolledAt: machineToolPolls.lastPolledAt,
			})
			.from(machineToolPolls)
			.where(eq(machineToolPolls.orgId, params.orgId)),
	]);
	const machines = new Map<string, ListMachinesResult & { key: string }>();
	for (const row of rows) {
		if (!row.machineName) continue;
		const key = row.machineName.toLowerCase();
		const machine = machines.get(key) ?? {
			key,
			machineName: row.machineName,
			executors: [],
			lastSeenAt: row.reportedAt,
			cliVersion: null,
			machineTools: [],
			online: false,
		};
		// Rows arrive oldest first, so the newest report wins.
		machine.machineName = row.machineName;
		machine.lastSeenAt = row.reportedAt;
		machine.cliVersion = row.cliVersion ?? machine.cliVersion;
		if (Array.isArray(row.machineTools))
			machine.machineTools = [
				...new Set(row.machineTools.filter((tool) => KNOWN_TOOLS.has(tool))),
			] as MachineToolName[];
		// The supervisor's own heartbeat row is not an agent the machine runs.
		if (
			row.executor !== "supervisor" &&
			!machine.executors.includes(row.executor)
		)
			machine.executors.push(row.executor);
		machines.set(key, machine);
	}
	for (const poll of polls) {
		const machine = machines.get(poll.machineName);
		if (machine && poll.lastPolledAt > machine.lastSeenAt)
			machine.lastSeenAt = poll.lastPolledAt;
	}
	return [...machines.values()]
		.map(({ key: _key, ...machine }) => ({
			...machine,
			executors: machine.executors.sort(),
			online: now - Date.parse(machine.lastSeenAt) <= MACHINE_ONLINE_WINDOW_MS,
		}))
		.sort((a, b) => a.machineName.localeCompare(b.machineName));
}

/**
 * Whose computer each machine is, by its lowercase name: the account its
 * runners sign in with, such as `user:<id>`. Null when no report names an
 * account or when reports for that name come from more than one account.
 */
export async function listMachineOwners(
	db: DbQueryClient,
	params: { orgId: string },
): Promise<Map<string, string | null>> {
	const dispatcherHealthReports = coreTable(db, schemaDispatcherHealthReports);
	const rows = await db
		.selectDistinct({
			machineName: dispatcherHealthReports.machineName,
			reportedBy: dispatcherHealthReports.reportedBy,
		})
		.from(dispatcherHealthReports)
		.where(
			and(
				eq(dispatcherHealthReports.orgId, params.orgId),
				isNotNull(dispatcherHealthReports.machineName),
			),
		);
	const owners = new Map<string, string | null>();
	for (const row of rows) {
		if (!row.machineName) continue;
		const key = row.machineName.toLowerCase();
		const account = row.reportedBy ?? null;
		owners.set(
			key,
			owners.has(key) && owners.get(key) !== account ? null : account,
		);
	}
	return owners;
}

/**
 * True when `reportedBy` sent a health report for this machine under this
 * reporter id. Only then may the caller claim the machine's tool calls.
 */
export async function isMachineReporter(
	db: DbQueryClient,
	params: {
		orgId: string;
		reporterId: string;
		machineName: string;
		reportedBy: string;
	},
): Promise<boolean> {
	const dispatcherHealthReports = coreTable(db, schemaDispatcherHealthReports);
	const rows = await db
		.select({ reporterId: dispatcherHealthReports.reporterId })
		.from(dispatcherHealthReports)
		.where(
			and(
				eq(dispatcherHealthReports.orgId, params.orgId),
				eq(dispatcherHealthReports.reporterId, params.reporterId),
				eq(dispatcherHealthReports.machineName, params.machineName),
				eq(dispatcherHealthReports.reportedBy, params.reportedBy),
			),
		)
		.limit(1);
	return rows.length > 0;
}

/** How many calls may wait for one machine before new ones are refused. */
export const MACHINE_TOOL_CALL_MAX_WAITING = 20;

export interface CreateMachineToolCallParams {
	id: string;
	orgId: string;
	machineName: string;
	tool: MachineToolName;
	/** The tool's checked input as JSON text. */
	input: string;
	requestedBy: { type: MachineToolCallRequesterType; id: string };
	at?: string;
}

/**
 * Queue one call. Returns null when too many calls already wait for the
 * machine; the check and the insert are one statement.
 */
export async function createMachineToolCall(
	db: DbQueryClient,
	params: CreateMachineToolCallParams,
): Promise<MachineToolCallRow | null> {
	const machineToolCalls = coreTable(db, schemaMachineToolCalls);
	const alias =
		coreStore(db) === "postgres"
			? (pgAlias as unknown as typeof sqliteAlias)
			: sqliteAlias;
	const at = params.at ?? new Date().toISOString();
	const expiresAt = new Date(
		Date.parse(at) + MACHINE_TOOL_CALL_CLAIM_WINDOW_MS,
	).toISOString();
	const waiting = alias(machineToolCalls, "waiting");
	const [row] = await db
		.insert(machineToolCalls)
		.select(
			db
				.select({
					id: sql<string>`${params.id}`.as("id"),
					orgId: sql<string>`${params.orgId}`.as("org_id"),
					machineName: sql<string>`${params.machineName}`.as("machine_name"),
					tool: sql<MachineToolName>`${params.tool}`.as("tool"),
					input: sql<string>`${params.input}`.as("input"),
					requestedByType:
						sql<MachineToolCallRequesterType>`${params.requestedBy.type}`.as(
							"requested_by_type",
						),
					requestedById: sql<string>`${params.requestedBy.id}`.as(
						"requested_by_id",
					),
					status: sql<"pending">`'pending'`.as("status"),
					result: sql<null>`NULL`.as("result"),
					error: sql<null>`NULL`.as("error"),
					claimedByReporterId: sql<null>`NULL`.as("claimed_by_reporter_id"),
					createdAt: sql<string>`${at}`.as("created_at"),
					claimedAt: sql<null>`NULL`.as("claimed_at"),
					finishedAt: sql<null>`NULL`.as("finished_at"),
					expiresAt: sql<string>`${expiresAt}`.as("expires_at"),
				})
				.from(sql`(SELECT 1) AS one`)
				.where(
					sql`${db
						.select({ n: sql`count(*)` })
						.from(waiting)
						.where(
							and(
								eq(waiting.orgId, params.orgId),
								eq(waiting.machineName, params.machineName),
								eq(waiting.status, "pending"),
								gt(waiting.expiresAt, at),
							),
						)} < ${MACHINE_TOOL_CALL_MAX_WAITING}`,
				),
		)
		.returning();
	return row ?? null;
}

/**
 * Settle calls whose time ran out: a waiting call nobody claimed expires, and
 * a claimed call without an answer fails. `scope` narrows it to one call or
 * one machine; the organization always bounds it.
 */
function buildSettleOverdueStatement(
	db: DbQueryClient,
	params: {
		orgId: string;
		at: string;
		scope: { id: string } | { machineName: string };
	},
) {
	const machineToolCalls = coreTable(db, schemaMachineToolCalls);
	const answerDeadline = new Date(
		Date.parse(params.at) - MACHINE_TOOL_CALL_ANSWER_WINDOW_MS,
	).toISOString();
	// A command may run for its whole timeout before it counts as unanswered.
	const commandDeadline = new Date(
		Date.parse(params.at) - MACHINE_COMMAND_ANSWER_WINDOW_MS,
	).toISOString();
	const fileDeadline = new Date(
		Date.parse(params.at) - MACHINE_FILE_ANSWER_WINDOW_MS,
	).toISOString();
	const unclaimed = sql`${machineToolCalls.status} = 'pending' AND ${machineToolCalls.expiresAt} <= ${params.at}`;
	const unanswered = sql`${machineToolCalls.status} = 'claimed' AND ${machineToolCalls.claimedAt} <= CASE WHEN ${machineToolCalls.tool} = 'run_command' THEN ${commandDeadline} WHEN ${machineToolCalls.tool} = 'read_file' THEN ${fileDeadline} ELSE ${answerDeadline} END`;
	return db
		.update(machineToolCalls)
		.set({
			status: sql`CASE WHEN ${machineToolCalls.status} = 'pending' THEN 'expired' ELSE 'failed' END`,
			error: sql`CASE WHEN ${machineToolCalls.status} = 'pending' THEN ${machineToolCalls.error} ELSE ${MACHINE_TOOL_CALL_TIMEOUT_ERROR} END`,
			finishedAt: params.at,
		})
		.where(
			and(
				eq(machineToolCalls.orgId, params.orgId),
				"id" in params.scope
					? eq(machineToolCalls.id, params.scope.id)
					: eq(machineToolCalls.machineName, params.scope.machineName),
				or(sql`(${unclaimed})`, sql`(${unanswered})`),
			),
		);
}

/** One call of exactly one organization, with an overdue call settled first. */
export async function readMachineToolCall(
	db: DbQueryClient,
	params: { orgId: string; id: string; at?: string },
): Promise<MachineToolCallRow | null> {
	const machineToolCalls = coreTable(db, schemaMachineToolCalls);
	const at = params.at ?? new Date().toISOString();
	const [, rows] = await db.batch([
		buildSettleOverdueStatement(db, {
			orgId: params.orgId,
			at,
			scope: { id: params.id },
		}),
		db
			.select()
			.from(machineToolCalls)
			.where(
				and(
					eq(machineToolCalls.orgId, params.orgId),
					eq(machineToolCalls.id, params.id),
				),
			)
			.limit(1),
	]);
	return rows[0] ?? null;
}

export interface ClaimMachineToolCallsParams {
	orgId: string;
	machineName: string;
	reporterId: string;
	limit: number;
	results?: {
		callId: string;
		ok: boolean;
		result?: string;
		error?: string;
	}[];
	at?: string;
}

/** A result this round trip stored, with what the change ledger needs. */
export interface StoredMachineToolCallResult {
	id: string;
	machineName: string;
	tool: MachineToolName;
	requestedByType: MachineToolCallRequesterType;
	requestedById: string;
	status: "done" | "failed";
	result: string | null;
	error: string | null;
}

export interface ClaimMachineToolCallsResult {
	/** How many of the sent results were stored. */
	stored: number;
	/** The results that were stored: only calls this reporter had claimed. */
	storedCalls: StoredMachineToolCallResult[];
	calls: MachineToolCallRow[];
}

/**
 * One runner's round trip, as a single batch: store the results of calls this
 * reporter claimed, settle the machine's overdue calls, and claim the oldest
 * waiting calls. A result for a call another reporter claimed, or one that is
 * no longer claimed, changes nothing.
 */
export async function claimMachineToolCalls(
	db: DbQueryClient,
	params: ClaimMachineToolCallsParams,
): Promise<ClaimMachineToolCallsResult> {
	const machineToolCalls = coreTable(db, schemaMachineToolCalls);
	const machineToolPolls = coreTable(db, schemaMachineToolPolls);
	const alias =
		coreStore(db) === "postgres"
			? (pgAlias as unknown as typeof sqliteAlias)
			: sqliteAlias;
	const at = params.at ?? new Date().toISOString();
	const limit = Math.min(Math.max(1, Math.trunc(params.limit)), 10);
	const machine = and(
		eq(machineToolCalls.orgId, params.orgId),
		eq(machineToolCalls.machineName, params.machineName),
	);
	const outcomes = new Map(
		(params.results ?? []).map((outcome) => [outcome.callId, outcome]),
	);
	const stores = [...outcomes.values()].map((outcome) =>
		db
			.update(machineToolCalls)
			.set({
				status: outcome.ok ? "done" : "failed",
				result:
					outcome.result === undefined
						? null
						: outcome.result.slice(0, MACHINE_TOOL_RESULT_MAX_CHARS),
				error: outcome.ok
					? null
					: (outcome.error || "The machine could not run the tool").slice(
							0,
							MACHINE_TOOL_ERROR_MAX_CHARS,
						),
				finishedAt: at,
			})
			.where(
				and(
					machine,
					eq(machineToolCalls.id, outcome.callId),
					eq(machineToolCalls.status, "claimed"),
					eq(machineToolCalls.claimedByReporterId, params.reporterId),
				),
			)
			.returning({
				id: machineToolCalls.id,
				machineName: machineToolCalls.machineName,
				tool: machineToolCalls.tool,
				requestedByType: machineToolCalls.requestedByType,
				requestedById: machineToolCalls.requestedById,
				status: machineToolCalls.status,
				result: machineToolCalls.result,
				error: machineToolCalls.error,
			}),
	);
	const next = alias(machineToolCalls, "next");
	const claim = db
		.update(machineToolCalls)
		.set({
			status: "claimed",
			claimedByReporterId: params.reporterId,
			claimedAt: at,
		})
		.where(
			and(
				machine,
				eq(machineToolCalls.status, "pending"),
				// bound-params: a subquery limited to ten rows, not a bound list
				inArray(
					machineToolCalls.id,
					db
						.select({ id: next.id })
						.from(next)
						.where(
							and(
								eq(next.orgId, params.orgId),
								eq(next.machineName, params.machineName),
								eq(next.status, "pending"),
								gt(next.expiresAt, at),
							),
						)
						.orderBy(asc(next.createdAt), asc(next.id))
						.limit(limit),
				),
			),
		)
		.returning();
	const recordPoll = db
		.insert(machineToolPolls)
		.values({
			orgId: params.orgId,
			machineName: params.machineName.toLowerCase(),
			lastPolledAt: at,
		})
		.onConflictDoUpdate({
			target: [machineToolPolls.orgId, machineToolPolls.machineName],
			set: { lastPolledAt: at },
			setWhere: lte(
				machineToolPolls.lastPolledAt,
				new Date(Date.parse(at) - 60_000).toISOString(),
			),
		});
	// Results are stored before overdue calls are settled, so an answer that
	// arrives late still beats a timeout nobody has seen yet.
	const [claimed, ...rest] = await db.batch([
		claim,
		...stores,
		buildSettleOverdueStatement(db, {
			orgId: params.orgId,
			at,
			scope: { machineName: params.machineName },
		}),
		recordPoll,
	]);
	// A store sets the status to "done" or "failed" only.
	const storedCalls = (
		rest.slice(0, stores.length) as StoredMachineToolCallResult[][]
	).flat();
	return {
		stored: storedCalls.length,
		storedCalls,
		calls: [...claimed].sort(
			(a, b) =>
				a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
		),
	};
}

/** A listed call: everything but the result, of which only the length. */
export interface ListedMachineToolCallRow {
	id: string;
	machineName: string;
	tool: MachineToolName;
	input: string;
	status: MachineToolCallRow["status"];
	requestedByType: MachineToolCallRequesterType;
	requestedById: string;
	createdAt: string;
	claimedAt: string | null;
	finishedAt: string | null;
	error: string | null;
	resultChars: number | null;
}

/**
 * Calls of exactly one organization made in `[from, until)`, ordered by
 * creation time and id, starting after the cursor when given. The result text is never
 * read, only its length.
 *
 * Listing every status lets the `(org_id, machine_name, status, created_at)`
 * index seek the time range for a named machine. Without a machine the index
 * narrows to the organization only, and its rows are filtered by time; the
 * caller bounds the range.
 */
export async function listMachineToolCallsInRange(
	db: DbQueryClient,
	params: {
		orgId: string;
		from: string;
		until: string;
		machineName?: string;
		/** Only the tools that change a workspace or run a command. */
		writesOnly: boolean;
		order: "oldest" | "newest";
		after?: { createdAt: string; id: string };
		limit: number;
	},
): Promise<ListedMachineToolCallRow[]> {
	const machineToolCalls = coreTable(db, schemaMachineToolCalls);
	const { after } = params;
	const orderBy = params.order === "newest" ? desc : asc;
	const beyondCursor = params.order === "newest" ? lt : gt;
	return db
		.select({
			id: machineToolCalls.id,
			machineName: machineToolCalls.machineName,
			tool: machineToolCalls.tool,
			input: machineToolCalls.input,
			status: machineToolCalls.status,
			requestedByType: machineToolCalls.requestedByType,
			requestedById: machineToolCalls.requestedById,
			createdAt: machineToolCalls.createdAt,
			claimedAt: machineToolCalls.claimedAt,
			finishedAt: machineToolCalls.finishedAt,
			error: machineToolCalls.error,
			resultChars: sql<number | null>`length(${machineToolCalls.result})`.as(
				"result_chars",
			),
		})
		.from(machineToolCalls)
		.where(
			and(
				eq(machineToolCalls.orgId, params.orgId),
				params.machineName === undefined
					? undefined
					: and(
							eq(machineToolCalls.machineName, params.machineName),
							inArray(machineToolCalls.status, [
								...MACHINE_TOOL_CALL_STATUS_VALUES,
							]),
						),
				gte(machineToolCalls.createdAt, params.from),
				lt(machineToolCalls.createdAt, params.until),
				params.writesOnly
					? inArray(machineToolCalls.tool, [...MACHINE_WRITE_TOOL_NAMES])
					: undefined,
				after === undefined
					? undefined
					: or(
							beyondCursor(machineToolCalls.createdAt, after.createdAt),
							and(
								eq(machineToolCalls.createdAt, after.createdAt),
								beyondCursor(machineToolCalls.id, after.id),
							),
						),
			),
		)
		.orderBy(orderBy(machineToolCalls.createdAt), orderBy(machineToolCalls.id))
		.limit(Math.min(Math.max(1, Math.trunc(params.limit)), 101));
}

import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	fstatSync,
	openSync,
	readFileSync,
	readSync,
	readdirSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, join } from "node:path";
import type {
	SupervisorActivity,
	SupervisorDutyHealth,
} from "@tedix/api-contract/schemas/dispatcher-health";
import { UUID_RE } from "./work-identity";
import {
	readDutyStatuses,
	type SupervisorDutyStatus,
} from "./supervise-duty-status";

const SOURCE_FILE = "health-source.json";
const LOG_TAIL_BYTES = 256 * 1024;
const REASON_WINDOW_MS = 30 * 60 * 1000;
const REASON_EVENTS = new Set([
	"accept-failed",
	"admission-check-deferred",
	"completion-retained",
	"failed",
	"heartbeat-failed",
	"login-blocked",
	"orphan-held",
	"settlement-retained",
	"telemetry-retained",
	"skipped",
	"skipped-or-failed",
]);

export interface DispatcherHealthSource {
	version: 1;
	workspace: string;
	organization: string;
	executor: string;
	slotsTotal: number;
	pid: number;
	startedAt: string;
	lastAdmissionAt?: string;
	preparingSlots?: number;
	nextCheckAt?: string;
	lastCompleted?: { id: string; completedAt: string };
}

export interface LocalDispatcherHealth {
	workspace: string;
	organization: string;
	reporterId: string;
	executor: string;
	lane: string;
	running: boolean;
	observedAt: string;
	lastAdmissionAt: string | null;
	slotsInUse: number;
	slotsTotal: number;
	topReason: { reason: string; count: number } | null;
	duty?: SupervisorDutyHealth;
}

function selector(scope: string[], name: string): string {
	const index = scope.indexOf(name);
	if (index < 0 || !scope[index + 1]) throw new Error(`Missing ${name}`);
	return scope[index + 1]!;
}

export function writeDispatcherHealthSource(
	directory: string,
	options: {
		scope: string[];
		executor: string;
		max: number;
	},
	pid = process.pid,
	startedAt = new Date().toISOString(),
): void {
	const path = join(directory, SOURCE_FILE);
	const previous = readSource(path);
	const source: DispatcherHealthSource = {
		version: 1,
		workspace: selector(options.scope, "--workspace"),
		organization: selector(options.scope, "--organization"),
		executor: options.executor,
		slotsTotal: options.max,
		pid,
		startedAt,
		preparingSlots: 0,
	};
	if (
		previous?.workspace === source.workspace &&
		previous.organization === source.organization &&
		previous.executor === source.executor
	) {
		source.lastAdmissionAt = previous.lastAdmissionAt;
		source.lastCompleted = previous.lastCompleted;
	}
	writeFileSync(`${path}.tmp`, JSON.stringify(source), { mode: 0o600 });
	renameSync(`${path}.tmp`, path);
}

function updateSource(
	directory: string,
	patch: Partial<DispatcherHealthSource>,
	pid: number,
) {
	const path = join(directory, SOURCE_FILE);
	const source = readSource(path);
	if (!source || source.pid !== pid) return;
	try {
		writeFileSync(`${path}.tmp`, JSON.stringify({ ...source, ...patch }), {
			mode: 0o600,
		});
		renameSync(`${path}.tmp`, path);
	} catch {
		// Reporting must not change execution or its recovery decisions.
	}
}

export function recordDispatcherNextCheck(
	directory: string,
	at: string,
	pid = process.pid,
) {
	if (Number.isFinite(Date.parse(at)))
		updateSource(directory, { nextCheckAt: at }, pid);
}

export function recordDispatcherCompletion(
	directory: string,
	id: string,
	at: string,
	pid = process.pid,
) {
	const previous = readSource(join(directory, SOURCE_FILE))?.lastCompleted;
	if (previous && Date.parse(previous.completedAt) >= Date.parse(at)) return;
	if (UUID_RE.test(id) && Number.isFinite(Date.parse(at)))
		updateSource(directory, { lastCompleted: { id, completedAt: at } }, pid);
}

function readSource(path: string): DispatcherHealthSource | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		return validSource(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

export function recordDispatcherAdmission(
	directory: string,
	at: string,
	pid = process.pid,
): void {
	const path = join(directory, SOURCE_FILE);
	const source = readSource(path);
	if (!source || source.pid !== pid || !Number.isFinite(Date.parse(at))) return;
	if (
		source.lastAdmissionAt &&
		Date.parse(source.lastAdmissionAt) >= Date.parse(at)
	)
		return;
	try {
		writeFileSync(
			`${path}.tmp`,
			JSON.stringify({ ...source, lastAdmissionAt: at }),
			{
				mode: 0o600,
			},
		);
		renameSync(`${path}.tmp`, path);
	} catch {
		// An observation failure must not interrupt an admitted worker.
	}
}

export function recordDispatcherPreparing(
	directory: string,
	count: number,
	pid = process.pid,
): void {
	const path = join(directory, SOURCE_FILE);
	const source = readSource(path);
	if (
		!source ||
		source.pid !== pid ||
		!Number.isInteger(count) ||
		count < 0 ||
		count > source.slotsTotal
	)
		return;
	try {
		writeFileSync(
			`${path}.tmp`,
			JSON.stringify({ ...source, preparingSlots: count }),
			{ mode: 0o600 },
		);
		renameSync(`${path}.tmp`, path);
	} catch {
		// Health publication must not interrupt preparation or admission.
	}
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function validSource(value: unknown): value is DispatcherHealthSource {
	if (!value || typeof value !== "object") return false;
	const row = value as Record<string, unknown>;
	return (
		row.version === 1 &&
		typeof row.workspace === "string" &&
		row.workspace.length > 0 &&
		typeof row.organization === "string" &&
		row.organization.length > 0 &&
		typeof row.executor === "string" &&
		row.executor.length > 0 &&
		Number.isSafeInteger(row.slotsTotal) &&
		Number(row.slotsTotal) > 0 &&
		Number(row.slotsTotal) <= 100 &&
		Number.isSafeInteger(row.pid) &&
		Number(row.pid) > 0 &&
		typeof row.startedAt === "string" &&
		Number.isFinite(Date.parse(row.startedAt)) &&
		(row.lastAdmissionAt === undefined ||
			(typeof row.lastAdmissionAt === "string" &&
				Number.isFinite(Date.parse(row.lastAdmissionAt)))) &&
		(row.preparingSlots === undefined ||
			(Number.isInteger(row.preparingSlots) &&
				Number(row.preparingSlots) >= 0 &&
				Number(row.preparingSlots) <= Number(row.slotsTotal)))
	);
}

function readTail(path: string): string {
	if (!existsSync(path)) return "";
	const fd = openSync(path, "r");
	try {
		const size = fstatSync(fd).size;
		const length = Math.min(size, LOG_TAIL_BYTES);
		const buffer = Buffer.alloc(length);
		readSync(fd, buffer, 0, length, size - length);
		const text = buffer.toString("utf8");
		return size > length ? text.slice(text.indexOf("\n") + 1) : text;
	} finally {
		closeSync(fd);
	}
}

function safeReason(reason: string): string {
	return reason
		.replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, "<uuid>")
		.replace(
			/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g,
			"<time>",
		)
		.replace(/(?:\/Users|\/home|\/tmp|\/var\/folders)\/[^\s,;]+/g, "<path>")
		.replace(/\b[a-z][a-z0-9._-]*:[a-z0-9._:-]{6,}\b/gi, "<session>")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 500);
}

function logHealth(directory: string, now: number) {
	let lastAdmissionAt: string | null = null;
	const reasons = new Map<string, { count: number; latest: number }>();
	for (const line of readTail(join(directory, "dispatcher.log")).split("\n")) {
		if (!line.trim()) continue;
		try {
			const row = JSON.parse(line) as Record<string, unknown>;
			const at = typeof row.at === "string" ? Date.parse(row.at) : Number.NaN;
			if (!Number.isFinite(at)) continue;
			if (
				row.event === "admitted" &&
				(!lastAdmissionAt || at > Date.parse(lastAdmissionAt))
			)
				lastAdmissionAt = row.at as string;
			if (
				typeof row.event !== "string" ||
				!REASON_EVENTS.has(row.event) ||
				typeof row.reason !== "string" ||
				now - at > REASON_WINDOW_MS
			)
				continue;
			const reason = safeReason(row.reason);
			if (!reason) continue;
			const prior = reasons.get(reason);
			reasons.set(reason, {
				count: (prior?.count ?? 0) + 1,
				latest: Math.max(prior?.latest ?? 0, at),
			});
		} catch {}
	}
	const top = [...reasons].sort(
		([aReason, a], [bReason, b]) =>
			b.count - a.count ||
			b.latest - a.latest ||
			aReason.localeCompare(bReason),
	)[0];
	return {
		lastAdmissionAt,
		topReason:
			top && top[1].count > 1 ? { reason: top[0], count: top[1].count } : null,
	};
}

function receiptActivity(
	directory: string,
	source: DispatcherHealthSource,
	now: number,
) {
	let slots = 0;
	const current: SupervisorActivity["current"] = [];
	const waiting: SupervisorActivity["waiting"] = [];
	const latest = new Map<
		string,
		{ version: number; row: Record<string, unknown> }
	>();
	for (const name of readdirSync(directory)) {
		const match = /^([0-9a-f-]{36})-(\d+)\.json$/.exec(name);
		if (!match || !UUID_RE.test(match[1]!)) continue;
		try {
			const row = JSON.parse(
				readFileSync(join(directory, name), "utf8"),
			) as Record<string, unknown>;
			const id = match[1]!,
				version = Number(match[2]);
			if (
				row &&
				typeof row === "object" &&
				(!latest.has(id) || latest.get(id)!.version < version)
			)
				latest.set(id, { version, row });
		} catch {}
	}
	for (const [id, { row }] of latest) {
		const phase = String(row.phase);
		const live = typeof row.pid !== "number" || processAlive(row.pid);
		if (["admitted", "running", "settling"].includes(phase) && live) slots++;
		if (
			(["preparing", "admitted"].includes(phase) && live) ||
			(phase === "running" && typeof row.pid === "number" && live) ||
			phase === "settling"
		) {
			current.push({
				id,
				phase:
					phase === "running"
						? "working"
						: phase === "settling"
							? "finishing"
							: "starting",
			});
		} else if (row.completionPending === true && row.outcome === "succeeded") {
			current.push({ id, phase: "finishing" });
		}
		const retry = Math.max(
			...[
				row.retryAt,
				row.runRetryAt,
				row.completionRetryAt,
				row.waitCheckAt,
			].map((v) => (typeof v === "number" && Number.isFinite(v) ? v : 0)),
		);
		const result = row.laneResult as { outcome?: string } | undefined;
		const reason =
			result?.outcome === "waiting_on_user" && !row.waitResponseId
				? "reply"
				: row.admissionState === "unknown"
					? "confirmation"
					: row.completionPending === true
						? "completion"
						: row.held === true
							? "held"
							: phase === "deferred" && retry > now
								? "retry"
								: undefined;
		if (reason)
			waiting.push({
				id,
				reason,
				retryAt: retry > now ? new Date(retry).toISOString() : null,
			});
	}
	const phases = { working: 0, starting: 1, finishing: 2 };
	current.sort((a, b) => phases[a.phase] - phases[b.phase]);
	const reasons = {
		reply: 0,
		confirmation: 1,
		completion: 2,
		retry: 3,
		held: 4,
	};
	waiting.sort((a, b) => reasons[a.reason] - reasons[b.reason]);
	const last = source.lastCompleted;
	return {
		slots,
		activity: {
			current: current.slice(0, 3),
			currentCount: Math.max(current.length, slots),
			waiting: waiting.slice(0, 3),
			nextCheckAt:
				typeof source.nextCheckAt === "string" &&
				Number.isFinite(Date.parse(source.nextCheckAt))
					? source.nextCheckAt
					: null,
			lastCompleted:
				last &&
				UUID_RE.test(last.id) &&
				Number.isFinite(Date.parse(last.completedAt))
					? last
					: null,
		} satisfies SupervisorActivity,
	};
}

export function supervisorTaskLaneId(id: string): string {
	return `task-${createHash("sha256").update(id).digest("hex").slice(0, 16)}`;
}

export function dispatcherReporterId(env: NodeJS.ProcessEnv): string {
	const root = join(
		env.TEDIX_CONFIG_DIR || join(homedir(), ".tedix"),
		"dispatchers",
	);
	return createHash("sha256")
		.update(`${hostname()}:${root}`)
		.digest("hex")
		.slice(0, 32);
}

export function supervisorDutyHealth(
	row: SupervisorDutyStatus,
	now: number,
): SupervisorDutyHealth {
	return {
		id: row.id,
		kind: row.kind,
		state: row.state,
		observedAt: row.observedAt,
		lastRunAt: row.lastRunAt,
		lastExitAt: row.lastExitAt,
		lastExitCode: row.lastExitCode,
		lastExecutor: row.lastExecutor,
		retryAt: row.retryAt,
		lastProblem: row.lastProblem,
		problemSince: row.problemSince ?? null,
		restartsLastHour: row.restarts.filter(
			(at) => at <= now && now - at < 3_600_000,
		).length,
	};
}

export function collectDispatcherHealth(
	env: NodeJS.ProcessEnv,
	now = Date.now(),
): LocalDispatcherHealth[] {
	const root = join(
		env.TEDIX_CONFIG_DIR || join(homedir(), ".tedix"),
		"dispatchers",
	);
	const reporterId = dispatcherReporterId(env);
	const observedAt = new Date(now).toISOString();
	const reports: LocalDispatcherHealth[] = [];
	const activities = new Map<string, SupervisorActivity>();
	for (const name of existsSync(root) ? readdirSync(root) : []) {
		const directory = join(root, name);
		try {
			const source = readSource(join(directory, SOURCE_FILE));
			if (!source) continue;
			const running = processAlive(source.pid);
			const log = logHealth(directory, now);
			const activity = receiptActivity(directory, source, now);
			activities.set(name, activity.activity);
			reports.push({
				workspace: source.workspace,
				organization: source.organization,
				reporterId,
				executor: source.executor,
				lane: basename(directory),
				running,
				observedAt,
				lastAdmissionAt:
					!log.lastAdmissionAt ||
					(source.lastAdmissionAt &&
						Date.parse(source.lastAdmissionAt) >
							Date.parse(log.lastAdmissionAt))
						? (source.lastAdmissionAt ?? null)
						: log.lastAdmissionAt,
				slotsInUse: running
					? Math.min(
							source.slotsTotal,
							activity.slots + (source.preparingSlots ?? 0),
						)
					: 0,
				slotsTotal: source.slotsTotal,
				topReason: log.topReason,
			});
		} catch {}
	}
	try {
		for (const row of readDutyStatuses(env)) {
			const duty = supervisorDutyHealth(row, now);
			if (row.kind === "service") {
				const report = reports.find(
					(entry) =>
						entry.lane === row.id &&
						entry.organization === row.organization &&
						entry.workspace === row.workspace,
				);
				if (report) report.duty = { ...duty, activity: activities.get(row.id) };
			} else {
				reports.push({
					workspace: row.workspace,
					organization: row.organization,
					reporterId,
					executor: row.lastExecutor ?? row.executor,
					lane: supervisorTaskLaneId(row.id),
					running: row.state === "running",
					observedAt: row.observedAt,
					lastAdmissionAt: null,
					slotsInUse: 0,
					slotsTotal: 1,
					topReason: null,
					duty,
				});
			}
		}
	} catch {
		// Missing duty history must not suppress the independent dispatcher observations.
	}
	return reports.sort(
		(a, b) =>
			a.organization.localeCompare(b.organization) ||
			a.executor.localeCompare(b.executor) ||
			a.lane.localeCompare(b.lane),
	);
}

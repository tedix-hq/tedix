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

const SOURCE_FILE = "health-source.json";
const LOG_TAIL_BYTES = 256 * 1024;
const REASON_WINDOW_MS = 30 * 60 * 1000;
const REASON_EVENTS = new Set([
	"accept-failed",
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
		previous.executor === source.executor &&
		previous.lastAdmissionAt
	)
		source.lastAdmissionAt = previous.lastAdmissionAt;
	writeFileSync(`${path}.tmp`, JSON.stringify(source), { mode: 0o600 });
	renameSync(`${path}.tmp`, path);
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
		.replace(
			/\b(?:codex|claude-code|opencode|devin):[a-z0-9._:-]+\b/gi,
			"<session>",
		)
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

function activeSlots(directory: string): number {
	let count = 0;
	for (const name of readdirSync(directory)) {
		if (!/^[0-9a-f-]{36}-\d+\.json$/.test(name)) continue;
		try {
			const row = JSON.parse(
				readFileSync(join(directory, name), "utf8"),
			) as Record<string, unknown>;
			if (!new Set(["admitted", "running", "settling"]).has(String(row.phase)))
				continue;
			if (typeof row.pid === "number" && !processAlive(row.pid)) continue;
			count++;
		} catch {}
	}
	return count;
}

export function collectDispatcherHealth(
	env: NodeJS.ProcessEnv,
	now = Date.now(),
): LocalDispatcherHealth[] {
	const root = join(
		env.TEDIX_CONFIG_DIR || join(homedir(), ".tedix"),
		"dispatchers",
	);
	if (!existsSync(root)) return [];
	const reporterId = createHash("sha256")
		.update(`${hostname()}:${root}`)
		.digest("hex")
		.slice(0, 32);
	const observedAt = new Date(now).toISOString();
	const reports: LocalDispatcherHealth[] = [];
	for (const name of readdirSync(root)) {
		const directory = join(root, name);
		try {
			const source = readSource(join(directory, SOURCE_FILE));
			if (!source) continue;
			const running = processAlive(source.pid);
			const log = logHealth(directory, now);
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
							activeSlots(directory) + (source.preparingSlots ?? 0),
						)
					: 0,
				slotsTotal: source.slotsTotal,
				topReason: log.topReason,
			});
		} catch {}
	}
	return reports.sort(
		(a, b) =>
			a.organization.localeCompare(b.organization) ||
			a.executor.localeCompare(b.executor) ||
			a.lane.localeCompare(b.lane),
	);
}

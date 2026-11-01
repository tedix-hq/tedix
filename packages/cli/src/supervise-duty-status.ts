import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { configDir } from "./supervise-drivers";

export const DUTY_STATUS_FILE = "supervisor-duties-status.json";
const timestamp = z.iso.datetime();
const dutySchema = z.object({
	id: z.string().min(1),
	kind: z.enum(["service", "task"]),
	workspace: z.string().min(1),
	organization: z.string().min(1),
	executor: z.string().min(1),
	state: z.enum(["running", "waiting", "stopped", "failed", "unknown"]),
	observedAt: timestamp,
	lastRunAt: timestamp.nullable(),
	lastExitAt: timestamp.nullable(),
	lastExitCode: z.number().int().nullable(),
	lastExecutor: z.string().nullable(),
	restarts: z.array(z.number().finite()),
	exits: z.array(z.number().finite()),
	retryAt: timestamp.nullable(),
	lastProblem: z.string().max(500).nullable(),
	problemSince: timestamp.nullable().optional(),
});
const fileSchema = z.object({
	version: z.literal(1),
	duties: z.array(dutySchema),
});
export type SupervisorDutyStatus = z.infer<typeof dutySchema>;

export function readDutyStatuses(
	env: NodeJS.ProcessEnv,
): SupervisorDutyStatus[] {
	const path = join(configDir(env), DUTY_STATUS_FILE);
	return existsSync(path)
		? fileSchema.parse(JSON.parse(readFileSync(path, "utf8"))).duties
		: [];
}

/** The supervisor is the sole writer; read/merge/write stays synchronous across its duties. */
export function recordDutyStatus(
	env: NodeJS.ProcessEnv,
	identity: Pick<
		SupervisorDutyStatus,
		"id" | "kind" | "workspace" | "organization" | "executor"
	>,
	update: Partial<Omit<SupervisorDutyStatus, keyof typeof identity>>,
	now: number,
): SupervisorDutyStatus {
	const duties = readDutyStatuses(env);
	const index = duties.findIndex((duty) => duty.id === identity.id);
	const previous = duties[index];
	const problem =
		update.lastProblem === undefined
			? previous?.lastProblem
			: update.lastProblem;
	const recent = (values: number[]) =>
		values.filter((at) => at <= now && now - at < 3_600_000).slice(-1000);
	const restarts = [...(update.restarts ?? previous?.restarts ?? [])];
	if (
		identity.kind === "service" &&
		update.lastRunAt &&
		previous?.lastRunAt &&
		update.lastRunAt > previous.lastRunAt
	)
		restarts.push(Date.parse(update.lastRunAt));
	const duty = dutySchema.parse({
		state: "unknown",
		lastRunAt: null,
		lastExitAt: null,
		lastExitCode: null,
		lastExecutor: null,
		retryAt: null,
		lastProblem: null,
		...previous,
		...identity,
		...update,
		observedAt: new Date(now).toISOString(),
		problemSince: problem
			? previous?.lastProblem
				? (previous.problemSince ?? previous.observedAt)
				: new Date(now).toISOString()
			: null,
		restarts: recent(restarts),
		exits: recent(update.exits ?? previous?.exits ?? []),
	});
	if (index < 0) duties.push(duty);
	else duties[index] = duty;
	mkdirSync(configDir(env), { recursive: true, mode: 0o700 });
	const path = join(configDir(env), DUTY_STATUS_FILE);
	writeFileSync(`${path}.tmp`, JSON.stringify({ version: 1, duties }), {
		mode: 0o600,
	});
	renameSync(`${path}.tmp`, path);
	return duty;
}

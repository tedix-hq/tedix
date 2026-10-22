import { buildTediConversationId } from "@tedix/api-contract/utils/runtime-identity";
import type { RuntimeMemoryHost } from "./runtime-memory";

export async function memoryDiagnostics(
	host: Pick<RuntimeMemoryHost, "ctx" | "state" | "compiledDirectives">,
) {
	const kv = host.ctx.storage.kv;
	let uncertainMaintenanceFires = 0;
	let startAfter: string | undefined;
	for (;;) {
		const page = await host.ctx.storage.list<{ stage: string }>({
			prefix: "tedix:pi:maintenance:fire:",
			limit: 100,
			...(startAfter ? { startAfter } : {}),
		});
		for (const [key, fire] of page) {
			startAfter = key;
			if (fire.stage === "uncertain" || fire.stage === "running")
				uncertainMaintenanceFires++;
		}
		if (page.size < 100) break;
	}

	return {
		pendingDailyEntries:
			[...kv.list({ prefix: "memory:daily:entry:" })].length +
			(host.state.pendingDailyEntries?.length ?? 0),
		lastFlushAt: kv.get<string>("memory:daily:lastFlushAt") ?? null,
		lastFlushError: kv.get<string>("memory:daily:lastFlushError") ?? null,
		compiledDirectives: host.compiledDirectives.length,
		lastDirectiveCompileAt:
			kv.get<string>("memory:lastDirectiveCompileAt") ?? null,
		uncertainMaintenanceFires,
	};
}

export async function recordMaintenanceScheduleError(
	host: Pick<RuntimeMemoryHost, "state" | "ensureIdentity" | "eventOutbox">,
	payload: Record<string, unknown>,
): Promise<void> {
	const details = {
		event: "tedi.maintenance.schedule_error",
		callback: payload.callback,
		scheduleId: payload.id ?? payload.scheduleId,
		error:
			payload.error instanceof Error
				? payload.error.message
				: String(payload.error ?? "schedule failed"),
	};
	console.warn(details);
	await host.ensureIdentity();
	if (!host.state.tediId) return;
	const runId = `maintenance:schedule-error:${crypto.randomUUID()}`;
	await host.eventOutbox.publish({
		id: `${runId}:health`,
		tediId: host.state.tediId,
		kind: "runtime.health_changed",
		conversationId: buildTediConversationId({
			tediRef: host.state.slug || host.state.tediId,
			sessionKey: "agent:main:main",
		}),
		runId,
		sequence: 790,
		payload: {
			source: "cloudflare-agents-schedule",
			phase: "maintenance_schedule_error",
			...details,
		},
		runtime: { backend: "cloudflare-agents" },
		createdAt: new Date().toISOString(),
	});
}

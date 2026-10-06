import { DurableObject } from "cloudflare:workers";
import { AgentTediDO } from "../../src/do";
/** Actual parent constructor and SDK lifecycle; product identity, provider and maintenance startup are excluded. */
function observeSql(
	ctx: DurableObjectState,
	trace: { reads: number; guarded: boolean },
): void {
	const sql = ctx.storage.sql;
	const exec = sql.exec.bind(sql);
	Object.defineProperty(sql, "exec", {
		configurable: true,
		value: (query: string, ...bindings: SqlStorageValue[]) => {
			if (
				trace.guarded &&
				/(?:FROM|JOIN)\s+(?:cf_agents_session_|assistant_)/i.test(query)
			) {
				trace.reads++;
				throw new Error(
					"Private history hydration forbidden in diagnostic fixture",
				);
			}
			return exec(query, ...bindings);
		},
	});
}
export class DiagnosticParent extends AgentTediDO {
	private readonly historyTrace: { reads: number; guarded: boolean };
	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		const trace = { reads: 0, guarded: true };
		observeSql(ctx, trace);
		super(ctx, env);
		this.historyTrace = trace;
		Object.defineProperty(this, "ensureIdentity", { value: async () => {} });
	}
	override async onStart() {
		this.ctx.storage.kv.put("fixture:started", true);
	}
	async proveReadGuard(): Promise<boolean> {
		this.historyTrace.guarded = true;
		try {
			this.ctx.storage.sql.exec("SELECT * FROM cf_agents_session_messages");
			return false;
		} catch {
			return this.historyTrace.reads === 1;
		} finally {
			this.historyTrace.guarded = false;
			this.historyTrace.reads = 0;
		}
	}

	async diagnostic() {
		this.historyTrace.reads = 0;
		this.historyTrace.guarded = true;
		const response = (
			await this.onRequest(
				new Request("https://fixture/__admin/agent-diag", {
					headers: { "X-Tedix-Admin-Token": "parent-diagnostics-token" },
				}),
			)
		).json();
		const body = await response;
		if (!body || typeof body !== "object" || Array.isArray(body))
			throw new Error("Invalid diagnostic response");
		this.historyTrace.guarded = false;
		return { ...body, privateHistoryReads: this.historyTrace.reads };
	}
}
export class DiagnosticProbe extends DurableObject {}
export default {
	fetch() {
		return new Response("parent diagnostic fixture");
	},
};

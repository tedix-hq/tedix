import { Agent } from "agents";
import { DurableObject } from "cloudflare:workers";
import { RawCutoverDO } from "../../src/pi-cutover-maintenance-do";
import {
	readStoredRuntimeAdmission,
	RuntimeAdmissionDO,
} from "../../src/runtime-admission-do";
import {
	passiveCutoverInspection,
	type PassiveCutoverInspection,
	operateStoredCutover,
} from "../../src/pi-cutover-admin";
export { RawCutoverDO } from "../../src/pi-cutover-maintenance-do";
interface FixtureEnv extends Cloudflare.Env {
	EXCLUSION_BARRIER: DurableObjectNamespace<ExclusionBarrier>;
}
export class ExclusionBarrier extends DurableObject<FixtureEnv> {
	#pending = new Map<string, () => void>();
	async wait(kind: string) {
		this.ctx.storage.kv.put(
			`entered:${kind}`,
			(this.ctx.storage.kv.get<number>(`entered:${kind}`) ?? 0) + 1,
		);
		await new Promise<void>((resolve) => {
			this.#pending.set(kind, resolve);
		});
	}
	entered(kind: string) {
		return this.ctx.storage.kv.get<number>(`entered:${kind}`) ?? 0;
	}
	release(kind: string) {
		this.#pending.get(kind)?.();
		this.#pending.delete(kind);
	}
}
export class ExclusionAgent extends Agent<
	FixtureEnv,
	{ tediId?: string; orgId?: string }
> {
	// JavaScript permits a passive return before super, as production does.
	constructor(ctx: DurableObjectState, env: FixtureEnv) {
		const local = {
			...env,
			PI_CUTOVER_KNOWN_PARENT_IDS: JSON.stringify([ctx.id.toString()]),
		};
		const admission = readStoredRuntimeAdmission(
			ctx.storage,
			ctx.id.toString(),
		);
		if (admission && admission.state !== "active")
			return new RawCutoverDO(ctx, local) as unknown as ExclusionAgent;
		super(ctx, local);
	}
	#barrier() {
		return this.env.EXCLUSION_BARRIER.get(
			this.env.EXCLUSION_BARRIER.idFromName(this.ctx.id.toString()),
		);
	}
	async onWorkflowComplete() {
		await this.#barrier().wait("callback");
		this.ctx.storage.kv.put("late:callback", true);
	}
	async onJob({ job }: import("agents/lifecycle").LifecycleJobContext) {
		if (job.fn !== "pause") return;
		await this.#barrier().wait("alarm");
		this.ctx.storage.kv.put("late:alarm", true);
	}
	async queueAlarm() {
		await this.lifecycle.jobs.push({
			id: "retained-alarm",
			fn: "pause",
			time: Date.now() + 50,
			payload: { original: "private" },
		});
	}
	async ping() {
		return "warm-sdk";
	}

	async onRequest(request: Request) {
		const ctx = this.ctx,
			original = this.env.DB;
		const db = {
			prepare(sql: string) {
				const statement = original.prepare(sql);
				return {
					bind(...values: unknown[]) {
						const bound = statement.bind(...values);
						return {
							async first<T>() {
								const row = await bound.first<T>();
								const race = ctx.storage.kv.get<string>(
									"fixture:exclusion-race",
								);
								if (race === "owner")
									ctx.storage.sql.exec(
										"UPDATE cf_agents_state SET state=? WHERE id='cf_state_row_id'",
										JSON.stringify({ tediId: "foreign", orgId: "foreign" }),
									);
								if (race === "epoch") {
									const a = readStoredRuntimeAdmission(
										ctx.storage,
										ctx.id.toString(),
									)!;
									new RuntimeAdmissionDO(ctx.storage, a.owner).gate.quarantine({
										operationId: "race",
										expectedGeneration: a.generation,
										reason: "fixture race",
									});
								}
								return row;
							},
							run: () => bound.run(),
						};
					},
				};
			},
		} as unknown as Cloudflare.Env["DB"];
		return operateStoredCutover({
			ctx,
			env: {
				...this.env,
				DB: db,
				PI_CUTOVER_KNOWN_PARENT_IDS: ctx.storage.kv.get("fixture:unselected")
					? "[]"
					: this.env.PI_CUTOVER_KNOWN_PARENT_IDS,
			},
			request,
		});
	}
	async initializeFixture(
		owner: { tediId: string; orgId: string; objectId: string },
		name: string,
	) {
		this.setState({ tediId: owner.tediId, orgId: owner.orgId });
		this.ctx.storage.kv.put("__ps_name", name);
		this.ctx.storage.kv.put("history:private", {
			text: "preserved private history",
		});
		this.ctx.storage.kv.put("budget:unknown", { amount: null });
		const admission = new RuntimeAdmissionDO(this.ctx.storage, owner);
		admission.gate.initialize({
			operationId: "initialize",
			state: "active",
			evidence: await admission.prepareEvidence("initialize"),
		});
		this.ctx.storage.sql.exec(
			"INSERT INTO cf_agents_workflows(id,workflow_id,workflow_name,status,created_at,updated_at) VALUES('local','provider-original','CHAT_TURN_WORKFLOW','running',?,?)",
			Date.now(),
			Date.now(),
		);
	}
}
export default {
	fetch() {
		return new Response("Not found", { status: 404 });
	},
};

export class ExclusionChild extends Agent<
	FixtureEnv,
	{ tediId?: string; orgId?: string }
> {
	async initializeChild(input: {
		owner: { tediId: string; orgId: string };
		rootId: string;
		name: string;
		rootName: string;
	}) {
		this.setState(input.owner);
		this.ctx.storage.kv.put("fixture:root", input.rootId);
		this.ctx.storage.kv.put("cf_agents_is_facet", true);
		this.ctx.storage.kv.put("cf_agents_facet_name", input.name);
		this.ctx.storage.kv.put("cf_agents_parent_path", [
			{ className: "AgentTediDO", name: input.rootName },
		]);
	}
	async inspectStoredCutover(input: PassiveCutoverInspection) {
		return passiveCutoverInspection(
			this.ctx,
			{
				...this.env,
				PI_CUTOVER_KNOWN_PARENT_IDS: JSON.stringify([
					this.ctx.storage.kv.get("fixture:root"),
				]),
			},
			input,
		);
	}
}

/**
 * The test Worker the conformance suite runs against: one Durable Object per
 * implementation, wired the way `apps/workspace-do` wires its object.
 */
import { DurableObject, RpcTarget } from "cloudflare:workers";
import { CloudflareWorkspaceRuntime } from "../src/cloudflare";
import type { DurableObjectWorkspaceRuntime } from "../src/durable-object-runtime";
import type { WorkspaceAlarm } from "../src/index";
import type { SandboxLoader } from "../src/sandbox";
import { WorkerdWorkspaceRuntime } from "../src/workerd";

export interface TestEnv {
	LOADER: SandboxLoader;
	CLOUDFLARE_WORKSPACE: DurableObjectNamespace<CloudflareWorkspaceObject>;
	WORKERD_WORKSPACE: DurableObjectNamespace<WorkerdWorkspaceObject>;
}

export const ADDER_BINDING = "ADDER";
const FIRED_TABLE = "workspace_runtime_test_fired";

/** A binding stub whose call has to cross the sandbox boundary to work. */
class Adder extends RpcTarget {
	add(a: number, b: number): number {
		return a + b;
	}
}

abstract class WorkspaceObject extends DurableObject<TestEnv> {
	abstract readonly runtime: DurableObjectWorkspaceRuntime;

	protected wire(runtime: DurableObjectWorkspaceRuntime): void {
		runtime.bindings.register({
			name: ADDER_BINDING,
			description: "Adds two numbers.",
			declaration:
				"interface Adder { add(a: number, b: number): Promise<number>; }",
			stub: new Adder(),
		});
		void runtime.storage.exec(
			`CREATE TABLE IF NOT EXISTS ${FIRED_TABLE} (fired_order INTEGER PRIMARY KEY AUTOINCREMENT, alarm_json TEXT NOT NULL)`,
		);
		runtime.alarms.onAlarm(async (alarm) => {
			await runtime.storage.exec(
				`INSERT INTO ${FIRED_TABLE} (alarm_json) VALUES (?)`,
				[JSON.stringify(alarm)],
			);
		});
	}

	async firedAlarms(): Promise<WorkspaceAlarm[]> {
		const rows = await this.runtime.storage.query<{ alarm_json: string }>(
			`SELECT alarm_json FROM ${FIRED_TABLE} ORDER BY fired_order ASC`,
		);
		return rows.map((row) => JSON.parse(row.alarm_json) as WorkspaceAlarm);
	}

	override fetch(request: Request): Promise<Response> {
		return this.runtime.events.connect(request);
	}

	override webSocketMessage(
		ws: WebSocket,
		message: string | ArrayBuffer,
	): Promise<void> {
		return this.runtime.events.handleMessage(ws, message);
	}

	override alarm(): Promise<void> {
		return this.runtime.alarms.dispatchDue().then(() => undefined);
	}
}

export class CloudflareWorkspaceObject extends WorkspaceObject {
	readonly runtime: CloudflareWorkspaceRuntime;

	constructor(ctx: DurableObjectState, env: TestEnv) {
		super(ctx, env);
		this.runtime = new CloudflareWorkspaceRuntime(ctx, env, {
			workspaceId: ctx.id.name ?? ctx.id.toString(),
			jurisdiction: "global",
		});
		this.wire(this.runtime);
	}
}

export class WorkerdWorkspaceObject extends WorkspaceObject {
	readonly runtime: WorkerdWorkspaceRuntime;

	constructor(ctx: DurableObjectState, env: TestEnv) {
		super(ctx, env);
		this.runtime = new WorkerdWorkspaceRuntime(ctx, env, {
			workspaceId: ctx.id.name ?? ctx.id.toString(),
		});
		this.wire(this.runtime);
	}
}

export default {
	fetch(): Response {
		return new Response("workspace-runtime test worker", { status: 200 });
	},
};

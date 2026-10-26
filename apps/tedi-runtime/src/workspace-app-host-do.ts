import { DurableObject, WorkerEntrypoint, RpcTarget } from "cloudflare:workers";
import {
	APP_SESSION_TTL_SECONDS,
	verifyWorkspaceAppSession,
} from "@tedix/auth/workspace-app-session";
import {
	AppRuntimeArgumentsSchema,
	AppRuntimeMethodSchema,
	AppRuntimeFilesSchema,
	type AppRuntimeOperation,
} from "@tedix/api-contract/schemas/os-app-runtime";
import {
	appRuntimeCodeDigest,
	appRuntimeCodeId,
	loadAppRuntimeWorker,
	appRuntimePermission,
} from "@tedix/api-contract/utils/app-runtime";
import { callRpc, serviceBindingFetch } from "@tedix/api-client/internal";
import type { JsonValue } from "@tedix/api-contract/schemas/common";

export interface WorkspaceAppHostEnv {
	LOADER: WorkerLoader;
	SECRETS_MASTER_KEY: string;
	API_SERVICE: Fetcher;
	WORKSPACE_APP_HOST: DurableObjectNamespace<WorkspaceAppHostDO>;
}
type VerifiedSession = Awaited<ReturnType<typeof verifyWorkspaceAppSession>>;
type CapabilityProps = VerifiedSession & { token: string };
interface PendingAppTrace {
	tailId: string;
	callId?: string;
	traceTokens?: string[];
	organizationId: string;
	workspaceId: string;
	gadgetId: string;
	revisionId: string;
	events: JsonValue[];
}

export class WorkspaceAppHostDO extends DurableObject<WorkspaceAppHostEnv> {
	#calls = new Map<string, Promise<unknown>>();
	#flushing: Promise<void> | undefined;
	#tailVersion = 0;
	async closeDraft(input: {
		organizationId: string;
		workspaceId: string;
		gadgetId: string;
		proposalId: string;
		baseRevisionId: string;
		merged: boolean;
	}) {
		const scope = `${input.organizationId}:${input.workspaceId}`;
		const current = this.ctx.storage.kv.get<string>("scope");
		if (current && current !== scope)
			throw new Error("Workspace host scope mismatch");
		this.ctx.storage.kv.put("scope", scope);
		const name = `app:${input.gadgetId}:draft:${input.proposalId}`;
		// Fence queued calls and retained signed sessions before deleting storage.
		this.ctx.storage.kv.put(`closed:${name}`, true);
		this.ctx.facets.delete(name);
		this.ctx.storage.kv.delete(`code:${name}`);
		if (input.merged) {
			this.ctx.storage.kv.put(
				`retired:${input.gadgetId}:${input.baseRevisionId}`,
				true,
			);
			this.ctx.facets.abort(
				`app:${input.gadgetId}`,
				new Error("App revision changed"),
			);
		}
		return { closed: true };
	}
	async recordTail(trace: PendingAppTrace) {
		if (
			this.ctx.storage.kv.get("scope") !==
			`${trace.organizationId}:${trace.workspaceId}`
		)
			throw new Error("Workspace trace scope mismatch");
		const { traceTokens, ...pending } = trace;
		if (traceTokens) {
			// Resolve only host-issued tokens; app console output cannot choose a receipt.
			const link = traceTokens
				.map((token) =>
					this.ctx.storage.kv.get<{
						callId: string;
						gadgetId: string;
						revisionId: string;
						expiresAt: number;
					}>(`app-call:${token}`),
				)
				.find(
					(entry) =>
						entry &&
						entry.gadgetId === trace.gadgetId &&
						entry.revisionId === trace.revisionId &&
						entry.expiresAt > Date.now(),
				);
			if (link) pending.callId = link.callId;
		}
		await this.ctx.storage.put(`app-tail:${trace.tailId}`, pending);
		for (const token of traceTokens ?? [])
			this.ctx.storage.kv.delete(`app-call:${token}`);
		this.#tailVersion += 1;
		await this.ctx.storage.setAlarm(Date.now() + 60000);
		this.ctx.waitUntil(this.#flushTails());
	}
	async alarm() {
		for (const [key, link] of this.ctx.storage.kv.list<{ expiresAt: number }>({
			prefix: "app-call:",
		})) {
			if (link.expiresAt <= Date.now()) this.ctx.storage.kv.delete(key);
		}
		// An alarm must read fresh rows after an in-flight delivery finishes.
		if (this.#flushing) await this.#flushing;
		await this.#flushTails();
		if ([...this.ctx.storage.kv.list({ prefix: "app-call:", limit: 1 })].length)
			await this.ctx.storage.setAlarm(Date.now() + 60000);
	}
	#flushTails(): Promise<void> {
		return (this.#flushing ??= (async () => {
			let version;
			do {
				version = this.#tailVersion;
				if (!(await this.#drainTails())) return;
			} while (version !== this.#tailVersion);
		})().finally(() => {
			this.#flushing = undefined;
		}));
	}
	async #drainTails() {
		const pending = await this.ctx.storage.list<PendingAppTrace>({
			prefix: "app-tail:",
			limit: 50,
		});
		for (const [key, trace] of pending) {
			try {
				await callRpc(["osAppRuntime", "recordTail"], trace, {
					apiUrl: "https://api",
					fetch: serviceBindingFetch(this.env.API_SERVICE),
					headers: {
						"X-Service-Binding": "true",
						"X-Tedix-Org-Id": trace.organizationId,
					},
				});
				await this.ctx.storage.delete(key);
			} catch {
				await this.ctx.storage.setAlarm(Date.now() + 60000);
				return false;
			}
		}
		if (pending.size === 50)
			await this.ctx.storage.setAlarm(Date.now() + 60000);
		return true;
	}
	/**
	 * Cut live sessions after access fell: sessions issued to these principals
	 * at or before `at` (epoch seconds) are refused from now on, and every
	 * running app restarts so no in-flight call keeps the old authority. App
	 * storage survives; only memory and open calls are dropped.
	 */
	async revokeSessions(input: {
		organizationId: string;
		workspaceId: string;
		principalIds: string[];
		at: number;
	}) {
		const scope = `${input.organizationId}:${input.workspaceId}`;
		const currentScope = this.ctx.storage.kv.get<string>("scope");
		if (currentScope && currentScope !== scope)
			throw new Error("Workspace host scope mismatch");
		// A cut older than one session lifetime can no longer match a live session.
		for (const [key, cut] of this.ctx.storage.kv.list<number>({
			prefix: "cut:",
		}))
			if (cut < input.at - APP_SESSION_TTL_SECONDS)
				this.ctx.storage.kv.delete(key);
		for (const id of input.principalIds) {
			const previous = this.ctx.storage.kv.get<number>(`cut:${id}`) ?? 0;
			this.ctx.storage.kv.put(`cut:${id}`, Math.max(previous, input.at));
		}
		let restarted = 0;
		for (const [key] of this.ctx.storage.kv.list({ prefix: "code:" })) {
			this.ctx.facets.abort(key.slice(5), new Error("App access changed"));
			this.ctx.storage.kv.delete(key);
			restarted += 1;
		}
		return { restarted };
	}
	#cutOff(session: VerifiedSession): boolean {
		const issuedAt = session.expiresAt - APP_SESSION_TTL_SECONDS;
		return [
			session.principal.id,
			session.actorUserId,
			session.shareLinkId,
		].some((id) => {
			if (!id) return false;
			const cut = this.ctx.storage.kv.get<number>(`cut:${id}`);
			return cut !== undefined && issuedAt <= cut;
		});
	}
	async call(input: {
		callId?: string;
		session: string;
		files: Record<string, string>;
		method: string;
		args: unknown[];
	}) {
		const session = await verifyWorkspaceAppSession(
			this.env.SECRETS_MASTER_KEY,
			input.session,
		);
		const key = `${session.gadgetId}:${session.previewId ?? "main"}`;
		// Retained RPC references must be revoked before another caller enters
		// the same program, including while an earlier call awaits an API reply.
		const previous = this.#calls.get(key) ?? Promise.resolve();
		const task = previous.catch(() => {}).then(() => this.#call(input));
		this.#calls.set(key, task);
		try {
			return await task;
		} finally {
			if (this.#calls.get(key) === task) this.#calls.delete(key);
		}
	}
	async #call(input: {
		callId?: string;
		session: string;
		files: Record<string, string>;
		method: string;
		args: unknown[];
	}) {
		const session = await verifyWorkspaceAppSession(
			this.env.SECRETS_MASTER_KEY,
			input.session,
		);
		if (!appRuntimePermission({ ...session, operation: "app.call" }).allowed)
			throw new Error("App interaction requires use access");
		if (this.#cutOff(session)) throw new Error("App access changed");
		const method = AppRuntimeMethodSchema.parse(input.method);
		const args = AppRuntimeArgumentsSchema.parse(input.args);
		if (
			!input.files["server.js"] ||
			Object.hasOwn(input.files, "__tedix_invocation.js") ||
			(await appRuntimeCodeDigest(AppRuntimeFilesSchema.parse(input.files))) !==
				session.codeDigest
		)
			throw new Error("App code does not match the signed revision");
		const scope = `${session.organizationId}:${session.workspaceId}`;
		const currentScope = this.ctx.storage.kv.get<string>("scope");
		if (currentScope && currentScope !== scope)
			throw new Error("Workspace host scope mismatch");
		this.ctx.storage.kv.put("scope", scope);
		if (
			!session.previewId &&
			this.ctx.storage.kv.get(
				`retired:${session.gadgetId}:${session.revisionId}`,
			)
		)
			throw new Error("App revision changed");
		const name = `app:${session.gadgetId}${session.previewId ? `:draft:${session.previewId}` : ""}`;
		if (this.ctx.storage.kv.get(`closed:${name}`))
			throw new Error("App draft closed");
		// The invocation wrapper is cached alongside user code by Worker Loader.
		const codeId = `${appRuntimeCodeId({ ...session, draftId: session.previewId })}${session.proposalId ? `:s${session.proposalSequence}` : ""}:host-v2`;
		const previous = this.ctx.storage.kv.get<string>(`code:${name}`);
		if (previous && previous !== codeId)
			this.ctx.facets.abort(name, new Error("App revision changed"));
		this.ctx.storage.kv.put(`code:${name}`, codeId);
		const facet = this.ctx.facets.get(name, () => {
			const worker = loadAppRuntimeWorker(
				this.env.LOADER,
				codeId,
				input.files,
				{
					compatibilityDate: session.compatibilityDate,
					invocation: {
						config: session.config ?? {},
						tails: [
							this.ctx.exports.WorkspaceAppTail({
								props: {
									organizationId: session.organizationId,
									workspaceId: session.workspaceId,
									gadgetId: session.gadgetId,
									revisionId: session.revisionId,
								},
							}),
						],
					},
				},
			);
			return { class: worker.getDurableObjectClass("AppInvocation") };
		});
		const capability = this.ctx.exports.WorkspaceAppCapability({
			props: { ...session, token: input.session },
		});
		const invocation =
			session.role === "use"
				? new AppReadCapability(capability)
				: new AppBuildCapability(capability);
		const traceToken = input.callId ? crypto.randomUUID() : undefined;
		if (traceToken) {
			this.ctx.storage.kv.put(`app-call:${traceToken}`, {
				callId: input.callId,
				gadgetId: session.gadgetId,
				revisionId: session.revisionId,
				expiresAt: Date.now() + 3_600_000,
			});
			await this.ctx.storage.setAlarm(Date.now() + 60000);
		}
		try {
			return await (
				facet as unknown as {
					invoke(
						method: string,
						args: unknown[],
						capability: unknown,
						traceToken?: string,
						console?: AppConsole,
					): Promise<unknown>;
				}
			).invoke(
				method,
				args,
				invocation,
				traceToken,
				input.callId
					? new AppConsole(async (level, message, timestamp, sequence) => {
							await this.recordTail({
								organizationId: session.organizationId,
								workspaceId: session.workspaceId,
								gadgetId: session.gadgetId,
								revisionId: session.revisionId,
								tailId: crypto.randomUUID(),
								callId: input.callId,
								events: [
									{
										outcome: "ok",
										live: true,
										timestamp,
										sequence,
										logs: [{ level, message, timestamp }],
										exceptions: [],
									},
								],
							});
						})
					: undefined,
			);
		} finally {
			invocation.close();
		}
	}
}

class AppConsole extends RpcTarget {
	#write: (
		level: string,
		message: string,
		timestamp: number,
		sequence: number,
	) => Promise<void>;
	constructor(
		write: (
			level: string,
			message: string,
			timestamp: number,
			sequence: number,
		) => Promise<void>,
	) {
		super();
		this.#write = write;
	}
	write(level: string, message: string, timestamp: number, sequence: number) {
		return this.#write(level, message, timestamp, sequence);
	}
}

class AppReadCapability extends RpcTarget {
	#active = true;
	#endpoint: Service<WorkspaceAppCapability>;
	constructor(endpoint: Service<WorkspaceAppCapability>) {
		super();
		this.#endpoint = endpoint;
	}
	protected assertActive() {
		if (!this.#active) throw new Error("App capability expired");
	}
	close() {
		this.#active = false;
	}
	outputsRead(slot: string, args: unknown) {
		this.assertActive();
		return this.#endpoint.outputsRead(slot, args);
	}
}
class AppBuildCapability extends AppReadCapability {
	#endpoint: Service<WorkspaceAppCapability>;
	constructor(endpoint: Service<WorkspaceAppCapability>) {
		super(endpoint);
		this.#endpoint = endpoint;
	}
	outputsPatch(slot: string, args: unknown) {
		this.assertActive();
		return this.#endpoint.outputsPatch(slot, args);
	}
	outputsWrite(slot: string, args: unknown) {
		this.assertActive();
		return this.#endpoint.outputsWrite(slot, args);
	}
	skillsRun(slot: string, args: unknown) {
		this.assertActive();
		return this.#endpoint.skillsRun(slot, args);
	}
	connectionsCall(slot: string, args: unknown) {
		this.assertActive();
		return this.#endpoint.connectionsCall(slot, args);
	}
}

export class WorkspaceAppCapability extends WorkerEntrypoint<
	WorkspaceAppHostEnv,
	CapabilityProps
> {
	async outputsRead(slot: string, args: unknown) {
		return this.#invoke("outputs.read", slot, args);
	}
	async outputsPatch(slot: string, args: unknown) {
		return this.#invoke("outputs.patch", slot, args);
	}
	async outputsWrite(slot: string, args: unknown) {
		return this.#invoke("outputs.write", slot, args);
	}
	async skillsRun(slot: string, args: unknown) {
		return this.#invoke("skills.run", slot, args);
	}
	async connectionsCall(slot: string, args: unknown) {
		return this.#invoke("connections.call", slot, args);
	}
	async #invoke(operation: AppRuntimeOperation, slot: string, args: unknown) {
		const props = this.ctx.props;
		if (
			Date.now() >= props.expiresAt * 1000 ||
			!appRuntimePermission({ ...props, operation, slot }).allowed
		)
			throw new Error("App capability denied");
		return callRpc(
			["osAppRuntime", "capability"],
			{ session: props.token, operation, slot, args },
			{
				apiUrl: "https://api",
				fetch: serviceBindingFetch(this.env.API_SERVICE),
				headers: {
					"X-Service-Binding": "true",
					"X-Tedix-Org-Id": props.organizationId,
				},
			},
		);
	}
}

export class WorkspaceAppTail extends WorkerEntrypoint<
	WorkspaceAppHostEnv,
	{
		organizationId: string;
		workspaceId: string;
		gadgetId: string;
		revisionId: string;
	}
> {
	async tail(events: TraceItem[]) {
		const host = this.env.WORKSPACE_APP_HOST.getByName(
			`${this.ctx.props.organizationId}:${this.ctx.props.workspaceId}`,
		);
		for (const event of events)
			await host.recordTail({
				...this.ctx.props,
				tailId: crypto.randomUUID(),
				traceTokens: event.logs
					.filter(
						(log) =>
							log.message[0] === "__tedix_app_trace__" &&
							typeof log.message[1] === "string",
					)
					.map((log) => log.message[1] as string),
				events: [
					{
						outcome: event.outcome,
						timestamp: event.eventTimestamp,
						truncated:
							event.truncated ||
							event.logs.length > 201 ||
							event.exceptions.length > 5,
						logs: event.logs
							.filter((log) => log.message[0] !== "__tedix_app_trace__")
							.slice(0, 200)
							.map((log) => ({
								level: log.level,
								timestamp: log.timestamp,
								message: JSON.stringify(log.message).slice(0, 2000),
							})),
						exceptions: event.exceptions.slice(0, 5).map((exception) => ({
							name: exception.name,
							message: exception.message.slice(0, 2000),
						})),
					},
				],
			});
	}
}

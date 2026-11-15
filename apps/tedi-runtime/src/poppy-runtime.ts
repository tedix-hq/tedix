import { PoppyRuntimeRequestSchema } from "@tedix/api-contract/schemas/personal-agent-conversation";
import { wrapUntrustedInput } from "@tedix/chat-transport/untrusted-input";
import { PoppyConversations, type PoppyJob } from "./poppy-conversations";

export async function handlePoppyRuntime(
	request: Request,
	host: {
		organizationId: string;
		store: PoppyConversations;
		kick: () => Promise<void>;
	},
) {
	const parsed = PoppyRuntimeRequestSchema.safeParse(
		await request.json().catch(() => null),
	);
	if (!parsed.success)
		return Response.json({ error: "invalid_request" }, { status: 400 });
	const p = parsed.data;
	if (p.organizationId !== host.organizationId)
		return Response.json({ error: "conversation_not_found" }, { status: 404 });
	const identity = { ...p.identity, organizationId: p.organizationId };
	if (p.deskReply)
		host.store.humanReply(
			identity,
			p.deskReply.conversationId,
			p.deskReply.interactionId,
			p.deskReply.text,
		);
	let receipt =
		p.method === "GET"
			? host.store.read(identity, p.path.split("/")[0]!, p.cursor)
			: host.store.request(
					identity,
					p.method,
					p.path,
					p.body,
					p.publicInstructions,
				);
	if (receipt.httpStatus >= 400) return Response.json({ receipt, desks: [] });
	const conversationId = (receipt.body as { conversation_id: string })
		.conversation_id;
	await host.kick();
	if (p.includeEvents) {
		const until = Date.now() + p.wait * 1000;
		for (;;) {
			const read = host.store.read(identity, conversationId, p.cursor);
			if (read.httpStatus >= 400) {
				receipt = read;
				break;
			}
			const body = read.body as { events: unknown[]; working: boolean };
			if (body.events.length || !body.working || Date.now() >= until) {
				receipt = { ...read, httpStatus: receipt.httpStatus };
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	return Response.json({
		receipt,
		desks: host.store.desks(identity, conversationId),
	});
}

/** Public context is the only system material; tools and organization memory are absent. */
export function poppyTurn(job: PoppyJob) {
	return {
		sessionKey: `poppy_${job.conversation}`,
		runId: `poppy_${job.conversation}_${job.id}`,
		durableSubmissionId: `poppy_${job.conversation}_${job.id}`,
		system: `You are this organization's public Company Agent. Answer signed-out visitors using only the public information below. You have no account access or tools. Never claim to have read internal records or taken an action.\n\n${job.publicInstructions}`,
		guardedUserText: wrapUntrustedInput(
			JSON.stringify({ context: job.context, events: job.history }),
			"poppy-conversation",
		),
		userTs: job.acceptedAt,
		maxSteps: 1,
		tools: {},
		surface: "mcp" as const,
		source: "poppy",
		freshHistory: true,
	};
}

/** Durable queue callbacks are isolated per conversation; reads only redrive unqueued work. */
export class PoppyRuntime {
	private readonly scheduled = new Set<string>();
	private readonly active = new Map<string, Promise<void>>();
	constructor(
		private readonly host: {
			storage: DurableObjectStorage;
			organizationId: () => string;
			queue: (conversationId: string) => Promise<unknown>;
			run: (
				turn: ReturnType<typeof poppyTurn>,
			) => Promise<{ assistantText: string; turnError: string | null }>;
		},
	) {}
	private store() {
		return new PoppyConversations(this.host.storage.sql, (operation) =>
			this.host.storage.transactionSync(operation),
		);
	}
	async kick() {
		for (const conversationId of this.store().pendingConversations()) {
			if (this.scheduled.has(conversationId)) continue;
			this.scheduled.add(conversationId);
			try {
				await this.host.queue(conversationId);
			} catch (error) {
				this.scheduled.delete(conversationId);
				throw error;
			}
		}
	}
	async recover() {
		if (
			this.host.storage.sql
				.exec("SELECT name FROM sqlite_master WHERE name='poppy_requests'")
				.toArray().length
		)
			await this.kick();
	}
	handle(request: Request) {
		return handlePoppyRuntime(request, {
			organizationId: this.host.organizationId(),
			store: this.store(),
			kick: () => this.kick(),
		});
	}
	async drain(conversationId: string): Promise<void> {
		const existing = this.active.get(conversationId);
		if (existing) return existing;
		const run = async () => {
			const store = this.store();
			for (
				let job = store.nextJob(conversationId);
				job;
				job = store.nextJob(conversationId)
			) {
				const result = await this.host.run(poppyTurn(job));
				if (result.turnError) throw new Error("Company Agent turn unavailable");
				store.finish(job, result.assistantText);
			}
		};
		const pending = run();
		this.active.set(conversationId, pending);
		try {
			await pending;
		} finally {
			this.active.delete(conversationId);
			this.scheduled.delete(conversationId);
		}
	}
}

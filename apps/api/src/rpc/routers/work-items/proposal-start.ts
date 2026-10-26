/**
 * Start an accepted Work proposal according to its kind: delegate the new
 * Work to a tedi through Home, plan a factory for the member to switch on, or
 * draft a document. Every path reuses an existing procedure; a deterministic
 * Work Item comment latches the start, so a retried or concurrent accept
 * never starts anything twice.
 */
import { safeExceptionTopology } from "../../../lib/safe-log-metadata";
import type { ProposalStart } from "@tedix/api-contract/schemas/work-interactions";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { call } from "@orpc/server";
import { getTedisByOrganization } from "@tedix/db/queries/tedis";
import {
	addWorkItemCommentIfAbsent,
	getWorkItemCommentById,
} from "@tedix/db/queries/work-items/comments";
import {
	acceptWorkItem,
	getWorkItemById,
} from "@tedix/db/queries/work-items/crud";
import type { BaseContext } from "../../orpc";

export type ProposalStartReceipt = {
	kind: ProposalStart["kind"];
	status: "started" | "planned" | "drafted" | "failed";
	/** One line for the inbox and chat. */
	summary: string;
	/** Path in Tedix OS, e.g. /work/items/<id>. */
	link: string;
	workItemId: string;
	tediId?: string;
	tediName?: string;
	homeRunId?: string;
	runStatus?: string;
	outputId?: string;
	command?: string;
	error?: string;
};

type Tedi = { id: string; name: string };
type WorkActor = Parameters<typeof acceptWorkItem>[1]["actor"];

/** The procedures a start reuses; tests replace them. */
export type ProposalStartActions = {
	delegate(
		context: BaseContext,
		input: {
			content: string;
			tediId: string;
			idempotencyKey: string;
			workItemId: string;
		},
	): Promise<{ runId: string; status: string; error?: string }>;
	planFactory(
		context: BaseContext,
		input: { goal: string; name?: string; ownerTedi: string },
	): Promise<{ name: string; slug: string; cron: string; status: string }>;
	createDocument(
		context: BaseContext,
		input: {
			title: string;
			workspaceId?: string;
			blocks: Array<
				| { type: "heading"; level: number; text: string }
				| { type: "paragraph"; text: string }
			>;
		},
	): Promise<{ outputId: string }>;
};

const defaultActions: ProposalStartActions = {
	async delegate(context, input) {
		const { enqueueMessageRoute } =
			await import("../kernel-runtime/execution-proposals");
		const result = await call(
			enqueueMessageRoute,
			{
				content: input.content,
				delegateToTediId: input.tediId,
				idempotencyKey: input.idempotencyKey,
				executionPolicy: "normal",
				metadata: {
					workItemId: input.workItemId,
					source: "workProposal.accepted",
				},
			},
			{ context },
		);
		return {
			runId: result.run.id,
			status: result.status,
			...(result.error ? { error: result.error } : {}),
		};
	},
	async planFactory(context, input) {
		const { createFactoryProcedure } = await import("../project-factories");
		const result = await call(
			createFactoryProcedure,
			{
				goal: input.goal,
				...(input.name ? { name: input.name } : {}),
				ownerTedi: input.ownerTedi,
				cadence: "daily",
				template: "report",
				maxProposals: 3,
				dryRun: true,
			},
			{ context },
		);
		return {
			name: result.name,
			slug: result.slug,
			cron: result.cron,
			status: result.status,
		};
	},
	async createDocument(context, input) {
		const { osOutputProcedures } = await import("../os-workspace-outputs");
		const result = await call(
			osOutputProcedures.create,
			{
				kind: "document",
				title: input.title,
				...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
				content: { kind: "document", blocks: input.blocks },
				note: "Drafted when you accepted a Tedix proposal.",
			},
			{ context },
		);
		return { outputId: result.output.id };
	},
};

let activeActions = defaultActions;

export const proposalStartTestHooks = {
	use(actions: ProposalStartActions) {
		activeActions = actions;
	},
	reset() {
		activeActions = defaultActions;
	},
};

/** A UUID derived from a seed, so a retried start reuses its Home run. */
async function seededUuid(seed: string): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)),
	);
	digest[6] = (digest[6]! & 0x0f) | 0x80;
	digest[8] = (digest[8]! & 0x3f) | 0x80;
	const hex = [...digest.slice(0, 16)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** The named tedi (id, slug or name), else the organization's default. */
export async function proposalTedi(
	context: BaseContext,
	orgId: string,
	wanted: string | undefined,
): Promise<Tedi | null> {
	const { defaultFactoryOwner } =
		await import("../../../services/factory-builder");
	const candidates = (await getTedisByOrganization(context.db, orgId)).map(
		(tedi) => ({
			id: tedi.id,
			slug: tedi.slug,
			name: tedi.name,
			displayName: tedi.displayName,
			createdAt: tedi.createdAt,
			operator:
				tedi.mcpCapabilityProfile === "org_admin" ||
				tedi.mcpCapabilityProfile === "platform_admin",
		}),
	);
	const key = wanted?.trim().toLowerCase();
	const named = key
		? candidates.find(
				(t) =>
					t.id.toLowerCase() === key ||
					t.slug.toLowerCase() === key ||
					t.name.toLowerCase() === key ||
					(t.displayName ?? "").toLowerCase() === key,
			)
		: undefined;
	const pick = named ?? defaultFactoryOwner(candidates);
	return pick ? { id: pick.id, name: pick.displayName || pick.name } : null;
}

const quote = (text: string) => `"${text.replace(/["\\]/g, "\\$&")}"`;

function osLink(context: BaseContext, path: string): string {
	const base = (context.env as { OS_URL?: string }).OS_URL;
	return base && /^https?:\/\//.test(base)
		? `${base.replace(/\/+$/, "")}${path}`
		: path;
}

async function run(
	context: BaseContext,
	input: {
		orgId: string;
		workItem: { id: string; title: string };
		start: ProposalStart;
		responder: WorkActor;
	},
): Promise<ProposalStartReceipt> {
	const { orgId, workItem, start } = input;
	const itemLink = `/work/items/${workItem.id}`;
	const base = { kind: start.kind, workItemId: workItem.id };
	if (start.kind === "delegate") {
		const tedi = await proposalTedi(context, orgId, start.tedi);
		if (!tedi)
			throw new Error("this organization has no tedi to hand the work to");
		// A delegated attempt needs accepted Work; the member just accepted it.
		const current = await getWorkItemById(context.db, workItem.id, orgId);
		if (current?.disposition === "proposed")
			await acceptWorkItem(context.db, {
				orgId,
				workItemId: workItem.id,
				acceptanceContract: {
					version: 1,
					doneLooksLike: `${tedi.name} finished "${workItem.title}" and settled its attempt with evidence of the result.`,
				},
				actor: input.responder,
				acceptedAt: new Date().toISOString(),
			});
		const result = await activeActions.delegate(context, {
			content: [
				start.brief,
				"",
				`This is Work Item "${workItem.title}" (${workItem.id}); the member accepted it from their Tedix inbox. Do the first step now, then settle the attempt with what you did and the evidence.`,
			].join("\n"),
			tediId: tedi.id,
			idempotencyKey: await seededUuid(`work-proposal-start:${workItem.id}`),
			workItemId: workItem.id,
		});
		const waiting = result.status === "requires_approval";
		const failed = result.status === "failed";
		return {
			...base,
			status: failed ? "failed" : "started",
			summary: failed
				? `Created "${workItem.title}", but handing it to ${tedi.name} failed: ${result.error ?? "no reason given"}.`
				: waiting
					? `Created "${workItem.title}" and asked ${tedi.name} to start; Home is waiting for your approval.`
					: `Started: ${tedi.name} is working on "${workItem.title}".`,
			link: itemLink,
			tediId: tedi.id,
			tediName: tedi.name,
			homeRunId: result.runId,
			runStatus: result.status,
			...(result.error ? { error: result.error } : {}),
		};
	}
	if (start.kind === "factory") {
		const tedi = await proposalTedi(context, orgId, undefined);
		const plan = await activeActions.planFactory(context, {
			goal: start.brief,
			...(start.name ? { name: start.name } : {}),
			ownerTedi: tedi?.id ?? "default",
		});
		const command = `tedix factory create --goal ${quote(start.brief)} --name ${quote(plan.name)}`;
		return {
			...base,
			status: "planned",
			summary: `Planned the factory "${plan.name}" (${plan.cron}); nothing runs until you switch it on with: ${command}`,
			link: itemLink,
			command,
			...(tedi ? { tediId: tedi.id, tediName: tedi.name } : {}),
		};
	}
	const made = await activeActions.createDocument(context, {
		title: workItem.title.slice(0, 120),
		...(start.workspaceId ? { workspaceId: start.workspaceId } : {}),
		blocks: [
			{ type: "heading", level: 1, text: workItem.title.slice(0, 200) },
			{ type: "paragraph", text: `Draft. ${start.brief}` },
			{ type: "heading", level: 2, text: "Notes" },
			{
				type: "paragraph",
				text: `Tracked as Work Item ${workItem.id}. Ask Tedix in chat to fill in a section.`,
			},
		],
	});
	return {
		...base,
		status: "drafted",
		summary: `Drafted "${workItem.title}" in your Tedix workspace.`,
		link: `/outputs/${made.outputId}`,
		outputId: made.outputId,
	};
}

/**
 * Start the proposal's first step for its first Work Item. Fail-soft: the
 * Work exists and the accept stands; a failure is the receipt.
 */
export async function startAcceptedProposal(
	context: BaseContext,
	input: {
		orgId: string;
		workItemId: string;
		start: ProposalStart;
		responder: WorkActor;
	},
): Promise<ProposalStartReceipt> {
	const now = () => new Date().toISOString();
	const latchId = `${input.workItemId}:proposal-start`;
	const doneId = `${input.workItemId}:proposal-started`;
	const workItem = await getWorkItemById(
		context.db,
		input.workItemId,
		input.orgId,
	);
	const title = workItem?.title ?? "the proposed work";
	const latch = await addWorkItemCommentIfAbsent(context.db, {
		id: latchId,
		workItemId: input.workItemId,
		orgId: input.orgId,
		authorType: "system",
		authorId: "work-proposal",
		body: `Starting the accepted proposal (${input.start.kind}).`,
		metadata: { source: "workProposal.accepted", kind: input.start.kind },
		createdAt: now(),
	});
	if (!latch.inserted) {
		const done = await getWorkItemCommentById(context.db, doneId);
		const prior = done?.metadata?.receipt as ProposalStartReceipt | undefined;
		if (prior) return prior;
		return {
			kind: input.start.kind,
			status: "started",
			summary: `"${title}" was already started.`,
			link: osLink(context, `/work/items/${input.workItemId}`),
			workItemId: input.workItemId,
		};
	}
	let receipt: ProposalStartReceipt;
	try {
		receipt = await run(context, {
			orgId: input.orgId,
			workItem: { id: input.workItemId, title },
			start: input.start,
			responder: input.responder,
		});
	} catch (error) {
		const message = (error instanceof Error ? error.message : String(error))
			.replace(/\s+/g, " ")
			.slice(0, 300);
		receipt = {
			kind: input.start.kind,
			status: "failed",
			summary: `Created "${title}", but starting it failed: ${message}. Ask Tedix in chat to start it.`,
			link: `/work/items/${input.workItemId}`,
			workItemId: input.workItemId,
			error: message,
		};
	}
	receipt = { ...receipt, link: osLink(context, receipt.link) };
	await addWorkItemCommentIfAbsent(context.db, {
		id: doneId,
		workItemId: input.workItemId,
		orgId: input.orgId,
		authorType: "system",
		authorId: "work-proposal",
		body: `${receipt.summary} ${receipt.link}`,
		metadata: {
			source: "workProposal.accepted",
			receipt: receipt as unknown as JsonValue,
		},
		createdAt: now(),
	}).catch((error: unknown) =>
		console.warn("[work-proposal] start receipt not recorded", {
			workItemId: input.workItemId,
			exception: safeExceptionTopology(error),
		}),
	);
	return receipt;
}

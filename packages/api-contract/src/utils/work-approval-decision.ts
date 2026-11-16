export interface WorkApprovalDecisionCopy {
	/** The question: the action and the task it is for. */
	title: string;
	/** The request in one or two plain sentences. */
	what: string;
	/** One sentence each. */
	ifApproved: string;
	ifRejected: string;
	/** Set only when the request's own data argues for an answer. */
	recommendation: { decision: "rejected"; reason: string } | null;
}

const text = (value: unknown) =>
	typeof value === "string" && value.trim() ? value.trim() : null;

function clip(value: string, max: number) {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * A task approval as a person reads it: what is asked, for which task, and
 * what Approve and Reject each do. The stored proposal stays the authority;
 * this only describes it.
 */
export function workApprovalDecision(input: {
	action: string;
	proposal: Record<string, unknown>;
	taskTitle: string;
	/** The task version the request was made for, and the task's version now. */
	proposalTaskVersion?: number;
	taskVersion?: number;
	taskDisposition?: string;
}): WorkApprovalDecisionCopy {
	const task = `"${clip(input.taskTitle || "this task", 60)}"`;
	const recommendation =
		input.taskDisposition === "completed" ||
		input.taskDisposition === "cancelled"
			? {
					decision: "rejected" as const,
					reason: "The task is already closed.",
				}
			: input.taskVersion !== undefined &&
				  input.proposalTaskVersion !== undefined &&
				  input.taskVersion !== input.proposalTaskVersion
				? {
						decision: "rejected" as const,
						reason:
							"The task changed after this was requested, so the request no longer matches it.",
					}
				: null;
	const proposal = input.proposal ?? {};
	if (input.action === "admission")
		return {
			title: `Let work start on ${task}?`,
			what: `Allow work to start on ${task} as the task is written now.`,
			ifApproved:
				"Work on this task may start, as long as the task stays as it is written now.",
			ifRejected: "The task does not start and the requester sees your reason.",
			recommendation,
		};
	if (input.action === "acceptance") {
		const contract = proposal.acceptanceContract;
		const done =
			contract && typeof contract === "object" && "doneLooksLike" in contract
				? text(contract.doneLooksLike)
				: null;
		return {
			title: `Accept the task ${task}?`,
			what: `Accept ${task} as agreed work.${done ? ` Done means: ${clip(done, 200)}` : ""}`,
			ifApproved:
				"The task moves from proposed to accepted, with the definition of done in this request.",
			ifRejected: "The task stays proposed and the requester sees your reason.",
			recommendation,
		};
	}
	if (input.action === "agent.create") {
		const tedi = text(proposal.kind) === "tedi";
		const name = text(tedi ? proposal.name : proposal.displayName);
		const thing = `the ${tedi ? "tedi" : "agent"}${name ? ` "${clip(name, 40)}"` : ""}`;
		return {
			title: `${tedi ? "Create" : "Register"} ${thing} for ${task}?`,
			what: `${tedi ? "Create" : "Register"} ${thing}, with the owner and data level in this request.`,
			ifApproved: `Tedix ${tedi ? "creates" : "registers"} ${thing} once, exactly as requested.`,
			ifRejected: `Tedix does not ${tedi ? "create" : "register"} it and the requester sees your reason.`,
			recommendation,
		};
	}
	if (input.action === "agent.connect") {
		const label = text(proposal.label);
		const provider = text(proposal.providerId);
		const thing = `the connection${label ? ` "${clip(label, 40)}"` : ""}`;
		return {
			title: `Set up ${thing} for ${task}?`,
			what: `Set up ${thing}${provider ? ` to ${clip(provider, 40)}` : ""}, with the owner and data level in this request.`,
			ifApproved: `Tedix sets up ${thing} once, exactly as requested.`,
			ifRejected:
				"Tedix does not set up the connection and the requester sees your reason.",
			recommendation,
		};
	}
	if (input.action === "resource.grant") {
		const provider = text(proposal.providerId);
		const thing = provider
			? `the ${clip(provider, 40)} connection`
			: "a connection";
		return {
			title: `Give access to ${thing} for ${task}?`,
			what: `Give the agents named in this request access to ${thing}, within the limits it lists.`,
			ifApproved: `Tedix gives that access to ${thing} once, exactly as requested.`,
			ifRejected: "No access is given and the requester sees your reason.",
			recommendation,
		};
	}
	const action = clip(
		(input.action || "this request").replace(/[_.]+/g, " "),
		40,
	);
	return {
		title: `Approve "${action}" for ${task}?`,
		what: `Approve "${action}" for ${task}. Tedix cannot describe this request further; read the technical details.`,
		ifApproved:
			"The requester may do this once, exactly as the request is written.",
		ifRejected: "Nothing changes and the requester sees your reason.",
		recommendation,
	};
}

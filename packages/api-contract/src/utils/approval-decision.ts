export interface ApprovalDecision {
	what: string;
	whyNow: string;
	ifApproved: string;
	ifRejected: string;
	recommendation: "approved" | "rejected";
	reason: string;
}

/** Unknown actions keep their technical request visible without inventing consequences. */
export function approvalDecision(input: {
	actionType: string;
	review: { intent: string };
	/** The classified risk of a parked Home write; absent for other requests. */
	riskTier?: string | null;
}): ApprovalDecision {
	if (input.review.intent === "home_write") {
		const low = input.riskTier === "low";
		return {
			what: "Let Home make the change shown above.",
			whyNow: "Home is paused until this change is decided or expires.",
			ifApproved: "The change runs once with the exact details shown.",
			ifRejected: "Nothing changes.",
			recommendation: low ? "approved" : "rejected",
			reason: low
				? "Low-risk change inside Tedix; check the target and new value, then approve."
				: "Confirm the target and change in the details before allowing it.",
		};
	}
	const catalog: Record<string, Omit<ApprovalDecision, "whyNow">> = {
		home_request: {
			what: "Decide whether Home should continue its saved request.",
			ifApproved:
				"Home continues the saved action, work order or plan shown in the details.",
			ifRejected: "Home cancels this pending request without starting it.",
			recommendation: "rejected",
			reason:
				"Review the saved scope and effects before starting work or making a change.",
		},
		tool_write: {
			what: "Let the tedi carry out its saved change.",
			ifApproved:
				"The saved action runs once with the exact details shown below.",
			ifRejected: "The saved action is cancelled without running.",
			recommendation: "rejected",
			reason:
				"Confirm the target and change in the details before allowing a write.",
		},
		browser_takeover: {
			what: "Complete a sign-in or consent step in the tedi's browser.",
			ifApproved: "The tedi continues in that browser session.",
			ifRejected: "The tedi stops waiting for this browser step.",
			recommendation: "rejected",
			reason:
				"Sign-in and consent need your presence before the tedi continues.",
		},
		workstation_attach: {
			what: "Start work in the selected development environment.",
			ifApproved: "The selected environment is attached and work can start.",
			ifRejected: "The environment is not attached.",
			recommendation: "rejected",
			reason: "Review the environment and scope before starting work.",
		},
	};
	return {
		...(catalog[input.review.intent] ?? {
			what: "Allow the action described in the technical details.",
			ifApproved: "The requesting worker receives permission for this action.",
			ifRejected: "The requesting worker does not receive permission.",
			recommendation: "rejected" as const,
			reason:
				"This action has no verified description of its effects; ask the owner to clarify it.",
		}),
		whyNow: "The tedi is paused until this request is decided or expires.",
	};
}

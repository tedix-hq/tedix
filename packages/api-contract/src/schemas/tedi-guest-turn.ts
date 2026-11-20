import * as z from "zod";
import { JsonValueSchema } from "./common";

/**
 * What a workspace chat service sends to a tedi's own object when that tedi
 * answers one message as a guest, and what it gets back. Three calls sit next
 * to `guestProfile`: `guestToolCatalog`, `guestToolRun` and `guestTurnLearn`.
 * None of them throws for a refusal; each returns a reason the chat can show.
 */

/** Who sent the message and where. Every guest call carries it. */
export const GuestTurnScopeSchema = z.object({
	tediId: z.string().min(1),
	organizationId: z.string().min(1),
	/**
	 * `trusted` only when a signed-in person who is allowed to pick this tedi
	 * sent the message. A scheduled, share-link, app-triggered or embedded
	 * turn is `untrusted`: it gets no tools and is never learned from.
	 */
	trust: z.enum(["trusted", "untrusted"]),
	/** The signed-in sender. Required on a trusted turn. */
	senderUserId: z.string().min(1).nullable(),
	/** The owner of a personal tedi; null for an organization tedi. */
	tediOwnerUserId: z.string().min(1).nullable(),
	workspaceId: z.string().min(1),
	conversationId: z.string().min(1),
	/** True when anyone other than the sender can open the workspace. */
	othersCanOpen: z.boolean(),
});
export type GuestTurnScope = z.infer<typeof GuestTurnScopeSchema>;

export const GuestToolCatalogInputSchema = GuestTurnScopeSchema.extend({
	/** Search the tedi's connected tools; returns up to ten one-line rows. */
	query: z.string().min(1).max(200).optional(),
	/** One exact `namespace.tool` name; returns that tool with its input schema. */
	describe: z.string().min(1).max(200).optional(),
});
export type GuestToolCatalogInput = z.infer<typeof GuestToolCatalogInputSchema>;

export interface GuestToolRow {
	/** Pass this as `tool` to `guestToolRun`. */
	name: string;
	description: string;
	readOnly?: boolean;
	destructive?: boolean;
	/** Only on a `describe` answer. */
	inputSchema?: unknown;
}

export interface GuestToolCatalog {
	/** Read one with `guestToolRun({ tool: "read_skill", args: { slug } })`. */
	skills: Array<{ slug: string; title: string; summary: string }>;
	/** The tedi's connected tool groups; search one with `query`. */
	namespaces: Array<{ name: string; tools: number }>;
	/** Rows for a `query` or `describe` call; empty otherwise. */
	tools: GuestToolRow[];
	/** One sentence saying what was held back, when something was. */
	refusal?: string;
}

/** The name `guestToolRun` uses for reading one of the tedi's skills. */
export const GUEST_READ_SKILL_TOOL = "read_skill";

export const GuestToolRunInputSchema = GuestTurnScopeSchema.extend({
	/** `read_skill`, or one `namespace.tool` name from the catalog. */
	tool: z.string().min(1).max(200),
	args: z.record(z.string(), JsonValueSchema).default({}),
});
export type GuestToolRunInput = z.input<typeof GuestToolRunInputSchema>;

export type GuestToolRunResult =
	| { status: "ok"; result: unknown }
	/**
	 * The call did not run. A person decides it in Tedix's approval list at
	 * `url`; approving there runs this exact call once. The chat shows the
	 * card and does not call again with the same arguments.
	 */
	| {
			status: "needsApproval";
			approvalId: string;
			description: string;
			url: string | null;
			decidedIn: "tedix_approvals";
	  }
	| { status: "refused"; reason: string }
	| { status: "error"; message: string };

/** A step's result is cut to this many characters before anything else. */
export const GUEST_TURN_STEP_RESULT_CHARS = 2_000;
export const GUEST_TURN_MAX_STEPS = 32;
export const GUEST_TURN_TEXT_CHARS = 20_000;

export const GuestTurnLearnInputSchema = GuestTurnScopeSchema.extend({
	/** Stable id of the finished turn. Send each turn once. */
	turnId: z.string().min(1).max(200),
	userText: z.string(),
	replyText: z.string(),
	steps: z
		.array(
			z.object({
				tool: z.string().min(1).max(200),
				ok: z.boolean(),
				/** Kept for later use; learning reads the tool name and outcome only. */
				result: z
					.string()
					.transform((text) => text.slice(0, GUEST_TURN_STEP_RESULT_CHARS))
					.optional(),
			}),
		)
		.max(GUEST_TURN_MAX_STEPS)
		.default([]),
	/** The model that wrote the reply, as the workspace service names it. */
	model: z.string().max(200).optional(),
});
export type GuestTurnLearnInput = z.input<typeof GuestTurnLearnInputSchema>;

export type GuestTurnLearnResult =
	| { accepted: true }
	| { accepted: false; reason: string };

/**
 * A tedi answering one workspace chat message as a guest: the workspace
 * service runs the turn, and calls back here for the tedi's own skills and
 * connected tools, and to hand over the finished turn so the tedi learns
 * from it. Same caller and trust rules as `guestProfile`.
 *
 * Included: the tedi's skills (read on demand) and the tools of its connected
 * services, searched, described and called one at a time through the same
 * runtime the tedi's own turns use. The checks of that path apply when a tool
 * acts: the gateway decides each call under the tedi's identity and policy,
 * and an approval it asks for is decided in Tedix's approval list.
 *
 * Left out: free-form Code Mode programs, the tedi's files, browser, web
 * search, mail, schedules, memory tools and delegation, and anything that
 * reaches a person's machine or starts agent runs (the workspace service has
 * its own tools for those).
 */
import {
	GUEST_READ_SKILL_TOOL,
	GUEST_TURN_TEXT_CHARS,
	GuestToolCatalogInputSchema,
	GuestToolRunInputSchema,
	GuestTurnLearnInputSchema,
	type GuestToolCatalog,
	type GuestToolRow,
	type GuestToolRunResult,
	type GuestTurnLearnResult,
	type GuestTurnScope,
} from "@tedix/api-contract/schemas/tedi-guest-turn";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { scrubText } from "@tedix/context-core/trace-safety";
import type { PlatformClient } from "./brain/platform-client";
import type { BridgeTurnInput, RecentTurn } from "./bridge-turn-input";
import { discoveryRows } from "./delegation-preflight";
import type { AgentMcpRuntime } from "./mcp-client-runtime";
import type { ObserverToolExecutionEvidence } from "./observer-execution-evidence";
import { createSkillReadTool } from "./skill-read";

export interface GuestTurnHost {
	ensureIdentity(hints: { tediId: string; orgId: string }): Promise<void>;
	getPlatformClient(): Promise<Pick<
		PlatformClient,
		"listSkillsForTedi" | "getSkillForMcp"
	> | null>;
	getMcpRuntime(): Promise<Pick<AgentMcpRuntime, "executeTool"> | null>;
	dispatchTurnMemoryEffects(
		input: Pick<BridgeTurnInput, "runId" | "executionEvidence"> & {
			user: RecentTurn;
			assistant: RecentTurn;
			sessionKey: string;
			origin: string;
		},
	): Promise<void>;
}

const NOT_A_PERSON =
	"This tedi's own skills and tools are only used when a signed-in person who may pick it sent the message.";
const NOT_THE_OWNER =
	"A personal tedi's own skills and tools are only used by its owner.";
const SHARED_WORKSPACE =
	"This tedi's connected accounts are only used in a chat private to you.";
const CALLABLE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAX_SKILLS = 50;
const MAX_NAMESPACES = 60;

/** Why this sender gets none of the tedi's own skills or tools, or null. */
export function guestToolsRefusal(scope: GuestTurnScope): string | null {
	if (scope.trust !== "trusted" || !scope.senderUserId) return NOT_A_PERSON;
	if (scope.tediOwnerUserId && scope.tediOwnerUserId !== scope.senderUserId)
		return NOT_THE_OWNER;
	return null;
}

/**
 * Whether the tedi learns from a guest turn. A personal tedi learns only from
 * a workspace nobody but its owner can open, the same rule as for bringing its
 * memory into a workspace. An organization tedi learns only from a workspace
 * private to the sender, and from no shared workspace, UNTIL THE OWNER DECIDES
 * whether organization tedis may learn from shared workspaces. A turn nobody
 * signed in for is never learned from.
 */
export function guestTurnLearnRefusal(scope: GuestTurnScope): string | null {
	if (scope.trust !== "trusted" || !scope.senderUserId)
		return "Only a turn sent by a signed-in person is learned from.";
	if (scope.tediOwnerUserId && scope.tediOwnerUserId !== scope.senderUserId)
		return "A personal tedi learns only from its owner's turns.";
	if (scope.othersCanOpen)
		return "A tedi learns only from a workspace private to the sender.";
	return null;
}

function oneLine(value: unknown, max = 200): string {
	const text =
		typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function errorText(error: unknown): string {
	return oneLine(
		scrubText(error instanceof Error ? error.message : String(error)),
		600,
	);
}

/** Who asked goes to the Worker log; a guest call writes no database row. */
function logGuestCall(
	scope: GuestTurnScope,
	tool: string,
	outcome: string,
): void {
	console.log(
		JSON.stringify({
			event: "tedi.guest_tool",
			tediId: scope.tediId,
			senderUserId: scope.senderUserId,
			workspaceId: scope.workspaceId,
			conversationId: scope.conversationId,
			tool,
			outcome,
		}),
	);
}

function toolRow(row: unknown, withSchema: boolean): GuestToolRow[] {
	if (
		!isRecord(row) ||
		typeof row.callable !== "string" ||
		row.authorized === false ||
		row.kind === "skill"
	)
		return [];
	const annotations = isRecord(row.annotations) ? row.annotations : {};
	return [
		{
			name: row.callable,
			description: oneLine(row.description),
			...(annotations.readOnlyHint === true ? { readOnly: true } : {}),
			...(annotations.destructiveHint === true ? { destructive: true } : {}),
			...(withSchema && row.parameters !== undefined
				? { inputSchema: row.parameters }
				: {}),
		},
	];
}

/** `{ namespace: toolCount }`, possibly wrapped or sent as JSON text. */
function namespaceCounts(
	value: unknown,
	depth = 0,
): GuestToolCatalog["namespaces"] {
	if (depth > 3) return [];
	if (typeof value === "string") {
		try {
			return namespaceCounts(JSON.parse(value), depth + 1);
		} catch {
			return [];
		}
	}
	if (!isRecord(value)) return [];
	const counts = Object.entries(value).filter(
		(entry): entry is [string, number] => typeof entry[1] === "number",
	);
	if (counts.length > 0)
		return counts
			.slice(0, MAX_NAMESPACES)
			.map(([name, tools]) => ({ name, tools }));
	for (const key of ["result", "data", "namespaces"]) {
		const found = namespaceCounts(value[key], depth + 1);
		if (found.length > 0) return found;
	}
	return [];
}

export async function guestToolCatalog(
	this: GuestTurnHost,
	raw: unknown,
): Promise<GuestToolCatalog> {
	const empty: GuestToolCatalog = { skills: [], namespaces: [], tools: [] };
	const parsed = GuestToolCatalogInputSchema.safeParse(raw);
	if (!parsed.success) return { ...empty, refusal: NOT_A_PERSON };
	const input = parsed.data;
	const refusal = guestToolsRefusal(input);
	if (refusal) return { ...empty, refusal };
	await this.ensureIdentity({
		tediId: input.tediId,
		orgId: input.organizationId,
	});
	const search = input.describe ?? input.query;
	if (search) {
		// Connected tools run on the tedi's own accounts: private chats only.
		if (input.othersCanOpen) return { ...empty, refusal: SHARED_WORKSPACE };
		try {
			const mcp = await this.getMcpRuntime();
			if (!mcp) return empty;
			const rows =
				discoveryRows(
					await mcp.executeTool(
						"tedix_mcp_search_tools",
						{
							query: search,
							limit: 10,
							includeParameters: Boolean(input.describe),
						},
						{ binding: null, resultAudience: "machine" },
					),
				) ?? [];
			const tools = rows.flatMap((row) =>
				toolRow(row, Boolean(input.describe)),
			);
			return {
				...empty,
				tools: input.describe
					? tools.filter((tool) => tool.name === input.describe)
					: tools,
			};
		} catch (error) {
			return { ...empty, refusal: errorText(error) };
		}
	}
	const [skills, namespaces] = await Promise.all([
		this.getPlatformClient()
			.then((platform) => platform?.listSkillsForTedi({ limit: MAX_SKILLS }))
			.then((list) =>
				(list?.entries ?? []).flatMap((entry) =>
					entry.slug
						? [
								{
									slug: entry.slug,
									title: oneLine(entry.title, 120),
									summary: oneLine(entry.summary ?? entry.description),
								},
							]
						: [],
				),
			)
			.catch(() => []),
		input.othersCanOpen
			? []
			: this.getMcpRuntime()
					.then((mcp) =>
						mcp?.executeTool(
							"tedix_mcp_list_namespaces",
							{},
							{ binding: null, resultAudience: "machine" },
						),
					)
					.then((result) => namespaceCounts(result))
					.catch(() => []),
	]);
	return {
		skills,
		namespaces,
		tools: [],
		...(input.othersCanOpen ? { refusal: SHARED_WORKSPACE } : {}),
	};
}

/**
 * The gateway parks a call that needs a person's decision and answers with
 * this sentence; approving the request in Tedix runs that exact call once.
 */
function approvalNeeded(
	text: string,
	tool: string,
): Extract<GuestToolRunResult, { status: "needsApproval" }> | null {
	const match =
		/Human approval required\. Request ([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}) \(([a-z_]+)\)(?::\s*(\S+?))?(?:\.\s|\.$|$)/i.exec(
			text,
		);
	if (!match) return null;
	return {
		status: "needsApproval",
		approvalId: match[1]!,
		description: `Run ${tool} with this tedi's connected account. Approving it in Tedix runs this exact call once.`,
		url: match[3] ?? null,
		decidedIn: "tedix_approvals",
	};
}

export async function guestToolRun(
	this: GuestTurnHost,
	raw: unknown,
): Promise<GuestToolRunResult> {
	const parsed = GuestToolRunInputSchema.safeParse(raw);
	if (!parsed.success) return { status: "refused", reason: NOT_A_PERSON };
	const input = parsed.data;
	const done = (result: GuestToolRunResult): GuestToolRunResult => {
		logGuestCall(input, input.tool, result.status);
		return result;
	};
	const refusal = guestToolsRefusal(input);
	if (refusal) return done({ status: "refused", reason: refusal });
	try {
		await this.ensureIdentity({
			tediId: input.tediId,
			orgId: input.organizationId,
		});
		if (input.tool === GUEST_READ_SKILL_TOOL) {
			const result = await createSkillReadTool(() => this.getPlatformClient())
				.execute!(input.args, {
				context: {},
				messages: [],
				toolCallId: `guest:${input.conversationId}`,
			});
			return done({ status: "ok", result });
		}
		if (!CALLABLE.test(input.tool))
			return done({
				status: "refused",
				reason: "This is not one of this tedi's skills or connected tools.",
			});
		if (input.othersCanOpen)
			return done({ status: "refused", reason: SHARED_WORKSPACE });
		const mcp = await this.getMcpRuntime();
		if (!mcp)
			return done({
				status: "error",
				message: "This tedi's connected tools are unavailable.",
			});
		const result = await mcp.executeTool(
			"tedix_mcp_call_tool",
			{ callable: input.tool, args: input.args },
			{ binding: null },
		);
		const approval = approvalNeeded(
			typeof result === "string" ? result : (JSON.stringify(result) ?? ""),
			input.tool,
		);
		return done(approval ?? { status: "ok", result });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return done(
			approvalNeeded(message, input.tool) ?? {
				status: "error",
				message: errorText(error),
			},
		);
	}
}

/**
 * Hand the finished guest turn to the tedi's normal after-turn learning. It
 * is queued in this object and runs after this call returned.
 */
export async function guestTurnLearn(
	this: GuestTurnHost,
	raw: unknown,
): Promise<GuestTurnLearnResult> {
	const parsed = GuestTurnLearnInputSchema.safeParse(raw);
	if (!parsed.success)
		return { accepted: false, reason: "The finished turn could not be read." };
	const input = parsed.data;
	const refusal = guestTurnLearnRefusal(input);
	if (refusal) return { accepted: false, reason: refusal };
	if (!input.userText.trim() || !input.replyText.trim())
		return { accepted: false, reason: "The turn has no message or no reply." };
	try {
		await this.ensureIdentity({
			tediId: input.tediId,
			orgId: input.organizationId,
		});
		const sessionKey = `workspace:${input.workspaceId}`;
		const runId = `${input.tediId}:guest:${input.turnId}`;
		const ts = Date.now();
		// As on the tedi's own turns, learning sees which tools ran and how they
		// ended, never their arguments or results.
		const executionEvidence = input.steps.map(
			(step, index): ObserverToolExecutionEvidence => ({
				ref: `${runId}:step:${index}:0:${step.tool}`,
				tool: step.tool,
				outcome: step.ok ? "succeeded" : "failed",
			}),
		);
		await this.dispatchTurnMemoryEffects({
			user: {
				role: "user",
				content: input.userText.slice(0, GUEST_TURN_TEXT_CHARS),
				sessionKey,
				ts,
			},
			assistant: {
				role: "assistant",
				content: input.replyText.slice(0, GUEST_TURN_TEXT_CHARS),
				sessionKey,
				ts,
			},
			runId,
			sessionKey,
			origin: "chat",
			...(executionEvidence.length > 0 ? { executionEvidence } : {}),
		});
		return { accepted: true };
	} catch (error) {
		return { accepted: false, reason: errorText(error) };
	}
}

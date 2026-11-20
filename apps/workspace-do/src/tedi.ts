import type {
	GuestToolCatalog,
	GuestToolCatalogInput,
	GuestToolRunInput,
	GuestToolRunResult,
	GuestTurnLearnInput,
	GuestTurnLearnResult,
	GuestTurnScope,
} from "@tedix/api-contract/schemas/tedi-guest-turn";
import { wrapUntrustedInput } from "@tedix/chat-transport/untrusted-input";

export const TEDI_UNAVAILABLE =
	"The answering tedi's own skills and tools can be used only when a signed-in person picked, mentioned or defaulted to that tedi and sent the message themself. They are not available to the workspace agent, to scheduled turns, or to turns a tedi, an app or a share link started.";

/** The three guest calls on a tedi's own object, next to `guestProfile`. */
export interface TediGuestService {
	guestToolCatalog(input: GuestToolCatalogInput): Promise<GuestToolCatalog>;
	guestToolRun(input: GuestToolRunInput): Promise<GuestToolRunResult>;
	guestTurnLearn(input: GuestTurnLearnInput): Promise<GuestTurnLearnResult>;
}

/** What the chat shows when a tedi's call waits for a person's decision. */
export interface TediApprovalRequest {
	approvalId: string;
	tediId: string;
	tool: string;
	description: string;
	url: string | null;
}

/** The most text one tool result hands back to the model. */
const RESULT_CHARS = 40_000;

/**
 * The tedi's skills and connected tool groups in a few lines for its prompt.
 * Titles and summaries are written by people, so they arrive fenced.
 */
export function renderTediCatalog(catalog: GuestToolCatalog): string | null {
	const lines = [
		...catalog.skills.map(
			(skill) => `- skill ${skill.slug}: ${skill.title} — ${skill.summary}`,
		),
		...catalog.namespaces.map(
			(group) => `- tools ${group.name} (${group.tools})`,
		),
	];
	if (lines.length === 0 && !catalog.refusal) return null;
	return [
		'Your own skills and connected tool groups. Use them through env.tedi: list({ query }) to search, describe({ tool }) for arguments, call({ tool, args }) to run; read a skill with call({ tool: "read_skill", args: { slug } }).',
		...(lines.length
			? [wrapUntrustedInput(lines.join("\n"), "tedi_catalog")]
			: []),
		...(catalog.refusal ? [catalog.refusal] : []),
	].join("\n");
}

/**
 * The answering tedi's own skills and connected tools, for a turn a signed-in
 * person sent to that tedi. `guest` resolves who sent the turn and who can
 * open the workspace, read live on every call, or null when the turn may not
 * use them. The tedi's object applies its own rules again on each call.
 */
export function workspaceTedi(deps: {
	guest: () => Promise<{
		scope: GuestTurnScope;
		service: TediGuestService;
	} | null>;
	requestApproval: (request: TediApprovalRequest) => void;
}) {
	const resolve = async () => {
		const guest = await deps.guest();
		if (!guest) throw new Error(TEDI_UNAVAILABLE);
		return guest;
	};
	const toolName = (value: unknown) => {
		if (typeof value !== "string" || !value.trim())
			throw new Error("Name the tool, for example mail.search or read_skill.");
		return value.trim();
	};
	return {
		async list(input?: { query?: unknown }) {
			if (input?.query !== undefined && typeof input.query !== "string")
				throw new Error("query must be text.");
			const { scope, service } = await resolve();
			const query = input?.query?.trim();
			const catalog = await service.guestToolCatalog({
				...scope,
				...(query ? { query } : {}),
			});
			return {
				skills: catalog.skills.map((skill) => ({
					slug: skill.slug,
					about: wrapUntrustedInput(
						`${skill.title}: ${skill.summary}`,
						"tedi_skill",
					),
				})),
				groups: catalog.namespaces,
				tools: catalog.tools.map((tool) => ({
					tool: tool.name,
					about: wrapUntrustedInput(tool.description, "tedi_tool"),
					...(tool.readOnly ? { readOnly: true } : {}),
					...(tool.destructive ? { destructive: true } : {}),
				})),
				...(catalog.refusal ? { refusal: catalog.refusal } : {}),
			};
		},
		async describe(input: { tool?: unknown }) {
			const tool = toolName(input?.tool);
			const { scope, service } = await resolve();
			const catalog = await service.guestToolCatalog({
				...scope,
				describe: tool,
			});
			const row = catalog.tools.find((candidate) => candidate.name === tool);
			if (!row)
				throw new Error(
					catalog.refusal ??
						`${tool} is not one of this tedi's tools. Search with env.tedi.list({ query }).`,
				);
			return {
				tool: row.name,
				about: wrapUntrustedInput(row.description, "tedi_tool"),
				inputSchema: row.inputSchema ?? null,
				...(row.readOnly ? { readOnly: true } : {}),
				...(row.destructive ? { destructive: true } : {}),
			};
		},
		async call(input: { tool?: unknown; args?: unknown }) {
			const tool = toolName(input?.tool);
			const args = input?.args ?? {};
			if (typeof args !== "object" || args === null || Array.isArray(args))
				throw new Error("args must be an object.");
			const { scope, service } = await resolve();
			const result = await service.guestToolRun({
				...scope,
				tool,
				args: args as GuestToolRunInput["args"],
			});
			switch (result.status) {
				case "ok": {
					const text =
						typeof result.result === "string"
							? result.result
							: (JSON.stringify(result.result) ?? "null");
					return {
						status: "ok" as const,
						result: wrapUntrustedInput(
							text.slice(0, RESULT_CHARS),
							"tedi_tool_result",
						),
						...(text.length > RESULT_CHARS ? { truncated: true } : {}),
					};
				}
				case "needsApproval":
					deps.requestApproval({
						approvalId: result.approvalId,
						tediId: scope.tediId,
						tool,
						description: result.description,
						url: result.url,
					});
					return {
						status: "needsApproval" as const,
						message:
							"The chat now shows an approval card for this call. A person decides it in Tedix's approvals; approving there runs this exact call once, and its result does not come back into this chat. Do not call it again. Say in one sentence what is waiting.",
					};
				case "refused":
					throw new Error(result.reason);
				case "error":
					throw new Error(result.message);
			}
		},
	};
}

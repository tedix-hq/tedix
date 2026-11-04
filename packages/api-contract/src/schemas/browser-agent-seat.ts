import * as z from "zod";

export const BrowserAgentSeatSchema = z.object({
	userId: z.string().min(1),
	memberId: z.string().min(1),
	displayName: z.string().min(1),
	representedUserId: z.string().min(1),
	representedUserName: z.string().min(1),
});
export type BrowserAgentSeat = z.infer<typeof BrowserAgentSeatSchema>;

export function isAgentMemberKind(
	kind: string | undefined,
): kind is "external_agent" | "browser_agent" {
	return kind === "external_agent" || kind === "browser_agent";
}

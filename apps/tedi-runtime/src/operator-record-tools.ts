import { discoveryRows } from "./delegation-preflight";
import { callRpc, serviceBindingFetch } from "@tedix/api-client/internal";
import { type ToolSet, tool } from "ai";
import * as z from "zod";

/** Native readers use the tedi's identity; the API resolves the admitted member. */
export function operatorRecordTools(input: {
	env: Pick<Cloudflare.Env, "API_URL" | "API_SERVICE">;
	tediId: string;
	organizationId: string;
	runId: string;
	homeRunId: string;
	workItemId: string;
	executeMcp(
		name: "tedix_mcp_search_tools" | "tedix_mcp_call_tool",
		args: Record<string, unknown>,
	): Promise<unknown>;
}): ToolSet {
	const read = (
		source: "work" | "home" | "memory" | "calendar" | "mail",
		args: { query?: string; conversationId?: string },
	) =>
		callRpc(
			"kernelRuntime/readOperatorRecords",
			{
				tediId: input.tediId,
				runId: input.runId,
				homeRunId: input.homeRunId,
				workItemId: input.workItemId,
				source,
				...args,
			},
			{
				apiUrl: input.env.API_URL,
				fetch: serviceBindingFetch(input.env.API_SERVICE),
				headers: {
					"X-Service-Binding": "true",
					"X-Tedix-Tedi-Id": input.tediId,
					"X-Tedix-Organization-Id": input.organizationId,
				},
				signal: AbortSignal.timeout(30000),
			},
		);
	const providerRead = async (
		provider: "google_calendar" | "google_gmail",
		operation: "list_events" | "search_threads",
		args: Record<string, unknown>,
	) => {
		const result = await input.executeMcp("tedix_mcp_search_tools", {
			query: `${provider} ${operation}`,
			limit: 5,
			includeParameters: true,
		});
		const schema = z.object({
			callable: z.string(),
			authorized: z.literal(true),
			annotations: z.object({ readOnlyHint: z.literal(true) }),
		});
		const pattern = new RegExp(
			`^${provider}(?:_[A-Za-z0-9_]+)?\\.${operation}$`,
		);
		const matches = (discoveryRows(result) ?? []).flatMap((row) => {
			const parsed = schema.safeParse(row);
			return parsed.success && pattern.test(parsed.data.callable)
				? [parsed.data.callable]
				: [];
		});
		if (matches.length !== 1)
			throw new Error(
				`No unique authorized ${provider} ${operation} reader is available`,
			);
		return input.executeMcp("tedix_mcp_call_tool", {
			callable: matches[0],
			args,
		});
	};
	return {
		read_operator_records: tool({
			description:
				"Read the admitted requester's active Work items, open interactions, saved Today and recent authorized Home titles. Cite dated records. This grants no writes or new connections.",
			inputSchema: z.object({ query: z.string().max(500).optional() }),
			execute: (args) => read("work", args),
		}),
		read_home_messages: tool({
			description:
				"Read a bounded Home transcript under the admitted member's conversation access. Omit conversationId for the requesting Home thread; use an authorized title's id for another thread.",
			inputSchema: z.object({
				conversationId: z.string().min(1).max(256).optional(),
			}),
			execute: (args) => read("home", args),
		}),
		read_operator_calendar: tool({
			description:
				"Read up to 25 dated events in the requester's primary connected calendar, only with active run-bound account consent. A gateway denial means unavailable access; never substitute another account.",
			inputSchema: z.object({
				timeMin: z.iso.datetime(),
				timeMax: z.iso.datetime(),
			}),
			execute: async (args) => {
				const range = Date.parse(args.timeMax) - Date.parse(args.timeMin);
				if (range <= 0 || range > 31 * 24 * 60 * 60 * 1000)
					throw new Error(
						"Calendar read requires a positive range of at most 31 days",
					);
				await read("calendar", {});
				return providerRead("google_calendar", "list_events", {
					...args,
					calendarId: "primary",
					maxResults: 25,
					singleEvents: true,
					orderBy: "startTime",
				});
			},
		}),
		read_operator_mail: tool({
			description:
				"Search up to 10 threads in the requester's granted mailbox under active request-bound consent. Read only; no send, draft, labels, account changes or connection grants.",
			inputSchema: z.object({ query: z.string().min(1).max(500) }),
			execute: async (args) => {
				await read("mail", {});
				return providerRead("google_gmail", "search_threads", {
					...args,
					pageSize: 10,
				});
			},
		}),
		memory_search: tool({
			description:
				"Read bounded, eligible organization memory for the admitted request. Private facts of other members' tedis remain unavailable.",
			inputSchema: z.object({ query: z.string().min(1).max(500) }),
			execute: (args) => read("memory", args),
		}),
	};
}

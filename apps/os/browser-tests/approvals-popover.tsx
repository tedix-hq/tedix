import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { ApprovalNotifications } from "../src/components/approval-notifications";
import {
	pendingApprovalsQueryOptions,
	pendingHomeDelegationsQueryOptions,
} from "../src/lib/os-query-options";
import "../src/styles.css";

// Real component, seeded reads: three held delegations (two tedis) or none.
const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
const empty = params.has("empty");
document.documentElement.classList.toggle("dark", dark);
document.documentElement.style.colorScheme = dark ? "dark" : "light";

const now = Date.now();
const at = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
const held = (input: {
	id: string;
	tedi: string;
	label: string;
	reason: string;
	request: string;
	createdHoursAgo: number;
}) => ({
	id: input.id,
	organizationId: "org",
	conversationId: `home:os:${input.id}`,
	status: "requires_approval" as const,
	createdAt: at(-input.createdHoursAgo),
	updatedAt: at(-input.createdHoursAgo),
	metadata: {
		homeDelegation: {
			decision: { mode: "needs_approval", reason: input.reason },
			workOrder: {
				kind: "tedi.delegate",
				status: "draft",
				targetTediId: input.tedi,
				targetTediLabel: input.label,
				sourceContent: input.request,
			},
			expiresAt: at(24 - input.createdHoursAgo),
		},
	},
});

const client = new QueryClient({
	defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});
client.setQueryData(pendingApprovalsQueryOptions().queryKey, {
	data: [],
} as never);
client.setQueryData(pendingHomeDelegationsQueryOptions().queryKey, {
	runSet: {
		organizationId: "org",
		conversationId: "__pending-home-delegations__",
		activeRunIds: [],
		approvalMirrors: {},
		updatedAt: null,
		runs: empty
			? []
			: [
					held({
						id: "00000000-0000-4000-8000-0000000000a1",
						tedi: "00000000-0000-4000-8000-0000000000c1",
						label: "CFO",
						reason: "human-reserved: money, external_message",
						request:
							"Create the sevDesk invoice draft for Example GmbH, EUR 8,000 net, 7-day payment terms. Draft only.",
						createdHoursAgo: 3,
					}),
					held({
						id: "00000000-0000-4000-8000-0000000000a2",
						tedi: "00000000-0000-4000-8000-0000000000c2",
						label: "CTO",
						reason: "high risk requires human approval",
						request:
							"Refactor the scheduler module and open a branch with the change and its tests.",
						createdHoursAgo: 20,
					}),
					held({
						id: "00000000-0000-4000-8000-0000000000a3",
						tedi: "00000000-0000-4000-8000-0000000000c2",
						label: "CTO",
						reason: "human-reserved: public_publish",
						request: "Publish the release notes for the October update.",
						createdHoursAgo: 1,
					}),
				],
	},
} as never);

createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={client}>
		<header style={{ display: "flex", justifyContent: "flex-end", padding: 8 }}>
			<ApprovalNotifications />
		</header>
	</QueryClientProvider>,
);

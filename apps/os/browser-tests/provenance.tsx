import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	PERSONAL_AGENT_FINDINGS,
	PERSONAL_AGENT_ORG,
	PERSONAL_AGENT_OWNER,
	PERSONAL_AGENT_PRINCIPALS,
} from "../dev/personal-agent-fixture";
import { WorkActorDirectory } from "../src/components/work-actor-directory";
import { FeedCard } from "../src/components/focus-feed-card";
import { WorkDecisionCard } from "../src/components/work-decision-card";
import { Text } from "../src/components/kumo/text";
import {
	Page,
	PageHeader,
	PageTitle,
	PageSection,
} from "../src/components/kumo/page";
import {
	membersListQueryOptions,
	operationalContextQueryOptions,
	tediRosterQueryOptions,
	userProfileQueryOptions,
	workExternalPrincipalsQueryOptions,
} from "../src/lib/os-query-options";
import { DEFAULT_ORGANIZATION_OS_THEME } from "@tedix/api-contract/schemas/os-theme";
import { organizationThemeVariables } from "../src/lib/organization-theme";
import "../src/styles.css";
import "../src/components/feed-timeline.css";
import "../src/components/focus-feed.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
const palette = { ...DEFAULT_ORGANIZATION_OS_THEME[dark ? "dark" : "light"] };
if (params.get("palette") === "blue")
	palette.accent = dark ? "#60a5fa" : "#2563eb";
for (const [key, value] of Object.entries(
	organizationThemeVariables(palette, DEFAULT_ORGANIZATION_OS_THEME),
))
	document.documentElement.style.setProperty(key, value);
const client = new QueryClient({
	defaultOptions: {
		queries: { enabled: false, staleTime: Infinity, retry: false },
	},
});
client.setQueryData(operationalContextQueryOptions().queryKey, {
	organization: { id: PERSONAL_AGENT_ORG },
});
client.setQueryData(userProfileQueryOptions().queryKey, {
	id: PERSONAL_AGENT_OWNER,
	name: "Morgan Lee",
	email: "morgan@example.test",
});
client.setQueryData(
	membersListQueryOptions({
		organizationId: PERSONAL_AGENT_ORG,
		limit: 100,
		offset: 0,
	}).queryKey,
	{ data: [] },
);
client.setQueryData(tediRosterQueryOptions(100).queryKey, { data: [] });
client.setQueryData(
	workExternalPrincipalsQueryOptions(PERSONAL_AGENT_ORG).queryKey,
	PERSONAL_AGENT_PRINCIPALS,
);

createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={client}>
		<WorkActorDirectory>
			<Page width="md">
				<PageHeader>
					<PageTitle>Personal agent provenance</PageTitle>
				</PageHeader>
				<PageSection className="feed-deck fd-feed focus-feed">
					<Text as="h2" role="section">
						Feed
					</Text>
					{PERSONAL_AGENT_FINDINGS.map((item) => (
						<div className="focus-row" key={item.id}>
							<FeedCard
								item={{
									...item,
									score: 1,
									factors: {},
									unseen: false,
									deadline: false,
								}}
								actor={item.actor}
								busy={false}
								onReact={async () => true}
								onWork={async () => {}}
							/>
						</div>
					))}
				</PageSection>
				<PageSection className="feed-deck fd-deck">
					<Text as="h2" role="section">
						Deck
					</Text>
					<WorkDecisionCard
						kind="proposal"
						title="Use the revised delivery date?"
						askedBy="Juniper"
						actor={PERSONAL_AGENT_FINDINGS[0]!.actorIdentity}
						at={PERSONAL_AGENT_FINDINGS[0]!.at}
						body="The supplier moved the delivery date to Friday. Update the plan after checking the original message."
						actions={[
							{
								id: "approve",
								label: "Use Friday",
								intent: "approve",
								primary: true,
							},
							{ id: "later", label: "Later", intent: "later" },
						]}
						onDecision={async () => {}}
					/>
				</PageSection>
			</Page>
		</WorkActorDirectory>
	</QueryClientProvider>,
);

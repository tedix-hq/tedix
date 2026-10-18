import type { ReactNode } from "react";
import type { ActivityFeedConfig } from "@tedix/api-contract/schemas/os-activity-feed";
import { OS_COPY } from "@/shared/os-copy";
import { DecisionContextRail } from "@/components/decision-context-rail";
import { FocusFeed } from "@/components/focus-feed";
import "./feed-timeline.css";
import "./focus-feed.css";

type Filter = keyof typeof OS_COPY.feed.filters;
export interface ActivityFeedNavigation {
	filter?: Filter;
	projectId?: string;
	day?: string;
	onFilterChange?: (filter: Filter) => void;
	decide?: ReactNode;
	apps?: ReactNode;
}

export function ActivityFeedApp(props: {
	config: ActivityFeedConfig;
	navigation?: ActivityFeedNavigation;
}) {
	return (
		<DecisionContextRail>
			<FocusFeed {...props} />
		</DecisionContextRail>
	);
}

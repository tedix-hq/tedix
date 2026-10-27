import { ORGANIZATION_DOMAIN_ENTRY } from "@tedix/api-contract/schemas/organization-domains";
import {
	WORK_DISPATCH_ENTRY,
	WorkDispatchConfigSchema,
	OFFICE_ENTRY,
	AGENTS_ENTRY,
	OfficeConfigSchema,
	AgentsConfigSchema,
} from "@tedix/api-contract/schemas/os-session-apps";
import type { OsGadgetManifest } from "@tedix/api-contract/schemas/os-workspaces";
import {
	PERSONAL_READ_CONSENT_ENTRY,
	PersonalReadConsentConfigSchema,
} from "@tedix/api-contract/schemas/os-workspaces";
import {
	DECISION_DECK_ENTRY,
	DecisionDeckConfigSchema,
} from "@tedix/api-contract/schemas/os-decision-deck";
import {
	ACTIVITY_FEED_ENTRY,
	ActivityFeedConfigSchema,
} from "@tedix/api-contract/schemas/os-activity-feed";
import {
	SYSTEM_MAP_ENTRY,
	SystemMapConfigSchema,
} from "@tedix/api-contract/schemas/os-system-map";
import type { ActivityFeedNavigation } from "@/components/activity-feed-app";
import {
	OUTBOUND_REVIEW_ENTRY,
	OutboundReviewConfigSchema,
} from "@tedix/api-contract/schemas/os-outbound-review";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Card, CardContent } from "@/components/kumo/card";
import { Button } from "@/components/kumo/button";
import { Text } from "@/components/kumo/text";
import { cardReviewConfigFromManifest } from "@tedix/api-contract/utils/card-review";
import { lazy, Suspense } from "react";
import { Skeleton } from "@/components/kumo/skeleton";

const WorkDispatchApp = lazy(() =>
	import("./work-dispatch-app").then((m) => ({ default: m.WorkDispatchApp })),
);
const OfficeApp = lazy(() =>
	import("./work-office-page").then((m) => ({ default: m.OfficeApp })),
);
const AgentsApp = lazy(() =>
	import("./work-agents-page").then((m) => ({ default: m.AgentsApp })),
);
const PersonalReadConsentApp = lazy(() =>
	import("./personal-read-consent-app").then((m) => ({
		default: m.PersonalReadConsentApp,
	})),
);
const DecisionDeckApp = lazy(() =>
	import("./decision-deck-app").then((m) => ({ default: m.DecisionDeckApp })),
);
const CardReviewApp = lazy(() =>
	import("./card-review-app").then((m) => ({ default: m.CardReviewApp })),
);
const OutboundReviewApp = lazy(() =>
	import("./outbound-review-app").then((m) => ({
		default: m.OutboundReviewApp,
	})),
);
const AttentionApp = lazy(() =>
	import("./work-attention-page").then((m) => ({ default: m.AttentionApp })),
);
const ActivityFeedApp = lazy(() =>
	import("./activity-feed-app").then((m) => ({ default: m.ActivityFeedApp })),
);
const SystemMapApp = lazy(() =>
	import("./system-map-app").then((m) => ({ default: m.SystemMapApp })),
);

const AccountOrganizationsApp = lazy(() =>
	import("./account-organizations-app").then((m) => ({
		default: m.AccountOrganizationsApp,
	})),
);

const OrganizationDomainApp = lazy(() =>
	import("./organization-domain-app").then((m) => ({
		default: m.OrganizationDomainApp,
	})),
);

const Portfolio = lazy(() =>
	import("./organization-portfolio-app").then((m) => ({
		default: m.OrganizationPortfolioApp,
	})),
);
const PortfolioSettings = lazy(() =>
	import("./organization-portfolio-app").then((m) => ({
		default: m.PortfolioSettingsApp,
	})),
);

export function WorkspaceAppRenderer({
	manifest,
	workspaceId,
	activityFeed,
}: {
	manifest: OsGadgetManifest;
	workspaceId?: string;
	activityFeed?: ActivityFeedNavigation;
}) {
	return (
		<Suspense
			fallback={<Skeleton className="h-60 w-full" aria-label="Loading app" />}
		>
			<InstalledApp
				manifest={manifest}
				workspaceId={workspaceId}
				activityFeed={activityFeed}
			/>
		</Suspense>
	);
}

function InstalledApp({
	manifest,
	workspaceId,
	activityFeed,
}: {
	manifest: OsGadgetManifest;
	workspaceId?: string;
	activityFeed?: ActivityFeedNavigation;
}) {
	const entry = manifest.entry.trim();
	if (entry === "tedix:app/account-organizations")
		return <AccountOrganizationsApp />;
	if (
		entry === ORGANIZATION_DOMAIN_ENTRY &&
		typeof manifest.config?.organizationId === "string"
	)
		return (
			<OrganizationDomainApp organizationId={manifest.config.organizationId} />
		);
	if (
		entry === "tedix:app/portfolio" ||
		entry === "tedix:app/portfolio-settings"
	)
		return (
			<Suspense fallback={<Skeleton className="h-24 w-full" />}>
				{entry === "tedix:app/portfolio" ? (
					<Portfolio />
				) : (
					<PortfolioSettings />
				)}
			</Suspense>
		);
	if (entry === PERSONAL_READ_CONSENT_ENTRY && workspaceId) {
		const config = PersonalReadConsentConfigSchema.safeParse(manifest.config);
		if (config.success)
			return (
				<PersonalReadConsentApp
					workspaceId={workspaceId}
					config={config.data}
				/>
			);
	}
	if (entry === DECISION_DECK_ENTRY) {
		const config = DecisionDeckConfigSchema.safeParse(manifest.config);
		if (config.success)
			return <DecisionDeckApp config={config.data} workspaceId={workspaceId} />;
	}
	if (entry === ACTIVITY_FEED_ENTRY) {
		const config = ActivityFeedConfigSchema.safeParse(manifest.config);
		if (config.success)
			return <ActivityFeedApp config={config.data} navigation={activityFeed} />;
	}
	if (entry === SYSTEM_MAP_ENTRY) {
		const config = SystemMapConfigSchema.safeParse(manifest.config);
		if (config.success) return <SystemMapApp config={config.data} />;
	}
	if (entry === WORK_DISPATCH_ENTRY) {
		const config = WorkDispatchConfigSchema.safeParse(manifest.config);
		if (config.success)
			return <WorkDispatchApp projectId={config.data.projectId} />;
	}
	if (entry === "tedix:app/attention")
		return (
			<AttentionApp
				workspaceId={
					manifest.config?.scope === "personal" ? undefined : workspaceId
				}
			/>
		);
	if (entry === OUTBOUND_REVIEW_ENTRY) {
		const config = OutboundReviewConfigSchema.safeParse(manifest.config);
		if (config.success) return <OutboundReviewApp config={config.data} />;
	}
	if (
		entry === OFFICE_ENTRY &&
		OfficeConfigSchema.safeParse(manifest.config).success
	)
		return <OfficeApp />;
	if (entry === AGENTS_ENTRY) {
		const config = AgentsConfigSchema.safeParse(manifest.config);
		if (config.success)
			return (
				<AgentsApp key={JSON.stringify(config.data)} config={config.data} />
			);
	}
	const review = cardReviewConfigFromManifest(manifest);
	if (review.kind === "ok") return <CardReviewApp config={review.config} />;
	return (
		<Alert variant="warning">
			<AlertTitle>This app's settings need a fix</AlertTitle>
			<AlertDescription>
				Open Edit to change the entry and settings in manifest.json.
			</AlertDescription>
		</Alert>
	);
}

export function WorkspaceAppRunsInfo({
	manifest,
	onShowResources,
}: {
	manifest: OsGadgetManifest;
	onShowResources?: () => void;
}) {
	const attention = manifest.entry.trim() === "tedix:app/attention";
	const cards = cardReviewConfigFromManifest(manifest).kind !== "none";
	const sessions = [OFFICE_ENTRY, AGENTS_ENTRY].includes(manifest.entry.trim());
	return (
		<Card size="sm">
			<CardContent className="grid gap-3">
				<Text as="h3" weight="medium">
					{sessions
						? "Activity comes from your sessions"
						: attention
							? "Activity comes from your workspace"
							: cards
								? "Cards come from scheduled skills"
								: "Activity comes from linked Work"}
				</Text>
				<Text>
					{sessions
						? "Open App to see live activity, replies and delegation results."
						: attention
							? "Open App to see local sessions and cloud work in this workspace, with their latest progress."
							: cards
								? "Card review opens saved card sheets. To check when new cards were produced, open Files and choose See runs on a scheduled skill."
								: "Open App to see activity. Each item keeps its history with its originating Work."}
				</Text>
				<Button variant="outline" onClick={onShowResources}>
					Open Files
				</Button>
			</CardContent>
		</Card>
	);
}

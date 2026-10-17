import {
	OFFICE_ENTRY,
	AGENTS_ENTRY,
	OfficeConfigSchema,
	AgentsConfigSchema,
} from "@tedix/api-contract/schemas/os-session-apps";
import { OfficeApp } from "@/components/work-office-page";
import { AgentsApp } from "@/components/work-agents-page";
import type { OsGadgetManifest } from "@tedix/api-contract/schemas/os-workspaces";
import {
	PERSONAL_READ_CONSENT_ENTRY,
	PersonalReadConsentConfigSchema,
} from "@tedix/api-contract/schemas/os-workspaces";
import { PersonalReadConsentApp } from "@/components/personal-read-consent-app";
import {
	OUTBOUND_REVIEW_ENTRY,
	OutboundReviewConfigSchema,
} from "@tedix/api-contract/schemas/os-outbound-review";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { CardReviewApp } from "@/components/card-review-app";
import { OutboundReviewApp } from "@/components/outbound-review-app";
import { AttentionApp } from "@/components/work-attention-page";
import { Card, CardContent } from "@/components/kumo/card";
import { Button } from "@/components/kumo/button";
import { Text } from "@/components/kumo/text";
import { cardReviewConfigFromManifest } from "@/lib/card-review";
import { lazy, Suspense } from "react";
import { Skeleton } from "@/components/kumo/skeleton";

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
}: {
	manifest: OsGadgetManifest;
	workspaceId?: string;
}) {
	const entry = manifest.entry.trim();
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
	if (entry === "tedix:app/attention")
		return <AttentionApp workspaceId={workspaceId} />;
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
				Open Code to edit the entry and settings in manifest.json.
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
						? "Open Preview to see live activity, replies and delegation results."
						: attention
							? "Open Preview to see local sessions and cloud work in this workspace, with their latest progress."
							: cards
								? "Card review opens saved card sheets. To check when new cards were produced, open Resources and choose See runs on a scheduled skill."
								: "Open Preview to review drafts. Each card keeps its reviews, decisions and sending result with its originating Work."}
				</Text>
				<Button variant="outline" onClick={onShowResources}>
					Open Resources
				</Button>
			</CardContent>
		</Card>
	);
}

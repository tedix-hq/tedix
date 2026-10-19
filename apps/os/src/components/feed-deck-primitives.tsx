import {
	DecisionContextSection,
	DecisionRailContext,
} from "@/components/decision-context-rail";
import type {
	WorkActorReference,
	WorkContributionSource,
} from "@tedix/api-contract/schemas/os-work-actor";
import { createContext, useContext, type ReactNode } from "react";
import { FileTextIcon, CaretRightIcon } from "@phosphor-icons/react";
import {
	WorkActorAvatar,
	WorkActorDirectoryContext,
} from "@/components/work-actor-avatar";
import { resolveWorkContributor } from "@/lib/work-actor";
import { Card } from "@/components/kumo/card";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import { Link } from "@/components/kumo/link";
import { Text } from "@/components/kumo/text";
import { cn } from "@/lib/utils";
import { OS_COPY } from "@/shared/os-copy";
import "./feed-deck.css";

export function FeedDeckDisclosure({
	title,
	label,
	children,
	className,
	keepMounted = true,
}: {
	title: ReactNode;
	label?: string;
	children: ReactNode;
	className?: string;
	keepMounted?: boolean;
}) {
	const rail = useContext(DecisionRailContext);
	if (rail)
		return (
			<DecisionContextSection
				sectionId={className === "fd-deck-learning" ? "style" : "details"}
				title={
					className === "fd-action-details" ? (
						(label ?? title)
					) : (
						<>
							<CaretRightIcon className="fd-details-chevron" size={12} />
							{label ?? title}
						</>
					)
				}
				defaultOpen
			>
				{children}
			</DecisionContextSection>
		);
	return (
		<Collapsible className={cn("fd-disclosure", className)} aria-label={label}>
			<CollapsibleTrigger>
				<CaretRightIcon
					size={12}
					className="fd-disclosure-chevron"
					aria-hidden="true"
				/>
				{title}
			</CollapsibleTrigger>
			<CollapsibleContent keepMounted={keepMounted}>
				{children}
			</CollapsibleContent>
		</Collapsible>
	);
}

export const ProposerContext = createContext<{
	project?: string;
	actor?: WorkActorReference;
	source?: WorkContributionSource;
}>({});

export function ProposerChip({
	name,
	actor,
	detail,
}: {
	name: string;
	actor?: WorkActorReference;
	detail?: ReactNode;
}) {
	const context = useContext(ProposerContext);
	const project = context.project;
	const identity = actor ?? context.actor;
	const directory = useContext(WorkActorDirectoryContext);
	const resolved = resolveWorkContributor(identity, name, directory);
	return (
		<div className="fd-proposer">
			<WorkActorAvatar
				actor={identity}
				name={name}
				className="fd-avatar"
				detail={`${resolved.name}${identity?.harness ? " session" : ""}${project ? ` · ${project}` : ""}`}
			/>
			<div>
				<Text weight="medium" title={resolved.label}>
					{resolved.label}
				</Text>
				{(detail || project) && (
					<Text role="label" tone="secondary">
						{project}
						{project && detail && " · "}
						{detail}
					</Text>
				)}
			</div>
		</div>
	);
}

export function FeedDeckCard({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<Card tone="raised" className={cn("fd-card", className)}>
			{children}
		</Card>
	);
}

export function FeedMomentHeader({
	children,
	detail,
}: {
	children: ReactNode;
	detail?: ReactNode;
}) {
	return (
		<header className="fd-moment">
			<Text as="h3">{children}</Text>
			{detail && (
				<Text role="label" tone="secondary">
					{detail}
				</Text>
			)}
		</header>
	);
}

export function RichPreview({
	title,
	href,
	summary,
	image,
	imageAlt = "",
}: {
	title: string;
	href: string;
	summary?: string;
	image?: string;
	imageAlt?: string;
}) {
	return (
		<Link href={href} variant="plain" className="fd-preview">
			{image ? (
				<img
					src={image}
					alt={imageAlt}
					loading="lazy"
					className="fd-preview-image"
				/>
			) : (
				<span className="fd-preview-mark" aria-hidden="true">
					<FileTextIcon size={26} weight="light" />
				</span>
			)}
			<span className="fd-preview-copy">
				<span className="fd-preview-title">{title}</span>
				{summary && <span className="fd-preview-summary">{summary}</span>}
			</span>
		</Link>
	);
}

export function DeckClosure({
	summary,
	detail,
	onHistory,
}: {
	title?: string;
	summary?: ReactNode;
	detail?: ReactNode;
	streak?: ReactNode;
	onHistory?: () => void;
}) {
	const rail = useContext(DecisionRailContext);
	return (
		<section className="fd-closure" role="status">
			<div className="fd-closure-mark" aria-hidden="true">
				<svg width="24" height="24" viewBox="0 0 24 24" fill="none">
					<path
						d="m5 12 4 4L19 6"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			</div>
			<Text as="h2" className="fd-closure-title">
				{OS_COPY.feedDeckVisual.clear}
			</Text>
			<Text className="fd-closure-summary">
				{summary ? (
					<>
						{summary}
						{detail && <> · {detail}</>}
					</>
				) : (
					detail || OS_COPY.feedDeckVisual.nothingWaiting
				)}
			</Text>
			{rail || onHistory ? (
				<Link
					href="#decision-history"
					variant="plain"
					onClick={(event) => {
						event.preventDefault();
						if (onHistory) onHistory();
						else rail?.openSection("history");
					}}
				>
					{OS_COPY.feedDeckVisual.decisionHistory}
				</Link>
			) : (
				<Link href="/work/attention" variant="plain">
					{OS_COPY.feedDeckVisual.decisionHistory}
				</Link>
			)}
		</section>
	);
}

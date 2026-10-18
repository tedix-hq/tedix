import type { WorkActorReference } from "@tedix/api-contract/schemas/os-work-actor";
import { createContext, useContext, type ReactNode } from "react";
import {
	CheckIcon,
	FileTextIcon,
	ArrowUpRightIcon,
	CaretRightIcon,
} from "@phosphor-icons/react";
import {
	WorkActorAvatar,
	WorkActorDirectoryContext,
} from "@/components/work-actor-avatar";
import { resolveWorkActor } from "@/lib/work-actor";
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
}: {
	title: ReactNode;
	label?: string;
	children: ReactNode;
	className?: string;
}) {
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
			<CollapsibleContent keepMounted>{children}</CollapsibleContent>
		</Collapsible>
	);
}

export const ProposerContext = createContext<{
	project?: string;
	actor?: WorkActorReference;
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
	const resolved = resolveWorkActor(identity, name, directory);
	const displayName = project ?? resolved.name;
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
					{displayName}
				</Text>
				{detail && (
					<Text role="label" tone="secondary">
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
			<Text as="h3" tone="mono">
				{children}
			</Text>
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
			<ArrowUpRightIcon size={18} aria-hidden="true" />
		</Link>
	);
}

export function DeckClosure({
	title,
	summary,
	detail,
	streak,
}: {
	title: string;
	summary?: ReactNode;
	detail?: ReactNode;
	streak?: ReactNode;
}) {
	return (
		<section className="fd-closure" role="status">
			<div className="fd-closure-orbit" aria-hidden="true">
				<span />
				<span />
				<span />
				<CheckIcon size={38} weight="light" />
			</div>
			<Text as="h2" className="fd-closure-title" tone="mono">
				{title}
			</Text>
			{summary && <Text className="fd-closure-summary">{summary}</Text>}
			{streak && (
				<Text className="fd-streak" tone="mono">
					{streak}
				</Text>
			)}
			{detail && <Text tone="secondary">{detail}</Text>}
		</section>
	);
}

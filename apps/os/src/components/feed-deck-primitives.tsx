import type { ReactNode } from "react";
import {
	CheckIcon,
	FileTextIcon,
	ArrowUpRightIcon,
	CaretRightIcon,
} from "@phosphor-icons/react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/kumo/avatar";
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

export function ProposerChip({
	name,
	image,
	detail,
}: {
	name: string;
	image?: string;
	detail?: ReactNode;
}) {
	const displayName =
		/^(?:[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\s+session|Agent session)$/i.test(
			name.trim(),
		)
			? OS_COPY.feedDeckVisual.agentSession
			: name;
	const initials = displayName
		.trim()
		.split(/\s+/)
		.slice(0, 2)
		.map((part) => part[0])
		.join("");
	return (
		<div className="fd-proposer">
			<Avatar className="fd-avatar" aria-hidden="true">
				{image && <AvatarImage src={image} alt="" />}
				<AvatarFallback>{initials}</AvatarFallback>
			</Avatar>
			<div>
				<Text weight="medium" title={displayName === name ? undefined : name}>
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

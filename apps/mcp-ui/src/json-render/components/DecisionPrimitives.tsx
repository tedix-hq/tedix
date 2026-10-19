import { useRef, type ReactNode } from "react";
import { safeLinkHref } from "@tedix/widget-ui/safe-url";

export function DecisionCardComponent({
	ask,
	context,
	confidence,
	ifYes,
	why,
	stakes,
	status,
	children,
}: {
	ask: string;
	context?: string | null;
	confidence?: number | null;
	ifYes?: string | null;
	why?: string | null;
	stakes?: string | null;
	kind?: string | null;
	status?: string | null;
	children?: ReactNode;
}) {
	return (
		<article
			className="w-full min-w-0 shrink-0 basis-full snap-center break-words rounded-xl border border-border bg-card p-5 text-card-foreground"
			aria-label={ask}
		>
			<h2 className="text-xl font-semibold">{ask}</h2>
			{context && <p className="mt-3">{context}</p>}
			{ifYes && (
				<p className="mt-3">
					<strong>If yes:</strong> {ifYes}
				</p>
			)}
			{why && <p className="mt-3">{why}</p>}
			{stakes && <p className="mt-4 text-sm">{stakes}</p>}
			{ifYes && (
				<p className="mt-3 text-sm text-muted-foreground">
					{confidence == null
						? "Confidence not assessed"
						: `${Math.round(confidence * 100)}% sure`}
				</p>
			)}
			{status && (
				<p role="status" className="mt-3 text-sm">
					{status}
				</p>
			)}
			<fieldset disabled={Boolean(status)} className="mt-4 min-w-0 space-y-3">
				{children}
			</fieldset>
		</article>
	);
}

export function DecisionDetailsComponent({
	label = "Details",
	children,
}: {
	label?: string;
	children?: ReactNode;
}) {
	return (
		<details className="space-y-3">
			<summary className="min-h-11 cursor-pointer py-3 text-sm">
				{label}
			</summary>
			{children}
		</details>
	);
}

export function SwipeStackComponent({
	children,
	label,
}: {
	children?: ReactNode;
	label?: string | null;
}) {
	const rail = useRef<HTMLDivElement>(null);
	const move = (direction: number) => {
		const element = rail.current;
		if (element)
			element.scrollBy({
				left: direction * element.clientWidth,
				behavior: "smooth",
			});
	};
	return (
		<section
			aria-label={label ?? "Cards"}
			className="w-full min-w-0 max-w-full space-y-3"
		>
			<div className="flex justify-between gap-3">
				<button
					type="button"
					onClick={() => move(-1)}
					aria-label="Previous card"
				>
					← Previous
				</button>
				<button type="button" onClick={() => move(1)} aria-label="Next card">
					Next →
				</button>
			</div>
			<div
				ref={rail}
				tabIndex={0}
				aria-label="Use arrow keys or swipe to browse cards"
				className="flex snap-x snap-mandatory gap-4 overflow-x-auto overscroll-x-contain"
				onKeyDown={(event) => {
					if (event.target !== event.currentTarget) return;
					if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
						event.preventDefault();
						move(event.key === "ArrowRight" ? 1 : -1);
					}
				}}
			>
				{children}
			</div>
		</section>
	);
}

export function ProvenanceBadgeComponent({
	label,
	evidenceUrl,
}: {
	label?: string | null;
	evidenceUrl?: string | null;
}) {
	if (!label) return null;
	const href = safeLinkHref(evidenceUrl ?? undefined);
	return (
		<p className="text-xs text-muted-foreground">
			{label}
			{href && (
				<>
					{" "}
					·{" "}
					<a href={href} target="_blank" rel="noreferrer">
						Evidence
					</a>
				</>
			)}
		</p>
	);
}

export function DeadlineChipComponent({ value }: { value?: string | null }) {
	return value ? (
		<p className="text-xs text-muted-foreground">
			Due <time dateTime={value}>{value}</time>
		</p>
	) : null;
}

export function DraftPreviewComponent({
	body,
	recipient,
	subject,
}: {
	body?: string | null;
	recipient?: string | null;
	subject?: string | null;
}) {
	if (!body) return null;
	return (
		<section
			aria-label="Draft preview"
			className="rounded-lg border border-border p-3 text-sm"
		>
			<h3 className="font-medium">Draft</h3>
			{recipient && <p>To: {recipient}</p>}
			{subject && <p>Subject: {subject}</p>}
			<p className="mt-2 whitespace-pre-wrap break-words">{body}</p>
		</section>
	);
}

export function OptionListComponent({
	items,
}: {
	items?: { id: string; label: string; consequence?: string | null }[] | null;
}) {
	if (!items?.length) return null;
	return (
		<ul className="space-y-2 text-sm">
			{items.map((item) => (
				<li key={item.id}>
					<span className="font-medium">{item.label}</span>
					{item.consequence && <span> · {item.consequence}</span>}
				</li>
			))}
		</ul>
	);
}

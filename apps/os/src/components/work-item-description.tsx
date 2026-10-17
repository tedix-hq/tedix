import type { WorkItem } from "@tedix/api-contract/schemas/work-items";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Children, isValidElement, type ReactNode } from "react";
import {
	ChatMarkdown,
	resolveChatMarkdownHref,
} from "@/components/chat-markdown";
import { Checkbox } from "@/components/kumo/checkbox";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import { osQuery, workItemDetailQueryOptions } from "@/lib/os-query-options";
import {
	plainWorkText,
	workChecklist,
	workMarkdown,
	type WorkChecklistUpdate,
} from "@/lib/work-detail";
import { OS_COPY } from "@/shared/os-copy";

function WorkLink({
	href,
	children,
	titles,
}: {
	href: string;
	children: ReactNode;
	titles: ReadonlyMap<string, string>;
}) {
	const resolved = resolveChatMarkdownHref(href);
	const path = href.startsWith("/")
		? href
		: (() => {
				try {
					const url = new URL(href);
					return url.origin === window.location.origin ? url.pathname : "";
				} catch {
					return "";
				}
			})();
	const workId = path.match(/^\/work\/items\/([0-9a-f-]{36})(?:[/?#]|$)/i)?.[1];
	const work = useQuery({
		...workItemDetailQueryOptions(workId ?? ""),
		enabled: Boolean(workId),
		retry: false,
	});
	if (!resolved) return <span>{children}</span>;
	const raw =
		typeof children === "string" &&
		(children === href || /^(?:https?:|\/work\/items\/)/.test(children));
	let label = titles.get(href) ?? work.data?.workItem.title;
	if (!label && raw) {
		try {
			const url = new URL(href, window.location.origin);
			label = /(^|\.)notion\.(?:so|com)$/.test(url.hostname)
				? "Notion page"
				: url.hostname === "mail.google.com"
					? "Email conversation"
					: workId
						? "Linked task"
						: url.hostname;
		} catch {
			label = "Open link";
		}
	}
	return (
		<a
			href={resolved.href}
			{...(resolved.external
				? { target: "_blank", rel: "noopener noreferrer" }
				: {})}
			className="text-kumo-link underline-offset-2 hover:underline"
		>
			{label ? plainWorkText(label) : children}
		</a>
	);
}

export function WorkItemDescription({
	item,
	comments,
	content = item.description ?? "",
	interactive = true,
}: {
	item: Pick<WorkItem, "id" | "description">;
	comments: readonly WorkChecklistUpdate[];
	content?: string;
	interactive?: boolean;
}) {
	const client = useQueryClient();
	const sources = useQuery({
		...osQuery.workItems.listWorkItemSources.queryOptions({
			input: { workItemId: item.id, limit: 100 },
		}),
		retry: false,
		staleTime: 60_000,
	});
	const titles = new Map(
		(sources.data?.data ?? []).flatMap((source) =>
			source.externalUrl && source.title
				? [[source.externalUrl, source.title] as const]
				: [],
		),
	);
	const tasks = workChecklist(content, comments);
	const save = useMutation({
		mutationFn: async ({
			key,
			checked,
			text,
		}: {
			key: string;
			checked: boolean;
			text: string;
		}) => {
			await osApi.workItems.addComment({
				id: item.id,
				body: checked
					? OS_COPY.work.checked(plainWorkText(text))
					: OS_COPY.work.unchecked(plainWorkText(text)),
				metadata: { workChecklist: { key, checked } },
			});
			await client.invalidateQueries({
				queryKey: workItemDetailQueryOptions(item.id).queryKey,
			});
		},
	});
	const components = {
		a: ({ href, children }: { href?: string; children?: ReactNode }) => (
			<WorkLink href={href ?? ""} titles={titles}>
				{children}
			</WorkLink>
		),
	};
	return (
		<div className="grid min-w-0 gap-2">
			<ChatMarkdown
				content={workMarkdown(content)}
				components={{
					...components,
					p: ({ children }) => (
						<p className="my-[0.4em] whitespace-pre-line first:mt-0 last:mb-0">
							{children}
						</p>
					),
					li: ({ node, className, children }) => {
						const task =
							interactive && className?.includes("task-list-item")
								? tasks.find((task) => task.line === node?.position?.start.line)
								: undefined;
						return task ? (
							<li className="my-2 list-none">
								<Checkbox
									label={
										<ChatMarkdown
											content={workMarkdown(task.text)}
											components={components}
										/>
									}
									checked={task.checked}
									disabled={save.isPending}
									onCheckedChange={(checked) =>
										save.mutate({ ...task, checked })
									}
								/>
								{Children.toArray(children).filter(
									(child) =>
										isValidElement<{ node?: { tagName?: string } }>(child) &&
										(child.props.node?.tagName === "ul" ||
											child.props.node?.tagName === "ol"),
								)}
							</li>
						) : (
							<li className="my-[0.2em]">{children}</li>
						);
					},
				}}
			/>
			{save.isError ? (
				<Text as="p" role="label" tone="error">
					{OS_COPY.work.checklistError}
				</Text>
			) : null}
		</div>
	);
}

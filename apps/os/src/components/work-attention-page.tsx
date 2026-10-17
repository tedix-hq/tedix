import { ATTENTION_COPY } from "@tedix/api-contract/utils/attention-copy";
import { useAppWebMcpTools } from "@/lib/webmcp/use-app-webmcp-tools";
import { buildAttentionWebMcpTools } from "@/components/attention-webmcp-tools";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { SupportAttention } from "@/components/support-attention";
import { AttentionBoard } from "@/components/attention-live-view";
import { Alert, AlertTitle, AlertDescription } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Link } from "@/components/kumo/link";
import {
	Page,
	PageHeader,
	PageHeading,
	PageTitle,
	PageDescription,
} from "@/components/kumo/page";
import { Text } from "@/components/kumo/text";
import { osApi, OS_USES_FIXTURES } from "@/lib/api";
import {
	workAttentionQueryOptions,
	attentionLayoutQueryOptions,
	osQueryKeys,
} from "@/lib/os-query-options";
import {
	getSharedCapnSessionHub,
	type CapnSessionLeaseHandle,
} from "@/lib/capn-session-hub";
import { connectCapnSocket } from "@/lib/capn-chat-machine";
import { useDocumentTitle } from "@/lib/use-document-title";
import type { AttentionLayout } from "@tedix/api-contract/schemas/attention-layout";

export function AttentionApp({ workspaceId }: { workspaceId?: string }) {
	const cache = useQueryClient();
	const [lease, setLease] = useState<CapnSessionLeaseHandle | null>(null);
	const [previousVisitAt, setPreviousVisitAt] = useState<string | null>(null);
	useEffect(() => {
		if (OS_USES_FIXTURES) return;
		const current = getSharedCapnSessionHub({
			connect: connectCapnSocket,
		}).lease();
		setLease(current);
		return () => current.release();
	}, []);
	useEffect(() => {
		let alive = true;
		let hiddenAt = 0;
		const visit = () => {
			void osApi.workAgentSessions
				.visitAttention({})
				.then((r) => {
					if (alive) setPreviousVisitAt(r.previousVisitAt);
				})
				.catch(() => {});
		};
		visit();
		const visibility = () => {
			if (document.hidden) hiddenAt = Date.now();
			else if (hiddenAt && Date.now() - hiddenAt > 60_000) {
				visit();
				hiddenAt = 0;
			}
		};
		const checkpoint = setInterval(() => {
			if (!document.hidden)
				void osApi.workAgentSessions.visitAttention({}).catch(() => {});
		}, 60_000);
		document.addEventListener("visibilitychange", visibility);
		return () => {
			alive = false;
			clearInterval(checkpoint);
			document.removeEventListener("visibilitychange", visibility);
		};
	}, []);
	const query = useQuery({
		...workAttentionQueryOptions(workspaceId),
		queryFn: async () => {
			if (OS_USES_FIXTURES)
				return osApi.workAgentSessions.attention({
					utcOffsetMinutes: new Date().getTimezoneOffset(),
					workspaceId,
				});
			if (!lease) throw new Error(ATTENTION_COPY.connectionStarting);
			const { root } = await lease.session();
			return root.readAttention(new Date().getTimezoneOffset(), workspaceId);
		},
		enabled: OS_USES_FIXTURES || !!lease,
		refetchInterval: 2000,
		retry: false,
	});
	const layout = useQuery({
		...attentionLayoutQueryOptions(),
		refetchInterval: 5000,
	});
	const save = useMutation({
		mutationFn: (value: AttentionLayout) =>
			osApi.workAgentSessions.updateAttentionLayout({
				layout: value,
				expectedRevision: layout.data!.revision,
			}),
		onSuccess: (result) => {
			cache.setQueryData(attentionLayoutQueryOptions().queryKey, result);
		},
		onError: () => {
			void cache.invalidateQueries(attentionLayoutQueryOptions());
		},
	});
	useAppWebMcpTools(
		"attention",
		{
			layout: layout.data?.layout ?? null,
			save: (value: AttentionLayout) => save.mutateAsync(value),
		},
		buildAttentionWebMcpTools,
		[],
	);
	const filing = useMutation({
		mutationFn: ({ id, projectId }: { id: string; projectId: string }) =>
			osApi.workAgentSessions.fileRequest({ id, projectId }),
		onSuccess: async () => {
			await Promise.all([
				cache.invalidateQueries(workAttentionQueryOptions(workspaceId)),
				cache.invalidateQueries({
					queryKey: osQueryKeys.agentSessionRequests(),
				}),
			]);
		},
	});
	return (
		<div className="min-w-0 space-y-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<Text tone="secondary">{ATTENTION_COPY.together}</Text>
				<Badge variant={query.isError ? "warning" : "info"}>
					{query.isError
						? ATTENTION_COPY.updatesPaused
						: !query.data
							? ATTENTION_COPY.connecting
							: ATTENTION_COPY.live}
				</Badge>
			</div>
			{query.isError && (
				<Alert variant="destructive">
					<AlertTitle>{ATTENTION_COPY.updatesPaused}</AlertTitle>
					<AlertDescription>{ATTENTION_COPY.reconnecting}</AlertDescription>
				</Alert>
			)}
			{(filing.isError || save.isError || layout.isError) && (
				<Alert variant="destructive">
					<AlertTitle>{ATTENTION_COPY.saveFailed}</AlertTitle>
					<AlertDescription>
						{filing.error?.message ||
							save.error?.message ||
							layout.error?.message}
					</AlertDescription>
				</Alert>
			)}
			{query.data ? (
				<AttentionBoard
					data={query.data}
					layout={layout.data?.layout}
					saveLayout={layout.data ? (value) => save.mutate(value) : undefined}
					saving={save.isPending}
					previousVisitAt={previousVisitAt}
					filing={filing.isPending}
					file={(id, projectId) => filing.mutate({ id, projectId })}
				/>
			) : (
				<Text>{ATTENTION_COPY.loading}</Text>
			)}
		</div>
	);
}
export function WorkAttentionPage() {
	useDocumentTitle(ATTENTION_COPY.documentTitle);
	return (
		<Page width="xl">
			<PageHeader>
				<PageHeading>
					<PageTitle>{ATTENTION_COPY.pageTitle}</PageTitle>
					<PageDescription>{ATTENTION_COPY.description}</PageDescription>
				</PageHeading>
				<Link href="#attention-unfiled">{ATTENTION_COPY.reviewUnfiled}</Link>
			</PageHeader>
			<AttentionApp />
			<SupportAttention />
		</Page>
	);
}

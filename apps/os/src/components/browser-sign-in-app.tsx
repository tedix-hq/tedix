import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BrowserSignInConfig } from "@tedix/api-contract/schemas/os-browser-sign-in";
import { LoadError } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import {
	PageSection,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import { osQuery } from "@/lib/os-query-options";
import { errorMessage } from "@/lib/orpc-error";
import { useTediName } from "@/lib/use-tedi-names";
import { useOsOperationalContext } from "@/lib/use-os-preferences";

const formatTime = (iso: string) =>
	new Date(iso).toLocaleString(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	});

/** The approver's member name, or their sign-in id when it is not listed. */
function useApproverName(principal: string | null | undefined) {
	const organizationId = useOsOperationalContext().data?.organization.id;
	const members = useQuery({
		...osQuery.members.listMembers.queryOptions({
			input: {
				organizationId: organizationId ?? "",
				status: "active",
				limit: 100,
				offset: 0,
			},
		}),
		enabled: Boolean(organizationId && principal),
		staleTime: 60_000,
	});
	if (!principal) return "Unknown";
	const member = members.data?.data.find(
		(m) => m.userId === principal || m.descopeUserId === principal,
	);
	return member?.name || member?.email || principal;
}

export function BrowserSignInApp({ config }: { config: BrowserSignInConfig }) {
	const cache = useQueryClient();
	const tediName = useTediName(config.tediId) ?? "This tedi";
	const options = osQuery.tediApprovals.getBrowserLoginSession.queryOptions({
		input: { tediId: config.tediId },
	});
	// The tedi ends an expired sign-in when it is next read, so poll gently.
	const session = useQuery({ ...options, refetchInterval: 60_000 });
	const login = session.data?.login ?? null;
	const approver = useApproverName(login?.principal);
	const end = useMutation({
		mutationFn: () =>
			osApi.tediApprovals.endBrowserLoginSession({ tediId: config.tediId }),
		onSuccess: () => cache.setQueryData(options.queryKey, { login: null }),
	});
	return (
		<PageSection aria-label="Browser sign-in">
			<SectionHeader>
				<SectionHeading>
					<SectionTitle>Browser sign-in</SectionTitle>
					<SectionDescription>
						{tediName} can reuse a sign-in a person completed in its browser
						until it expires. End it to discard the browser's cookies; the tedi
						must then ask for a new takeover to sign in again.
					</SectionDescription>
				</SectionHeading>
			</SectionHeader>
			{session.isPending ? (
				<Text>Checking the browser sign-in…</Text>
			) : session.isError ? (
				<LoadError
					title="The browser sign-in couldn't be checked"
					error={session.error}
					onRetry={() => session.refetch()}
					retrying={session.isFetching}
				/>
			) : !login ? (
				<p role="status">
					{end.isSuccess
						? "Sign-in ended. The browser and its cookies were discarded."
						: `${tediName} has no active browser sign-in.`}
				</p>
			) : (
				<div className="grid gap-3">
					<dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2">
						<dt>Approved by</dt>
						<dd>{approver}</dd>
						<dt>Sites</dt>
						<dd>
							{login.siteHosts.length > 0
								? login.siteHosts.join(", ")
								: "Not recorded"}
						</dd>
						<dt>Approved</dt>
						<dd>{formatTime(login.approvedAt)}</dd>
						<dt>Expires</dt>
						<dd>{formatTime(login.expiresAt)}</dd>
						{login.reason ? (
							<>
								<dt>Reason</dt>
								<dd>{login.reason}</dd>
							</>
						) : null}
					</dl>
					<div>
						<Button
							variant="destructive"
							disabled={end.isPending}
							onClick={() => end.mutate()}
						>
							{end.isPending ? "Ending session…" : "End session"}
						</Button>
					</div>
					{end.isError ? (
						<p role="alert">
							The session could not be ended: {errorMessage(end.error)}
						</p>
					) : null}
				</div>
			)}
		</PageSection>
	);
}

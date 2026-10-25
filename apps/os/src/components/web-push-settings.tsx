import { Bell } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { osApi } from "@/lib/api";
import { osQuery, projectListQueryOptions } from "@/lib/os-query-options";
import { Button } from "@/components/kumo/button";
import { Switch } from "@/components/kumo/switch";
import { Text } from "@/components/kumo/text";
import {
	PageSection,
	SectionHeading,
	SectionTitle,
	SectionDescription,
} from "@/components/kumo/page";
import { SettingsRow, SettingsRows } from "@/components/settings-row";

export function WebPushSettings() {
	const cache = useQueryClient();
	const status = useQuery(
		osQuery.webPush.getStatus.queryOptions({ input: {} }),
	);
	const projects = useQuery(projectListQueryOptions(100));
	const [subscribed, setSubscribed] = useState(false);
	const supported =
		"serviceWorker" in navigator &&
		"PushManager" in window &&
		"Notification" in window;
	useEffect(() => {
		if (supported)
			void navigator.serviceWorker
				.getRegistration()
				.then(async (registration) => {
					setSubscribed(!!(await registration?.pushManager.getSubscription()));
				})
				.catch(() => undefined);
	}, [supported]);
	const device = useMutation({
		mutationFn: async () => {
			if (subscribed) {
				const registration = await navigator.serviceWorker.getRegistration();
				const subscription = await registration?.pushManager.getSubscription();
				if (subscription) {
					await osApi.webPush.unsubscribe({ endpoint: subscription.endpoint });
					await subscription.unsubscribe();
				}
				setSubscribed(false);
				return;
			}
			// Called only by the person's click, including on installed iOS PWAs.
			if ((await Notification.requestPermission()) !== "granted")
				throw new Error(
					"Allow notifications in your browser or device settings to enable push.",
				);
			const registration = await navigator.serviceWorker.register("/sw.js", {
				scope: "/",
			});
			await navigator.serviceWorker.ready;
			const key = status.data?.publicKey;
			if (!key)
				throw new Error("Push is not configured for this installation.");
			const subscription = await registration.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: key,
			});
			const json = subscription.toJSON();
			if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth)
				throw new Error("The browser did not provide a push subscription.");
			const result = await osApi.webPush.subscribe({
				endpoint: json.endpoint,
				expirationTime: json.expirationTime ?? null,
				keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
			});
			if (!result.enabled) {
				await subscription.unsubscribe();
				throw new Error("Push is not configured for this installation.");
			}
			setSubscribed(true);
		},
	});
	const mute = useMutation({
		mutationFn: (input: { mutedProjectIds: string[] }) =>
			osApi.webPush.setPreferences(input),
		onSuccess: () =>
			cache.invalidateQueries({ queryKey: osQuery.webPush.getStatus.key() }),
	});
	return (
		<PageSection>
			<SectionHeading>
				<SectionTitle>Push notifications</SectionTitle>
				<SectionDescription>
					Approvals, requests for input, and runs you started. Open
					conversations stay quiet.
				</SectionDescription>
			</SectionHeading>
			<SettingsRows>
				<SettingsRow
					icon={Bell}
					title="This device"
					description={
						!supported
							? "Push is unavailable in this browser. On iPhone, open Tedix from your Home Screen."
							: status.data?.enabled
								? "Enable notifications for this browser or installed app."
								: "Push is not configured for this installation."
					}
				>
					<Button
						disabled={
							!supported ||
							(!subscribed && !status.data?.enabled) ||
							device.isPending
						}
						onClick={() => device.mutate()}
						size="sm"
					>
						{subscribed ? "Disable notifications" : "Enable notifications"}
					</Button>
				</SettingsRow>
				{(projects.data?.data ?? []).map((project) => (
					<SettingsRow
						icon={Bell}
						key={project.id}
						title={project.name}
						description="Mute run updates; approval requests stay enabled."
					>
						<Switch
							aria-label={`Mute ${project.name}`}
							checked={
								status.data?.preferences.mutedProjectIds.includes(project.id) ??
								false
							}
							disabled={!status.data || mute.isPending}
							onCheckedChange={(checked) => {
								const ids = status.data?.preferences.mutedProjectIds ?? [];
								mute.mutate({
									mutedProjectIds: checked
										? [...new Set([...ids, project.id])]
										: ids.filter((id) => id !== project.id),
								});
							}}
						/>
					</SettingsRow>
				))}
			</SettingsRows>
			{(device.error || mute.error || status.error) && (
				<Text role="label" tone="secondary">
					{device.error?.message ??
						mute.error?.message ??
						"Push settings could not be loaded."}
				</Text>
			)}
		</PageSection>
	);
}

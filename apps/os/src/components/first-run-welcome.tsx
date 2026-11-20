import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { modelsForNewSelection } from "@/lib/model-selection";
import { AppRuntimeFrame } from "@/components/app-runtime-frame";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/kumo/dialog";
import { osApi } from "@/lib/api";
import {
	DESKTOP_SETUP_LINK,
	latestMacDownload,
	MAC_FIRST_OPEN_NOTE,
	MAC_SETUP_LINES,
	thisComputer,
} from "@/lib/this-computer";
import { buildAppRuntimeDocument } from "@/lib/app-runtime-host";
import type { AppRuntimeHostResult } from "@/lib/app-runtime-protocol";
import {
	modelCatalogQueryOptions,
	operationalContextQueryOptions,
	userPreferencesQueryOptions,
	userProfileQueryOptions,
} from "@/lib/os-query-options";
import kit from "../../../../plugins/tedix/skills/tedix-build-app/assets/ui-kit.js?raw";
import client from "@/gadgets/welcome/client.js?raw";

const html = buildAppRuntimeDocument({ "client.js": `${kit}\n${client}` });

/**
 * The first-run steps: name, model, tools, this computer, then "You're ready".
 * The shell mounts it, and it is the only Get started dialog open at a time.
 */
export function FirstRunWelcome({ onDone }: { onDone: () => void }) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const complete = useMutation({
		mutationFn: () => osApi.userProfile.completeWelcome({}),
		onSuccess: async () => {
			queryClient.setQueryData(userProfileQueryOptions().queryKey, (profile) =>
				profile ? { ...profile, welcomeCompleted: true } : profile,
			);
			onDone();
			await navigate({ to: "/chat", search: {}, replace: true });
		},
	});

	const onCall = async (
		method: unknown,
		args: unknown,
	): Promise<AppRuntimeHostResult> => {
		try {
			if (method === "welcome.config") {
				const [profile, catalog, preferences, context] = await Promise.all([
					queryClient.fetchQuery(userProfileQueryOptions()),
					queryClient.fetchQuery(modelCatalogQueryOptions()).catch(() => null),
					queryClient
						.fetchQuery(userPreferencesQueryOptions())
						.catch(() => null),
					queryClient
						.fetchQuery(operationalContextQueryOptions())
						.catch(() => null),
				]);
				return {
					ok: true,
					value: {
						name: profile.name,
						email: profile.email,
						organization: context?.organization.name,
						models: modelsForNewSelection(
							catalog?.models.filter((model) => model.allowed) ?? [],
						).map((model) => ({ ref: model.ref, label: model.label })),
						modelRef: preferences?.preferences.conversationModelRef,
						computer: thisComputer(),
						macSetupLines: MAC_SETUP_LINES,
						macFirstOpenNote: MAC_FIRST_OPEN_NOTE,
					},
				};
			}
			if (method === "welcome.computer") {
				if (thisComputer() === "desktop-app") {
					window.location.assign(DESKTOP_SETUP_LINK);
					return { ok: true, value: { state: "opened" } };
				}
				const download = await latestMacDownload();
				const chip =
					args && typeof args === "object" && "chip" in args ? args.chip : null;
				const file =
					chip === "appleSilicon"
						? download.appleSilicon
						: chip === "intel"
							? download.intel
							: download.forThisMac;
				// The browser did not say which Mac this is: the step asks.
				if (!file) return { ok: true, value: { state: "choose" } };
				window.location.assign(file);
				return {
					ok: true,
					value: { state: "downloading", version: download.version },
				};
			}
			if (method === "welcome.profile") {
				if (
					!args ||
					typeof args !== "object" ||
					!("name" in args) ||
					typeof args.name !== "string"
				)
					return { ok: false, error: "bad_arguments" };
				const profile = await queryClient.fetchQuery(userProfileQueryOptions());
				const saved = await osApi.userProfile.updateMine({
					name: args.name,
					expectedRevision: profile.revision,
				});
				queryClient.setQueryData(userProfileQueryOptions().queryKey, saved);
				return { ok: true, value: null };
			}
			if (method === "welcome.model") {
				if (
					!args ||
					typeof args !== "object" ||
					!("ref" in args) ||
					(args.ref !== null && typeof args.ref !== "string")
				)
					return { ok: false, error: "bad_arguments" };
				const catalog = await queryClient.fetchQuery(
					modelCatalogQueryOptions(),
				);
				if (
					args.ref !== null &&
					!modelsForNewSelection(
						catalog.models.filter((model) => model.allowed),
					).some((model) => model.ref === args.ref)
				)
					return { ok: false, error: "not_permitted" };
				const current = await osApi.userSettings.getPreferences({});
				const saved = await osApi.userSettings.updatePreferences({
					expectedRevision: current.revision,
					preferences: {
						...current.preferences,
						conversationModelRef: args.ref,
					},
				});
				queryClient.setQueryData(userPreferencesQueryOptions().queryKey, saved);
				return { ok: true, value: null };
			}
			if (method === "welcome.complete") {
				await complete.mutateAsync();
				return { ok: true, value: null };
			}
			return { ok: false, error: "unknown_method" };
		} catch (error) {
			return {
				ok: false,
				error: "host_unavailable",
				detail:
					error instanceof Error
						? error.message
						: "Could not save. Please try again.",
			};
		}
	};

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !complete.isPending) complete.mutate();
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Welcome to Tedix</DialogTitle>
					<DialogDescription>
						A platform for agents, apps, and work. Four short steps; skip any
						and finish later from Get started.
					</DialogDescription>
				</DialogHeader>
				<AppRuntimeFrame html={html} title="Tedix welcome" onCall={onCall} />
				{complete.isError ? (
					<p role="alert">
						Your welcome was not saved. Check your connection and try again.
					</p>
				) : null}
			</DialogContent>
		</Dialog>
	);
}

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
	OsGadget,
	OsGadgetRevision,
} from "@tedix/api-contract/schemas/os-workspaces";
import { osApi } from "@/lib/api";
import {
	workAppsQueryOptions,
	canvasGadgetDetailQueryOptions,
} from "@/lib/os-query-options";
import { Button } from "./kumo/button";
import {
	Dialog,
	DialogContent,
	DialogTitle,
	DialogTrigger,
} from "./kumo/dialog";
import { Link } from "./kumo/link";

export function WorkAppearance({
	role,
	gadget,
	revision,
}: {
	role: "feed" | "deck";
	gadget: OsGadget;
	revision: OsGadgetRevision;
}) {
	const [open, setOpen] = useState(false);
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger render={<Button variant="ghost" />}>
				Customize
			</DialogTrigger>
			{open && (
				<AppearanceForm
					role={role}
					gadget={gadget}
					revision={revision}
					close={() => setOpen(false)}
				/>
			)}
		</Dialog>
	);
}

function AppearanceForm({
	role,
	gadget,
	revision,
	close,
}: {
	role: "feed" | "deck";
	gadget: OsGadget;
	revision: OsGadgetRevision;
	close: () => void;
}) {
	const [basis] = useState(revision);
	const feed = role === "feed";
	const field = feed ? "postsPerPage" : "cardLayout";
	const [value, setValue] = useState(
		String(basis.manifest.config?.[field] ?? (feed ? 6 : "full")),
	);
	const client = useQueryClient();
	const { workspaceId, id: gadgetId } = gadget;
	const valid = feed
		? Number.isInteger(Number(value)) &&
			Number(value) >= 1 &&
			Number(value) <= 50
		: ["full", "compact"].includes(value);
	const save = useMutation({
		mutationFn: () =>
			osApi.osWorkspaces.gadgets.revise({
				workspaceId,
				gadgetId,
				expectedRevision: basis.revision,
				manifest: {
					...basis.manifest,
					config: {
						...basis.manifest.config,
						[field]: feed ? Number(value) : value,
					},
				},
			}),
		onSettled: async () => {
			await Promise.all([
				client.invalidateQueries(workAppsQueryOptions()),
				client.invalidateQueries(
					canvasGadgetDetailQueryOptions(workspaceId, gadgetId),
				),
			]);
		},
		onSuccess: close,
	});
	return (
		<DialogContent size="sm">
			<DialogTitle>
				{feed
					? "Activity for your organization"
					: "Decision cards for your organization"}
			</DialogTitle>
			<form
				className="grid gap-4"
				onSubmit={(e) => {
					e.preventDefault();
					if (valid && !save.isPending) save.mutate();
				}}
			>
				<label className="grid gap-1">
					{feed ? "Posts to show at a time" : "Default card layout"}
					{feed ? (
						<input
							className="rounded-md border border-kumo-line p-2"
							type="number"
							required
							min={1}
							max={50}
							value={value}
							onChange={(e) => setValue(e.target.value)}
						/>
					) : (
						<select
							className="rounded-md border border-kumo-line bg-kumo-base p-2"
							value={value}
							onChange={(e) => setValue(e.target.value)}
						>
							<option value="full">Full</option>
							<option value="compact">Compact</option>
						</select>
					)}
				</label>
				{save.error && <p role="alert">{save.error.message}</p>}
				<div className="flex items-center justify-between">
					<Link
						href={`/workspace/${workspaceId}?workpiece=gadget:${gadgetId}&pane=workpiece`}
					>
						Open gadget
					</Link>
					<Button type="submit" disabled={!valid || save.isPending}>
						Save
					</Button>
				</div>
			</form>
		</DialogContent>
	);
}

export function InstallWorkAppearance() {
	const client = useQueryClient();
	const install = useMutation({
		mutationFn: () => osApi.osWorkspaces.gadgets.installWorkDefaults({}),
		onSuccess: () => client.invalidateQueries(workAppsQueryOptions()),
	});
	return (
		<div>
			{install.data ? (
				<Link href={`/workspace/${install.data.workspaceId}`}>
					Open Work workspace
				</Link>
			) : (
				<Button
					variant="ghost"
					disabled={install.isPending}
					onClick={() => install.mutate()}
				>
					Set up Work apps
				</Button>
			)}
			{install.error && <p role="alert">{install.error.message}</p>}
		</div>
	);
}

import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useState, type ReactNode } from "react";
import { isAppRuntimeManifest } from "@tedix/api-contract/utils/app-runtime";
import { canvasGadgetDetailQueryOptions } from "@/lib/os-query-options";
import { AppLoading } from "./app-loading";
import { Button } from "./kumo/button";

const RuntimeView = lazy(() =>
	import("./app-runtime-panel").then((module) => ({
		default: module.AppRuntimePreview,
	})),
);

export function WorkGadgetPresentation({
	workspaceId,
	gadgetId,
	standardView,
}: {
	workspaceId: string;
	gadgetId: string;
	standardView: ReactNode;
}) {
	const [standard, setStandard] = useState(false);
	const query = useQuery(canvasGadgetDetailQueryOptions(workspaceId, gadgetId));
	if (query.isPending) return <AppLoading />;
	const gadget = query.data?.gadget;
	const revision = query.data?.currentRevision;
	if (
		query.isError ||
		gadget?.status !== "active" ||
		!revision ||
		!isAppRuntimeManifest(revision.manifest)
	)
		return <>{standardView}</>;
	return (
		<>
			<Button variant="ghost" onClick={() => setStandard(!standard)}>
				{standard ? "Show custom view" : "Show standard view"}
			</Button>
			{standard ? (
				standardView
			) : (
				<Suspense fallback={<AppLoading />}>
					<RuntimeView
						workspaceId={workspaceId}
						gadget={gadget}
						revision={revision}
						layout="content"
					/>
				</Suspense>
			)}
		</>
	);
}

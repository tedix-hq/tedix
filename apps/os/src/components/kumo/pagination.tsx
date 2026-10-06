import { Pagination as KumoPagination } from "@cloudflare/kumo/components/pagination";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * App-local entrypoint for Kumo pagination. Keeping this adapter local lets
 * Tedix preserve TanStack-controlled state while inheriting Cloudflare's
 * compact input-group controls and accessible navigation labels.
 */
function PaginationRoot(props: ComponentProps<typeof KumoPagination>) {
	return <KumoPagination {...props} />;
}

function PaginationControls(
	props: ComponentProps<typeof KumoPagination.Controls>,
) {
	return (
		<KumoPagination.Controls
			{...props}
			className={cn(
				"max-sm:[&_button]:min-h-11 max-sm:[&_button]:min-w-11 coarse:[&_button]:min-h-11 coarse:[&_button]:min-w-11",
				props.className,
			)}
		/>
	);
}

const Pagination = Object.assign(PaginationRoot, {
	Info: KumoPagination.Info,
	PageSize: KumoPagination.PageSize,
	Controls: PaginationControls,
	Separator: KumoPagination.Separator,
});

export { Pagination };

import { Box, Text, useBoxMetrics, useInput, type DOMElement } from "ink";
import { useLayoutEffect, useRef, useState } from "react";
import { THEME_HEX } from "./theme";

/** Full decision text stays in the native layout tree; only its viewport moves. */
export function DecisionDetail({
	text,
	height,
	screenReader = false,
	backHint = "Ctrl-O/Esc back",
}: {
	text: string;
	height: number;
	screenReader?: boolean;
	backHint?: string;
}) {
	const contentRef = useRef<DOMElement>(null);

	const [offset, setOffset] = useState(0);
	const { height: totalRows } = useBoxMetrics(contentRef);
	const viewportRows = Math.max(1, height - 1);
	const maxOffset = Math.max(0, totalRows - viewportRows);

	useLayoutEffect(() => {
		setOffset((previous) => Math.min(previous, maxOffset));
	}, [maxOffset]);
	useInput(
		(_input, key) => {
			if (key.pageUp || key.pageDown || key.upArrow || key.downArrow) {
				const step = key.pageUp || key.pageDown ? viewportRows : 1;
				setOffset((previous) =>
					Math.max(
						0,
						Math.min(
							maxOffset,
							previous + (key.pageUp || key.upArrow ? -step : step),
						),
					),
				);
			}
		},
		{ isActive: !screenReader },
	);
	return (
		<Box flexDirection="column" flexShrink={0}>
			<Box
				flexDirection="column"
				height={screenReader ? undefined : viewportRows}
				overflow={screenReader ? undefined : "hidden"}
				contentOffsetY={screenReader ? 0 : offset}
			>
				<Box ref={contentRef} flexDirection="column" flexShrink={0}>
					<Text>{text}</Text>
				</Box>
			</Box>
			<Text color={THEME_HEX.faint} wrap="truncate">
				{screenReader
					? `${backHint} · return to interaction`
					: `${backHint} · PgUp/PgDn · Details ${offset + 1}–${Math.min(totalRows, offset + viewportRows)}/${totalRows}`}
			</Text>
		</Box>
	);
}

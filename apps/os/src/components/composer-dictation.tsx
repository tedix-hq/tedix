import { Square, X } from "@phosphor-icons/react";
import {
	VOICE_WAVE_BAR_COUNT,
	voiceWaveBarHeight,
} from "@tedix/chat-transport/voice-composer";
import { Button } from "@/components/kumo/button";
import { Loader } from "@/components/kumo/loader";
import { cn } from "@/lib/utils";
import type { ComposerDictationState } from "@/lib/use-composer-dictation";

/**
 * What a chat composer shows in place of its message box while dictation
 * connects, listens or transcribes: Cancel, the live wave, and Stop.
 */
export function DictationCapture({
	dictation,
	className,
}: {
	dictation: ComposerDictationState;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"chat-voice-capture flex min-h-14 items-center gap-3 px-3",
				className,
			)}
			role="status"
			aria-label={
				dictation.phase === "connecting"
					? "Connecting microphone"
					: dictation.phase === "recording"
						? "Listening"
						: "Transcribing"
			}
		>
			<Button
				type="button"
				size="icon-sm"
				variant="ghost"
				aria-label="Cancel dictation"
				onClick={dictation.cancel}
				icon={<X size={16} />}
			/>
			{dictation.phase === "recording" ? (
				<div className="chat-voice-wave" aria-hidden="true">
					{Array.from({ length: VOICE_WAVE_BAR_COUNT }, (_, index) => (
						<i
							key={index}
							style={{
								height: `${voiceWaveBarHeight(dictation.audioHistory[index] ?? 0)}px`,
							}}
						/>
					))}
				</div>
			) : (
				<div className="flex flex-1 justify-center">
					<Loader size="sm" />
				</div>
			)}
			{dictation.phase === "recording" ? (
				<Button
					type="button"
					size="icon-sm"
					aria-label="Stop and transcribe"
					onClick={dictation.stop}
					icon={<Square size={14} weight="fill" />}
				/>
			) : null}
		</div>
	);
}

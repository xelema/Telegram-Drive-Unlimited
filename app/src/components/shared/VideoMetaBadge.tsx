import { Clock, Maximize } from 'lucide-react';
import { VideoMetadata } from '../../types';

interface VideoMetaBadgeProps {
    metadata: VideoMetadata | null | undefined;
    isLoading: boolean;
}

function formatDuration(secs: number): string {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    if (m >= 60) {
        const h = Math.floor(m / 60);
        const rm = m % 60;
        return `${h}:${String(rm).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
}

export function VideoMetaBadge({ metadata, isLoading }: VideoMetaBadgeProps) {
    if (isLoading) return null; // don't flash a loading indicator inline
    if (!metadata) return null;

    const hasDuration = typeof metadata.duration_secs === 'number' && metadata.duration_secs > 0;
    const hasResolution = typeof metadata.width === 'number' && metadata.width > 0;

    if (!hasDuration && !hasResolution) return null;

    return (
        <span className="inline-flex items-center gap-1.5 text-[10px] text-telegram-subtext/60 font-medium tracking-wide">
            {hasDuration && (
                <span className="flex items-center gap-0.5">
                    <Clock className="w-2.5 h-2.5" />
                    {formatDuration(metadata.duration_secs!)}
                </span>
            )}
            {hasDuration && hasResolution && <span className="opacity-40">·</span>}
            {hasResolution && (
                <span className="flex items-center gap-0.5">
                    <Maximize className="w-2.5 h-2.5" />
                    {metadata.width}×{metadata.height}
                </span>
            )}
        </span>
    );
}

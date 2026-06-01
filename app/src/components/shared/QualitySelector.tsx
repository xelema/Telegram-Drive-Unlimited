import { StreamingQuality, QUALITY_LABELS, HLS_QUALITIES, QUALITY_THROTTLE_MAP, TranscodeCapabilities, TranscodeJobPhase } from '../../types';
import { Zap, Wifi, Loader2, AlertTriangle, Check, Gauge } from 'lucide-react';

interface QualitySelectorProps {
    currentQuality: StreamingQuality;
    onChange: (quality: StreamingQuality) => void;
    adaptiveMode: boolean;
    onToggleAdaptive: () => void;
    measuredSpeedKbps?: number;
    transcodeCapabilities?: TranscodeCapabilities | null;
    variantStates?: Record<string, TranscodeJobPhase>;
    sourceHeight?: number | null;
}

const QUALITIES: StreamingQuality[] = ['360p', '480p', '720p', '1080p', 'original'];

export function QualitySelector({
    currentQuality,
    onChange,
    adaptiveMode,
    onToggleAdaptive,
    measuredSpeedKbps,
    transcodeCapabilities,
    variantStates = {},
    sourceHeight = null,
}: QualitySelectorProps) {
    const handleManualQuality = (quality: StreamingQuality) => {
        if (adaptiveMode) onToggleAdaptive();
        onChange(quality);
    };

    const isTranscodeAvailable = transcodeCapabilities?.available ?? false;

    // Human-readable throttle label (e.g. "500k", "1M", "2.5M")
    const throttleLabel = (quality: StreamingQuality): string => {
        if (quality === 'original') return QUALITY_LABELS[quality];
        const kbps = QUALITY_THROTTLE_MAP[quality];
        if (kbps >= 1000) return `${(kbps / 1000).toFixed(kbps % 1000 === 0 ? 0 : 1)}M`;
        return `${kbps}k`;
    };

    return (
        <div className="flex items-center gap-2 bg-black/50 backdrop-blur-sm rounded-lg px-2 py-1.5 border border-white/10">
            {/* Adaptive toggle */}
            <button
                onClick={onToggleAdaptive}
                className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-all duration-200 ${
                    adaptiveMode
                        ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                        : 'text-white/40 hover:text-white/70 border border-transparent'
                }`}
                title={adaptiveMode
                    ? 'Adaptive mode: ON — auto-adjusts quality'
                    : isTranscodeAvailable
                        ? 'Adaptive mode: OFF — manual quality'
                        : 'Adaptive mode disabled (requires FFmpeg/HLS)'}
                disabled={!isTranscodeAvailable}
            >
                <Wifi className="w-3 h-3" />
                Auto
            </button>

            {/* Divider */}
            <div className="w-px h-5 bg-white/15" />

            {/* Quality presets */}
            {QUALITIES.map(quality => {
                const isActive = currentQuality === quality;
                const isHls = HLS_QUALITIES.includes(quality);
                const variantState: TranscodeJobPhase = variantStates[quality] ?? 'idle';
                const canTranscode = isTranscodeAvailable && isHls;

                // Upscale prevention: disable qualities that exceed source resolution
                const qualityHeight = quality === 'original' ? Infinity : parseInt(quality);
                const isUpscale = sourceHeight !== null && quality !== 'original' && qualityHeight > sourceHeight;
                const isDisabled = (isHls && !canTranscode) || isUpscale;

                let statusIcon: React.ReactNode = null;

                if (isHls && variantState === 'preparing') {
                    statusIcon = <Loader2 className="w-3 h-3 animate-spin" />;
                } else if (isHls && (variantState === 'caching' || variantState === 'transcoding')) {
                    statusIcon = <Loader2 className="w-3 h-3 animate-spin" />;
                } else if (variantState === 'ready') {
                    statusIcon = <Check className="w-3 h-3 text-emerald-400" />;
                } else if (variantState === 'failed') {
                    statusIcon = <AlertTriangle className="w-3 h-3 text-red-400" />;
                } else if (isHls && !canTranscode) {
                    statusIcon = <Gauge className="w-3 h-3 text-white/30" />;
                }

                const tooltipHint = quality === 'original'
                    ? 'Stream original file'
                    : isUpscale
                        ? `Source is ${sourceHeight}p; ${quality} upscale disabled`
                        : canTranscode
                        ? variantState === 'preparing'
                            ? `Preparing ${quality}...`
                            : variantState === 'caching'
                                ? 'Downloading source...'
                                : variantState === 'transcoding'
                                    ? `Transcoding to ${quality}...`
                                    : variantState === 'ready'
                                        ? `${quality} ready (HLS)`
                                        : variantState === 'failed'
                                            ? `${quality} transcode failed — click to retry`
                                            : `Switch to ${quality} (HLS transcoding)`
                        : `Bandwidth cap: ${throttleLabel(quality)} — resolution unchanged`;

                return (
                    <button
                        key={quality}
                        onClick={() => handleManualQuality(quality)}
                        className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium transition-all duration-200 ${
                            isActive
                                ? 'bg-telegram-primary/20 text-telegram-primary border border-telegram-primary/30'
                                : adaptiveMode
                                    ? 'text-white/35 hover:text-white/80 hover:bg-white/5 border border-transparent'
                                    : isDisabled
                                        ? 'text-white/25 hover:text-white/50 hover:bg-white/5 border border-white/5 opacity-50 cursor-not-allowed'
                                        : 'text-white/50 hover:text-white/80 hover:bg-white/5 border border-transparent'
                        }`}
                        title={tooltipHint}
                        disabled={isDisabled}
                    >
                        {statusIcon}
                        <span>{canTranscode ? QUALITY_LABELS[quality] : throttleLabel(quality)}</span>
                        {isHls && !canTranscode && !isUpscale && (
                            <span className="text-[8px] text-amber-400/60 ml-0.5">cap</span>
                        )}
                        {isUpscale && (
                            <span className="text-[8px] text-white/20 ml-0.5">N/A</span>
                        )}
                    </button>
                );
            })}

            {/* Measured speed indicator (in adaptive mode) */}
            {adaptiveMode && measuredSpeedKbps !== undefined && measuredSpeedKbps > 0 && (
                <>
                    <div className="w-px h-5 bg-white/15" />
                    <span className="flex items-center gap-1 text-[10px] text-white/40">
                        <Zap className="w-3 h-3" />
                        {measuredSpeedKbps > 999
                            ? `${(measuredSpeedKbps / 1000).toFixed(1)} Mbps`
                            : `${Math.round(measuredSpeedKbps)} Kbps`}
                    </span>
                </>
            )}
        </div>
    );
}

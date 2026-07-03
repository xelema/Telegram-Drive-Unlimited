import { BandwidthStats } from '../../../types';
import { formatBytes } from '../../../utils';

interface BandwidthWidgetProps {
    bandwidth: BandwidthStats | null;
}

export function BandwidthWidget({ bandwidth }: BandwidthWidgetProps) {
    if (!bandwidth) return null;

    const totalBytes = bandwidth.up_bytes + bandwidth.down_bytes;

    return (
        <div className="mt-3 text-xs text-telegram-subtext space-y-1">
            <div className="flex justify-between">
                <span>Used Today:</span>
                <span>{formatBytes(totalBytes)}</span>
            </div>
        </div>
    );
}

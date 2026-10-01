import { BandwidthStats } from '../../../types';
import { formatBytes } from '../../../utils';

interface BandwidthWidgetProps {
    bandwidth: BandwidthStats | null;
}

export function BandwidthWidget({ bandwidth }: BandwidthWidgetProps) {
    if (!bandwidth) return null;

    const totalBytes = bandwidth.up_bytes + bandwidth.down_bytes;

    return (
        <div className="mt-1.5 space-y-1 text-metadata text-app-text-secondary">
            <div className="flex justify-between">
                <span>Used this week:</span>
                <span>{formatBytes(totalBytes)}</span>
            </div>
        </div>
    );
}

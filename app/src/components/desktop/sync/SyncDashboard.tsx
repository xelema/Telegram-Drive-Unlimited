import { useEffect, useState } from 'react';
import { useSync } from '../../../context/SyncContext';
import { SyncConflictList } from './SyncConflictList';

export function SyncDashboard() {
  const { status } = useSync();
  const [dismissed, setDismissed] = useState(false);
  const count = status.data?.conflicts ?? 0;
  useEffect(() => { if (count > 0) setDismissed(false); }, [count]);
  return count > 0 && !dismissed ? <SyncConflictList onClose={() => setDismissed(true)} /> : null;
}

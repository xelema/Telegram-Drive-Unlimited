import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfirmProvider, useConfirm } from '../../context/ConfirmContext';
import '../../i18n';
import '../../App.css';

/** Exercises the actual dialog and feedback without accessing a Telegram session. */
function Caller() {
    const { confirm } = useConfirm();
    const [decisions, setDecisions] = useState<boolean[]>([]);
    return <main className="min-h-screen bg-app-canvas p-8 text-app-text">
        <button type="button" className="quiet-control px-4 py-2" onClick={() => void confirm({
            title: 'Sign Out',
            message: 'Are you sure you want to sign out? This will disconnect your active session.',
            confirmText: 'Sign Out', variant: 'danger',
        }).then(value => setDecisions(previous => [...previous, value]))}>Log Out</button>
        <output data-testid="decisions">{JSON.stringify(decisions)}</output>
    </main>;
}

if (import.meta.env.DEV) {
    const target = document.getElementById('confirmation-fixture');
    if (target) createRoot(target).render(<ConfirmProvider><Caller /></ConfirmProvider>);
}

import { createRoot } from 'react-dom/client';
import { ConfirmProvider, useConfirm } from '../../context/ConfirmContext';
import {ensureLanguageResource,i18nInitialized} from '../../i18n';
import '../../App.css';

function Caller() {
    const { chooseDownloadCollision } = useConfirm();
    return <button onClick={() => void chooseDownloadCollision().then(choice => {
        (window as unknown as { downloadDecisions: unknown[] }).downloadDecisions.push(choice);
    })}>Start download</button>;
}

if (import.meta.env.DEV) {
    const target = document.getElementById('collision-fixture');
    if (target) void i18nInitialized.then(()=>ensureLanguageResource('en')).then(()=>createRoot(target).render(<ConfirmProvider><Caller /></ConfirmProvider>));
}

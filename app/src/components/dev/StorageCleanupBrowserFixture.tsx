import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CleanupPanel } from '../workspace/CleanupPanel';
import { StoragePanel } from '../workspace/StoragePanel';
import type { WorkspaceFile } from '../../services/workspace';
import '../../i18n';
import '../../App.css';

type BrowserFixture = { files: WorkspaceFile[]; calls: { command: string; args: unknown }[] };

// Served directly by the browser acceptance test in Vite DEV mode. Native I/O
// is supplied by the test; the production entry never imports this fixture.
function StorageCleanupBrowserFixture() {
    const fixture = (window as unknown as { __storageCleanupTest: BrowserFixture }).__storageCleanupTest;
    const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } }));
    return <QueryClientProvider client={client}>
        <main data-testid="panel-scroll" className="h-screen overflow-y-auto bg-telegram-bg p-4 text-telegram-text md:p-6">
            {new URLSearchParams(location.search).get('mode') === 'cleanup'
                ? <CleanupPanel ownerId="11" files={fixture.files}
                    onOpen={file => fixture.calls.push({ command: 'open-file', args: { key: file.key } })}
                    onFolder={folder => fixture.calls.push({ command: 'open-folder', args: { folder } })} />
                : <StoragePanel ownerId="11" />}
        </main>
    </QueryClientProvider>;
}

if (import.meta.env.DEV) {
    const target = document.getElementById('storage-cleanup-browser-fixture');
    if (target) createRoot(target).render(<StorageCleanupBrowserFixture />);
}

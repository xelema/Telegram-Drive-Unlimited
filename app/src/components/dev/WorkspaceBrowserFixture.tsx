import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SettingsProvider } from '../../context/SettingsContext';
import { WorkspaceHub } from '../workspace/WorkspaceHub';
import { MediaTimeline } from '../workspace/MediaTimeline';
import { PhotoSlideshow } from '../workspace/PhotoSlideshow';
import type { WorkspaceFile } from '../../services/workspace';
import '../../i18n';
import '../../App.css';

// A Playwright-only entry served directly by Vite. It mounts the real feature
// components with native I/O supplied by the browser test, never in releases.
function WorkspaceBrowserFixture() {
    const mode = new URLSearchParams(location.search).get('mode');
    const files = (window as unknown as { __workspaceTest: { galleryFiles: WorkspaceFile[] } }).__workspaceTest.galleryFiles;
    const [selected, setSelected] = useState(new Set<string>());
    const [viewer, setViewer] = useState<{ file: WorkspaceFile; files: WorkspaceFile[]; autoPlay: boolean } | null>(null);
    const [openedFolder, setOpenedFolder] = useState<string>('');
    const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } }));
    return <QueryClientProvider client={client}><SettingsProvider>
        {mode === 'gallery' ? <main className="min-h-screen bg-telegram-bg p-6 text-telegram-text">
            <button type="button" onClick={() => setViewer({ file: files[0], files, autoPlay: true })}>Start slideshow fixture</button>
            <output data-testid="selected-keys">{[...selected].join(',')}</output>
            <output data-testid="opened-folder">{openedFolder}</output>
            <MediaTimeline ownerId="1" files={files} selected={selected} gallery
                onSelect={key => setSelected(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; })}
                onOpen={(file, ordered = files) => setViewer({ file, files: ordered, autoPlay: false })}
                onFolder={folder => setOpenedFolder(folder === null ? 'saved' : String(folder))}
                onFavorite={() => undefined} onOrganize={file => setSelected(new Set([file.key]))} />
            {viewer && <PhotoSlideshow ownerId="1" files={viewer.files} initialKey={viewer.file.key} autoPlay={viewer.autoPlay} onClose={() => setViewer(null)} onFavorite={() => undefined} />}
        </main> : <WorkspaceHub folders={[{ id: 9, name: 'Travel' }]} onClose={() => undefined} onOpen={() => undefined} onFolder={folder => setOpenedFolder(folder === null ? 'saved' : String(folder))} />}
    </SettingsProvider></QueryClientProvider>;
}

if (import.meta.env.DEV) {
    const target = document.getElementById('workspace-browser-fixture');
    if (target) createRoot(target).render(<WorkspaceBrowserFixture />);
}

import { useEffect, useState } from 'react';
import { AuthWizard } from '../shared/AuthWizard';
import { FileExplorer } from '../desktop/dashboard/FileExplorer';
import { SettingsModal } from '../desktop/dashboard/SettingsModal';
import { ShareDialog } from '../desktop/dashboard/ShareDialog';
import { BottomNavBar } from '../mobile/BottomNavBar';
import { MobileSupporterCard } from '../mobile/MobileSupporterCard';
import type { TelegramFile, TelegramFolder } from '../../types';

const file: TelegramFile = {
  id: 101,
  name: 'Quarterly report.pdf',
  size: 2_450_000,
  sizeStr: '2.45 MB',
  created_at: '2026-08-29T12:00:00Z',
  folder_id: 10,
  mime_type: 'application/pdf',
  file_ext: 'pdf',
  is_favorite: true,
};

const folder: TelegramFolder = {
  id: 10,
  name: 'Documents',
  username: 'telegram_drive_fixture',
  is_public: true,
};

export default function AccessibilityFixtures() {
  const fixture = new URLSearchParams(window.location.search).get('a11y-fixture') || 'dashboard';
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(true);
  const [mobileTab, setMobileTab] = useState<'files' | 'downloads' | 'settings'>('files');

  useEffect(() => {
    const timer = window.setTimeout(() => {
      document.documentElement.dataset.a11yFixtureReady = fixture;
      window.dispatchEvent(new CustomEvent('telegram-drive-a11y-fixture-ready'));
    }, 350);
    return () => {
      window.clearTimeout(timer);
      delete document.documentElement.dataset.a11yFixtureReady;
    };
  }, [fixture]);

  if (fixture === 'auth') {
    // AuthWizard intentionally shows a browser-only notice outside Tauri. This
    // development fixture marks the page as native so axe exercises the real
    // sign-in form. Its startup probes fail closed here, so native state is not
    // changed by the browser fixture.
    if (!('__TAURI_INTERNALS__' in window)) {
      Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    }
    return <main className="min-h-screen bg-app-canvas"><AuthWizard onLogin={() => undefined} /></main>;
  }

  if (fixture === 'settings') {
    return (
      <main className="h-screen bg-app-canvas text-app-text">
        <h1 className="sr-only">Settings accessibility fixture</h1>
        <SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
      </main>
    );
  }

  if (fixture === 'dialog') {
    return (
      <main className="h-screen bg-app-canvas text-app-text">
        <h1 className="p-6 text-xl font-semibold">Sharing accessibility fixture</h1>
        {dialogOpen && <ShareDialog file={file} folders={[folder]} activeFolderId={folder.id} onClose={() => setDialogOpen(false)} />}
      </main>
    );
  }

  if (fixture === 'mobile') {
    return (
      <main className="min-h-screen bg-telegram-bg p-4 pb-32 text-telegram-text">
        <h1 className="mb-4 text-lg font-semibold">Mobile settings</h1>
        <MobileSupporterCard />
        <BottomNavBar activeTab={mobileTab} setActiveTab={setMobileTab} isAndroid />
      </main>
    );
  }

  return (
    <main className="flex h-screen flex-col bg-app-canvas text-app-text">
      <header className="border-b border-app-border px-5 py-4">
        <h1 className="text-xl font-semibold">Documents</h1>
      </header>
      <FileExplorer
        files={[file]}
        loading={false}
        error={null}
        viewMode="grid"
        selectedIds={[]}
        activeFolderId={folder.id}
        onFileClick={() => undefined}
        onDelete={() => undefined}
        onDownload={() => undefined}
        onPreview={() => undefined}
        onManualUpload={() => undefined}
        onFolderUpload={() => undefined}
        showFolderUpload
        onToggleSelection={() => undefined}
        onShare={() => undefined}
        onRename={() => undefined}
        onFileMove={() => undefined}
        folders={[folder]}
        cardScale={1}
        sortField="date"
        sortDirection="desc"
        onSortChange={() => undefined}
        onToggleFavorite={() => undefined}
        onTogglePinned={() => undefined}
      />
    </main>
  );
}

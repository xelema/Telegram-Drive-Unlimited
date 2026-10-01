import type { TelegramFile, TelegramFolder } from '../../../types';
import { isMediaFile, isPdfFile } from '../../../utils';

export type FilePreviewAction = 'open' | 'play' | 'view_pdf' | 'preview';

export interface FileActionDescriptor {
  isFolder: boolean;
  canShare: boolean;
  canMove: boolean;
  canRename: boolean;
  previewAction: FilePreviewAction;
}

export function describeFileActions(file: TelegramFile): FileActionDescriptor {
  const isFolder = file.type === 'folder';
  return {
    isFolder,
    canShare: !isFolder,
    canMove: !isFolder,
    canRename: !isFolder,
    previewAction: isFolder
      ? 'open'
      : isMediaFile(file.name)
        ? 'play'
        : isPdfFile(file.name)
          ? 'view_pdf'
          : 'preview',
  };
}

type FolderWithLegacyPeer = TelegramFolder & {
  chat?: { username?: string };
  channel?: { username?: string };
};

export function resolvePublicFolderUsername(
  file: TelegramFile,
  folders: TelegramFolder[] | undefined,
  activeFolderId: number | null | undefined,
): string | null {
  const folder = folders?.find(candidate => candidate.id === file.folder_id)
    ?? folders?.find(candidate => candidate.id === activeFolderId);
  const legacyFolder = folder as FolderWithLegacyPeer | undefined;
  return folder?.username ?? legacyFolder?.chat?.username ?? legacyFolder?.channel?.username ?? null;
}

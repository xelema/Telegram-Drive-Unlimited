import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { toast } from 'sonner';

function isAbortError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'name' in error
    && error.name === 'AbortError';
}

export async function copyToClipboard(text: string): Promise<void> {
  try {
    await writeText(text);
  } catch {
    // The plugin may be unavailable in browser and mobile contexts.
    await navigator.clipboard.writeText(text);
  }
}

export async function nativeShareOrCopy(
  name: string,
  sizeStr: string,
  link: string,
  onCopy?: (link: string) => void,
): Promise<void> {
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  if (canShare) {
    try {
      await navigator.share({
        title: `Shared file: ${name}`,
        text: `Download "${name}" (${sizeStr}) via Telegram Drive`,
        url: link,
      });
      return;
    } catch (error: unknown) {
      if (!isAbortError(error)) toast.error('Share failed, but link has been copied');
    }
  }

  if (onCopy) {
    onCopy(link);
  } else {
    navigator.clipboard.writeText(link);
    toast.success('Link copied to clipboard');
  }
}

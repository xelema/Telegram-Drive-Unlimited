import { toast } from 'sonner';

export interface FileDialogFallbackOptions {
  directory?: boolean;
  multiple?: boolean;
}

export async function pickWithFallback<T>(
  dialogFn: () => Promise<T | null>,
  onRetry: () => void,
  options: {
    errorTitle?: string;
    /** If provided, a "Browser Picker" button is shown that calls this function. */
    onBrowserPicker?: () => Promise<T | null>;
  } = {},
): Promise<T | null> {
  try {
    return await dialogFn();
  } catch (error) {
    console.error('Tauri dialog failed:', error);
    const errorTitle = options.errorTitle ?? 'Dialog failed';

    return await new Promise<T | null>((resolve) => {
      let resolved = false;
      let browserPickerClicked = false;
      const done = (value: T | null) => {
        if (resolved) return;
        resolved = true;
        resolve(value);
      };

      const toastOptions: Record<string, unknown> = {
        description: String(error),
        duration: 8000,
        action: {
          label: 'Retry',
          onClick: () => {
            done(null);
            onRetry();
          },
        },
        onDismiss: () => {
          if (!browserPickerClicked) done(null);
        },
        onAutoClose: () => {
          if (!browserPickerClicked) done(null);
        },
      };

      if (options.onBrowserPicker) {
        toastOptions.cancel = {
          label: 'Browser Picker',
          onClick: async () => {
            browserPickerClicked = true;
            const pickedValue = await options.onBrowserPicker!();
            done(pickedValue);
          },
        };
      }

      toast.error(errorTitle, toastOptions as Parameters<typeof toast.error>[1]);
    });
  }
}

export function showFileDialogFallback(options: FileDialogFallbackOptions = {}): Promise<string[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = options.multiple ?? true;

    if (options.directory) {
      input.setAttribute('webkitdirectory', '');
      input.setAttribute('directory', '');
    }

    let focusTimeout: ReturnType<typeof setTimeout> | undefined;
    let resolved = false;

    const cleanup = () => {
      window.removeEventListener('focus', onFocus);
      if (focusTimeout) clearTimeout(focusTimeout);
      input.remove();
    };

    const finish = (paths: string[]) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(paths);
    };

    input.onchange = () => {
      const paths: string[] = [];
      if (input.files) {
        for (let index = 0; index < input.files.length; index++) {
          const nativePath = (input.files[index] as File & { path?: string }).path;
          if (nativePath && typeof nativePath === 'string' && nativePath.length > 0) {
            paths.push(nativePath);
          }
        }
      }
      finish(paths);
    };

    const onFocus = () => {
      window.removeEventListener('focus', onFocus);
      focusTimeout = setTimeout(() => {
        // A change event fires before focus returns when the user selects a file.
        if (input.parentNode) finish([]);
      }, 300);
    };
    window.addEventListener('focus', onFocus);

    input.style.display = 'none';
    document.body.appendChild(input);
    input.click();
  });
}

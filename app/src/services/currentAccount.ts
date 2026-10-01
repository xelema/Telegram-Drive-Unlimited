import { invoke } from '@tauri-apps/api/core';

/** Read the verified session owner on every boundary; never cache across logout. */
export function getCurrentAccountId(): Promise<string> {
    return invoke<string>('cmd_workspace_account');
}

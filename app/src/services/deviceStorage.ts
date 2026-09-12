import { invoke } from '@tauri-apps/api/core';

export type StorageCategoryId = 'kept' | 'previews' | 'thumbnails' | 'nativePreviews' | 'converted' | 'downloads' | 'staging';
export interface StorageCategory { id:StorageCategoryId; bytes:number; reclaimableBytes:number; fileCount:number; measured?:boolean }
export interface StorageLimits { previews:number; thumbnails:number; converted:number }
export interface StorageSnapshot { ownerId:string; categories:StorageCategory[]; freeBytes:number|null; limits:StorageLimits }
export function readDeviceStorage(ownerId:string):Promise<StorageSnapshot>{return invoke('cmd_storage_read',{ownerId});}
export function clearDeviceStorage(ownerId:string,category:StorageCategoryId):Promise<void>{return invoke('cmd_storage_clear',{ownerId,category});}
export function saveStorageLimits(ownerId:string,limits:StorageLimits):Promise<void>{return invoke('cmd_storage_limits',{ownerId,limits});}

export const storageMessages = {
    title:'Device storage', description:'Review what is stored on this device and reclaim disposable copies.',
    unavailable:'Not measured on this device',
    free:'{{size}} free on this device', free_unknown:'Available device space could not be read.',
    accounting:'Sizes are file bytes, measured when you refresh. They exclude filesystem overhead, databases and settings. Kept files and workspace previews belong to this account; older caches and conversions are device-wide. Downloads include existing files recorded by this account’s desktop transfer history or published by this app in Android’s Downloads collection. Older Android versions may not expose a reliable total.',
    cache_explanation:'Clearing a cache leaves its Telegram original available. Kept files stay on the device until you remove them from Offline packs or Library.',
    limits:'Cache limits', previews_limit:'Image and PDF previews', thumbnails_limit:'Thumbnails', converted_limit:'Converted video',
    limit_explanation:'Preview and thumbnail allowances are shared by the app’s cache systems. Limits are applied to future cache use; clear a category below to reclaim existing files now.',
    save_limits:'Save limits', saved:'Cache limits saved.', refresh:'Refresh sizes', clear:'Clear {{size}}', clear_title:'Clear {{category}}?',
    clear_description:'This will reclaim up to {{size}} of disposable data. Active work can change this amount.', confirm_clear:'Clear cache', cleared:'Cache cleared. Storage sizes have been refreshed.',
    files:'{{count}} files', protected:'Kept on device', no_disposable:'No disposable files', error:'Storage could not be updated. Wait for active work to finish, then try again.',
    busy:'Active conversions must finish before their cache can be cleared.', staging_note:'Resumable camera uploads, active transfers and offline-pack staging are protected. Only verified abandoned preview staging can be reclaimed here.',
    categories:{kept:'Kept offline files',previews:'Image and PDF previews',thumbnails:'Thumbnails',nativePreviews:'Android Library previews',converted:'Converted video',downloads:'Downloaded files',staging:'Temporary staging'},
} as const;

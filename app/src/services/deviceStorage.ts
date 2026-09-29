import { invoke } from '@tauri-apps/api/core';

export type StorageCategoryId = 'kept' | 'previews' | 'thumbnails' | 'nativePreviews' | 'converted' | 'downloads' | 'staging';
export interface StorageCategory { id:StorageCategoryId; bytes:number; reclaimableBytes:number; fileCount:number; measured?:boolean }
export interface StorageLimits { previews:number; thumbnails:number; converted:number }
export interface StorageSnapshot { ownerId:string; categories:StorageCategory[]; freeBytes:number|null; limits:StorageLimits }
export function readDeviceStorage(ownerId:string):Promise<StorageSnapshot>{return invoke('cmd_storage_read',{ownerId});}
export function clearDeviceStorage(ownerId:string,category:StorageCategoryId):Promise<void>{return invoke('cmd_storage_clear',{ownerId,category});}
export function saveStorageLimits(ownerId:string,limits:StorageLimits):Promise<void>{return invoke('cmd_storage_limits',{ownerId,limits});}

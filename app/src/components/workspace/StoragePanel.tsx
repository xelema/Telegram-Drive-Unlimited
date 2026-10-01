import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { HardDrive, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { clearDeviceStorage, readDeviceStorage, saveStorageLimits, type StorageCategory, type StorageLimits } from '../../services/deviceStorage';
import { formatBytes } from '../../utils';

const MIB=1024*1024;
const button='min-h-11 rounded-xl border border-telegram-border bg-telegram-surface px-3 text-sm disabled:opacity-40';
export function StoragePanel({ownerId}:{ownerId:string}){
    const {t}=useTranslation();
    const query=useQuery({queryKey:['device-storage',ownerId],queryFn:()=>readDeviceStorage(ownerId)});
    const [limits,setLimits]=useState<StorageLimits|null>(null);const [confirm,setConfirm]=useState<StorageCategory|null>(null);
    const [busy,setBusy]=useState(false);const [message,setMessage]=useState('');const [error,setError]=useState(false);
    const owner=useRef(ownerId);owner.current=ownerId;const generation=useRef(0);
    const confirmation=useRef<HTMLElement>(null);const feedback=useRef<HTMLParagraphElement>(null);const trigger=useRef<HTMLButtonElement|null>(null);
    const data=query.data?.ownerId===ownerId?query.data:undefined;
    useEffect(()=>{generation.current++;setLimits(null);setConfirm(null);setMessage('');setError(false);setBusy(false);trigger.current=null;},[ownerId]);
    useEffect(()=>{if(data)setLimits(data.limits);},[data]);
    useEffect(()=>{if(confirm){confirmation.current?.scrollIntoView?.({block:'center'});confirmation.current?.focus({preventScroll:true});}},[confirm]);
    useEffect(()=>{if(message||query.isError){feedback.current?.scrollIntoView?.({block:'nearest'});feedback.current?.focus({preventScroll:true});}},[message,query.isError,confirm]);
    const dismiss=()=>{setConfirm(null);setMessage('');setError(false);if(trigger.current?.isConnected)trigger.current.focus();};
    const act=async(action:()=>Promise<void>,success:string)=>{const token=++generation.current;const isCurrent=()=>owner.current===ownerId&&token===generation.current;setBusy(true);setMessage('');setError(false);try{await action();if(!isCurrent())return;setConfirm(null);await query.refetch();if(isCurrent())setMessage(success);}catch(reason){if(isCurrent()){setError(true);setMessage(String(reason).includes('CACHE_BUSY')?'busy':'error');}}finally{if(isCurrent())setBusy(false);}};
    const notice=(message||query.isError)&&<p ref={feedback} tabIndex={-1} role={error||query.isError?'alert':'status'} className={`rounded-xl border p-3 text-sm outline-none ${error||query.isError?'border-red-500/30 text-red-400':'border-telegram-border'}`}>{t(`storage.${query.isError?'error':message}`)}</p>;
    return <section className="space-y-5">
        <header className="flex flex-wrap items-start gap-3"><HardDrive className="mt-1 h-6 w-6 text-telegram-primary"/><div className="min-w-0 flex-1"><h2 className="text-xl font-semibold">{t('storage.title')}</h2><p className="mt-2 text-sm text-telegram-subtext">{t('storage.description')}</p></div><button type="button" className={`${button} flex items-center gap-2`} disabled={busy||query.isFetching} onClick={()=>void query.refetch()}><RefreshCw className={`h-4 w-4 ${query.isFetching?'animate-spin':''}`}/>{t('storage.refresh')}</button></header>
        {!confirm&&notice}
        {query.isLoading&&<p role="status">{t('common.loading')}</p>}
        {data&&<><p className="text-lg font-medium">{t(data.freeBytes===null?'storage.free_unknown':'storage.free',{size:formatBytes(data.freeBytes||0)})}</p><p className="max-w-4xl text-sm leading-relaxed text-telegram-subtext">{t('storage.cache_explanation')}</p>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{data.categories.map(category=><article key={category.id} className="flex flex-col gap-3 rounded-2xl border border-telegram-border bg-telegram-surface p-4"><h3 className="font-medium">{t(`storage.categories.${category.id}`)}</h3><div className="flex flex-wrap items-baseline justify-between gap-2"><strong className="text-2xl">{category.measured===false?t('storage.unavailable'):formatBytes(category.bytes)}</strong>{category.measured!==false&&<span className="text-xs text-telegram-subtext">{t('storage.files',{count:category.fileCount})}</span>}</div><div className="mt-auto">{['kept','downloads'].includes(category.id)?<p className="flex min-h-11 items-center gap-2 text-sm text-telegram-subtext"><ShieldCheck className="h-4 w-4"/>{t('storage.protected')}</p>:<button type="button" disabled={busy||category.reclaimableBytes===0} onClick={event=>{trigger.current=event.currentTarget;setMessage('');setError(false);setConfirm(category);}} className={`${button} flex w-full items-center justify-center gap-2`}><Trash2 className="h-4 w-4"/>{t(category.reclaimableBytes?'storage.clear':'storage.no_disposable',{size:formatBytes(category.reclaimableBytes)})}</button>}</div></article>)}</div>
            <p className="max-w-4xl text-xs leading-relaxed text-telegram-subtext">{t('storage.staging_note')} {t('storage.accounting')}</p>
            {confirm&&<section ref={confirmation} tabIndex={-1} role="alertdialog" aria-labelledby="storage-clear-title" className="space-y-3 rounded-2xl border border-telegram-primary/50 p-4 outline-none"><h3 id="storage-clear-title" className="font-semibold">{t('storage.clear_title',{category:t(`storage.categories.${confirm.id}`)})}</h3><p className="text-sm text-telegram-subtext">{t('storage.clear_description',{size:formatBytes(confirm.reclaimableBytes)})}</p>{notice}<div className="flex gap-3"><button type="button" disabled={busy} className={`${button} text-telegram-primary`} onClick={()=>void act(()=>clearDeviceStorage(ownerId,confirm.id),'cleared')}>{t('storage.confirm_clear')}</button><button type="button" disabled={busy} className={button} onClick={dismiss}>{t('common.cancel')}</button></div></section>}
            {limits&&<form onSubmit={event=>{event.preventDefault();void act(()=>saveStorageLimits(ownerId,limits),'saved');}} className="space-y-4 rounded-2xl border border-telegram-border p-4"><h3 className="font-semibold">{t('storage.limits')}</h3>{([['previews',256,51200,256],['thumbnails',32,2048,32],['converted',256,102400,256]] as const).map(([key,min,max,step])=><label key={key} className="block max-w-2xl space-y-2 text-sm"><span className="flex justify-between gap-4"><span>{t(`storage.${key}_limit`)}</span><span>{formatBytes(limits[key])}</span></span><input type="range" min={min} max={max} step={step} value={limits[key]/MIB} onChange={event=>setLimits({...limits,[key]:Number(event.target.value)*MIB})} className="min-h-11 w-full accent-telegram-primary"/></label>)}<p className="max-w-3xl text-xs leading-relaxed text-telegram-subtext">{t('storage.limit_explanation')}</p><button type="submit" disabled={busy} className={`${button} text-telegram-primary`}>{t('storage.save_limits')}</button></form>}
        </>}
    </section>;
}

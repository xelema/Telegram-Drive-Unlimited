import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StoragePanel } from '../../src/components/workspace/StoragePanel';
import type { StorageSnapshot } from '../../src/services/deviceStorage';

const mocks=vi.hoisted(()=>({read:vi.fn(),clear:vi.fn(),save:vi.fn()}));
vi.mock('../../src/services/deviceStorage',()=>({readDeviceStorage:mocks.read,clearDeviceStorage:mocks.clear,saveStorageLimits:mocks.save}));
vi.mock('react-i18next',()=>({useTranslation:()=>({t:(key:string)=>key})}));
const snapshot=(ownerId='1'):StorageSnapshot=>({ownerId,freeBytes:1024,limits:{previews:512*1024*1024,thumbnails:64*1024*1024,converted:5*1024*1024*1024},categories:[
    {id:'kept',bytes:100,reclaimableBytes:0,fileCount:1}, {id:'downloads',bytes:200,reclaimableBytes:0,fileCount:1},
    {id:'previews',bytes:300,reclaimableBytes:300,fileCount:2}, {id:'converted',bytes:500,reclaimableBytes:0,fileCount:1},
    {id:'staging',bytes:50,reclaimableBytes:0,fileCount:1},
]});
const client=()=>new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0},mutations:{retry:false}}});
beforeEach(()=>{vi.clearAllMocks();mocks.read.mockImplementation(async(owner:string)=>snapshot(owner));mocks.clear.mockResolvedValue(undefined);mocks.save.mockResolvedValue(undefined);});
describe('reviewed device cache cleanup',()=>{
    it('never offers kept/download deletion and waits for review before clearing only the chosen category',async()=>{
        const queryClient=client();render(<QueryClientProvider client={queryClient}><StoragePanel ownerId="1"/></QueryClientProvider>);
        await screen.findByText('storage.categories.kept');
        const kept=screen.getByText('storage.categories.kept').closest('article')!;
        const downloads=screen.getByText('storage.categories.downloads').closest('article')!;
        expect(within(kept).queryByRole('button')).toBeNull();expect(within(downloads).queryByRole('button')).toBeNull();
        const preview=screen.getByText('storage.categories.previews').closest('article')!;
        fireEvent.click(within(preview).getByRole('button'));expect(mocks.clear).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button',{name:'storage.confirm_clear'}));
        await waitFor(()=>expect(mocks.clear).toHaveBeenCalledWith('1','previews'));
        await screen.findByText('storage.cleared');expect(mocks.read).toHaveBeenCalledTimes(2);
    });
    it('does not claim success on an active-conversion rejection or allow old-account confirmation',async()=>{
        const queryClient=client();let reject!:(reason:unknown)=>void;mocks.clear.mockImplementation(()=>new Promise((_,fail)=>{reject=fail;}));
        const view=render(<QueryClientProvider client={queryClient}><StoragePanel ownerId="1"/></QueryClientProvider>);
        const preview=(await screen.findByText('storage.categories.previews')).closest('article')!;
        fireEvent.click(within(preview).getByRole('button'));fireEvent.click(screen.getByRole('button',{name:'storage.confirm_clear'}));
        await act(async()=>reject('CACHE_BUSY'));
        expect(screen.getByRole('alert').textContent).toBe('storage.busy');expect(screen.queryByText('storage.cleared')).toBeNull();
        view.rerender(<QueryClientProvider client={queryClient}><StoragePanel ownerId="2"/></QueryClientProvider>);
        await waitFor(()=>expect(mocks.read).toHaveBeenCalledWith('2'));
        expect(screen.queryByRole('alertdialog')).toBeNull();expect(screen.queryByText('storage.busy')).toBeNull();
    });
});

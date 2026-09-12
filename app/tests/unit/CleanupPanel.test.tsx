import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CleanupPanel } from '../../src/components/workspace/CleanupPanel';
import type { WorkspaceFile } from '../../src/services/workspace';
const mocks=vi.hoisted(()=>({list:vi.fn(),schedule:vi.fn(),restore:vi.fn()}));
vi.mock('../../src/services/cleanup',async(importOriginal)=>({...await importOriginal<object>(),listRemovals:mocks.list,scheduleRemoval:mocks.schedule,restoreRemoval:mocks.restore}));
vi.mock('../../src/components/workspace/MediaTimeline',()=>({WorkspaceThumbnail:()=>null}));
vi.mock('react-i18next',()=>({useTranslation:()=>({t:(key:string)=>key,i18n:{language:'en'}})}));
const file=(key:string,folder_id:number|null):WorkspaceFile=>({key,id:42,folder_id,name:'duplicate.jpg',size:20,sizeStr:'20 B',folderName:folder_id===null?'Saved Messages':'Trip',tags:[],collectionIds:[],created_at:'2020-01-01'});
const files=[file('saved:42',null),file('7:42',7)];
function setup(){const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});return render(<QueryClientProvider client={client}><CleanupPanel ownerId="1" files={files} onOpen={vi.fn()} onFolder={vi.fn()}/></QueryClientProvider>);}
beforeEach(()=>{vi.clearAllMocks();mocks.list.mockResolvedValue([]);mocks.schedule.mockResolvedValue([{key:'saved:42',scheduled:true,error:null}]);});
describe('cleanup review and truthful recovery',()=>{
    it('keeps the reviewed outcome source after a refreshed workspace hides scheduled files',async()=>{
        const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});
        const renderPanel=(currentFiles:WorkspaceFile[])=><QueryClientProvider client={client}><CleanupPanel ownerId="1" files={currentFiles} onOpen={vi.fn()} onFolder={vi.fn()}/></QueryClientProvider>;
        const view=render(renderPanel(files));
        await waitFor(()=>expect(mocks.list).toHaveBeenCalled());
        fireEvent.click(screen.getAllByRole('checkbox')[0]);fireEvent.click(screen.getByRole('button',{name:'cleanup.review'}));fireEvent.click(screen.getByRole('checkbox',{name:'cleanup.acknowledge'}));fireEvent.click(screen.getByRole('button',{name:'cleanup.schedule'}));
        await screen.findByText('cleanup.scheduled');
        view.rerender(renderPanel([]));
        expect(within(screen.getByRole('list',{name:'cleanup.outcomes'})).getByText('Saved Messages / duplicate.jpg')).toBeTruthy();
    });
    it('ignores a late schedule result after switching accounts with the same file keys',async()=>{
        let resolve!:(value:unknown)=>void;mocks.schedule.mockImplementation(()=>new Promise(done=>{resolve=done;}));
        const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});
        const view=render(<QueryClientProvider client={client}><CleanupPanel ownerId="1" files={files} onOpen={vi.fn()} onFolder={vi.fn()}/></QueryClientProvider>);
        await waitFor(()=>expect(mocks.list).toHaveBeenCalled());fireEvent.click(screen.getAllByRole('checkbox')[0]);fireEvent.click(screen.getByRole('button',{name:'cleanup.review'}));fireEvent.click(screen.getByRole('checkbox',{name:'cleanup.acknowledge'}));fireEvent.click(screen.getByRole('button',{name:'cleanup.schedule'}));
        const otherFiles=files.map(file=>({...file,name:'another-account.jpg'}));
        view.rerender(<QueryClientProvider client={client}><CleanupPanel ownerId="2" files={otherFiles} onOpen={vi.fn()} onFolder={vi.fn()}/></QueryClientProvider>);
        await act(async()=>resolve([{key:'saved:42',scheduled:false,error:'NETWORK_UNAVAILABLE'}]));
        expect(screen.queryByRole('list',{name:'cleanup.outcomes'})).toBeNull();
        expect(screen.getAllByRole('checkbox').every(box=>!(box as HTMLInputElement).checked)).toBe(true);
        expect(screen.queryByRole('button',{name:'cleanup.review'})).toBeNull();
    });
    it('requires individual selection, source review and acknowledgement before scheduling exact file identities',async()=>{
        setup();await waitFor(()=>expect(mocks.list).toHaveBeenCalled());
        expect(screen.getAllByRole('checkbox').every(box=>!(box as HTMLInputElement).checked)).toBe(true);
        fireEvent.click(screen.getAllByRole('checkbox')[0]);fireEvent.click(screen.getByRole('button',{name:'cleanup.review'}));
        expect(screen.getByText('Saved Messages / duplicate.jpg')).toBeTruthy();
        const schedule=screen.getByRole('button',{name:'cleanup.schedule'}) as HTMLButtonElement;
        expect(schedule.disabled).toBe(true);expect(mocks.schedule).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('checkbox',{name:'cleanup.acknowledge'}));fireEvent.click(schedule);
        await waitFor(()=>expect(mocks.schedule).toHaveBeenCalledWith('1',['saved:42'],7));
        expect(await screen.findByText('cleanup.scheduled')).toBeTruthy();
    });
    it('offers restore for pending originals and never for ambiguous or completed irreversible deletion',async()=>{
        mocks.list.mockResolvedValue(['pending','deleting','deleted'].map((status,index)=>({id:String(index),key:String(index),file:{...files[0],name:status},requestedAt:0,deleteAfter:Date.now()+86400000,status,error:null})));
        setup();const pending=(await screen.findByText('pending')).closest('article')!;
        expect(within(pending).getByRole('button',{name:'cleanup.restore'})).toBeTruthy();
        for(const name of ['deleting','deleted'])expect(within(screen.getByText(name).closest('article')!).queryByRole('button',{name:'cleanup.restore'})).toBeNull();
    });
});

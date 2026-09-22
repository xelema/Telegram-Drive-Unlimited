import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileExplorer } from '../../src/components/desktop/dashboard/FileExplorer';
import { FileCard } from '../../src/components/desktop/dashboard/FileCard';
import '../../src/i18n';

const mocks = vi.hoisted(() => ({ load:vi.fn(),get:vi.fn(),forget:vi.fn(),metadata:vi.fn(),variants:vi.fn() }));
vi.mock('../../src/services/imagePreviewCache', () => ({loadThumbnail:mocks.load,getCachedThumbnail:mocks.get,forgetThumbnail:mocks.forget}));
vi.mock('../../src/hooks/useVideoMetadata', () => ({useVideoMetadata:mocks.metadata}));
vi.mock('../../src/hooks/useCachedVariants', () => ({useCachedVariants:mocks.variants}));
vi.mock('../../src/context/SettingsContext', async () => {
  const {DEFAULT_SETTINGS} = await import('../../src/config/defaultSettings');
  return {useSettings:() => ({settings:DEFAULT_SETTINGS})};
});
vi.mock('@tanstack/react-virtual', () => ({useVirtualizer:() => ({
  getVirtualItems:() => [{index:0,key:0,start:0,size:240}],getTotalSize:() => 240,measureElement:vi.fn(),scrollToOffset:vi.fn(),measure:vi.fn(),
})}));
vi.mock('@dnd-kit/core', () => ({
  useDraggable:() => ({attributes:{},listeners:{},setNodeRef:vi.fn(),isDragging:false}),
  useDroppable:() => ({setNodeRef:vi.fn(),isOver:false,active:null}),
}));
const saved = {id:42,folder_id:null,name:'Saved.jpg',size:1,sizeStr:'1 B'};

describe('source identity in actual FileExplorer thumbnails', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver',class { observe() {} disconnect() {} unobserve() {} });
    mocks.load.mockReset().mockImplementation(async (id:number,folder:number|null) => `https://preview.invalid/${folder ?? 'saved'}/${id}.jpg`);
    mocks.get.mockReset().mockReturnValue(null);
    mocks.forget.mockReset();
    mocks.metadata.mockReset().mockReturnValue({data:null,isLoading:false});
    mocks.variants.mockReset().mockReturnValue({data:[]});
  });
  afterEach(() => vi.unstubAllGlobals());

  it('keeps an uncached folder loading until its remote scan settles, then distinguishes empty and failed results', () => {
    const props = {
      files: [], loading: false, error: null, viewMode: 'grid' as const, selectedIds: [], activeFolderId: 9,
      onFileClick: vi.fn(), onDelete: vi.fn(), onDownload: vi.fn(), onPreview: vi.fn(),
      onManualUpload: vi.fn(), onFolderUpload: vi.fn(), showFolderUpload: false, onToggleSelection: vi.fn(),
      cardScale: 1, sortField: 'name' as const, sortDirection: 'asc' as const, onSortChange: vi.fn(),
    };
    const view = render(<FileExplorer {...props} syncProgress={{ active: true, count: 0 }} />);
    expect(screen.getByLabelText('Loading...')).toBeTruthy();
    expect(screen.queryByText('This folder is empty')).toBeNull();
    view.rerender(<FileExplorer {...props} syncProgress={{ active: false, count: 0 }} />);
    expect(screen.getByText('This folder is empty')).toBeTruthy();
    expect(screen.queryByLabelText('Loading...')).toBeNull();
    view.rerender(<FileExplorer {...props} error={new Error('Remote scan failed')} syncProgress={{ active: false, count: 0 }} />);
    expect(screen.getByText('Error loading files')).toBeTruthy();
    expect(screen.queryByText('This folder is empty')).toBeNull();
    view.rerender(<FileExplorer {...props} files={[saved]} syncProgress={{ active: true, count: 1 }} />);
    expect(screen.queryByLabelText('Loading...')).toBeNull();
    expect(screen.getByText('Saved.jpg')).toBeTruthy();
  });

  it('loads and evicts Saved Messages separately from a colliding channel message', async () => {
    render(<FileExplorer files={[saved,{...saved,folder_id:9,name:'Channel.jpg'}]} loading={false} error={null}
      viewMode="grid" selectedIds={[]} activeFolderId={9} onFileClick={vi.fn()} onDelete={vi.fn()} onDownload={vi.fn()}
      onPreview={vi.fn()} onManualUpload={vi.fn()} onFolderUpload={vi.fn()} showFolderUpload={false}
      onToggleSelection={vi.fn()} cardScale={1} sortField="name" sortDirection="asc" onSortChange={vi.fn()} />);
    await waitFor(() => expect(mocks.load).toHaveBeenCalledWith(42,null));
    expect(mocks.load).toHaveBeenCalledWith(42,9);
    expect(mocks.get).toHaveBeenCalledWith(42,null);
    expect(mocks.get).toHaveBeenCalledWith(42,9);
    const photo = await screen.findByRole('img',{name:'Saved.jpg'});
    expect(photo.getAttribute('src')).toBe('https://preview.invalid/saved/42.jpg');
    expect(screen.getByRole('img',{name:'Channel.jpg'}).getAttribute('src')).toBe('https://preview.invalid/9/42.jpg');
    fireEvent.error(photo);
    expect(mocks.forget).toHaveBeenCalledWith(42,null);
    expect(mocks.forget).not.toHaveBeenCalledWith(42,9);
  });

  it('uses the same explicit-or-absent source rule for image and media metadata', async () => {
    const props = {onDelete:vi.fn(),onDownload:vi.fn(),isSelected:false,activeFolderId:9};
    const view = render(<FileCard {...props} file={{...saved,folder_id:undefined}} />);
    await waitFor(() => expect(mocks.load).toHaveBeenCalledWith(42,9));
    expect(mocks.metadata).toHaveBeenCalledWith(42,9,'Saved.jpg');
    view.rerender(<FileCard {...props} file={saved} />);
    await waitFor(() => expect(mocks.load).toHaveBeenCalledWith(42,null));
    expect(mocks.metadata).toHaveBeenCalledWith(42,null,'Saved.jpg');
    expect(mocks.variants).toHaveBeenCalledWith(42,null,'Saved.jpg');
  });
});

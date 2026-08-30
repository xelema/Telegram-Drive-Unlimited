import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewModal } from '../../src/components/desktop/dashboard/PreviewModal';

const mocks = vi.hoisted(() => ({
  listen: vi.fn(),
  loadPreview: vi.fn(),
  loadThumbnail: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string, values?: { percent?: number }) => ({
      'common.zoom_out': 'Zoom out',
      'common.zoom_out_shortcut': 'Zoom out (-)',
      'common.zoom_in': 'Zoom in',
      'common.zoom_in_shortcut': 'Zoom in (+)',
      'common.fit_image': 'Fit image',
      'common.fit_image_shortcut': 'Fit image (0)',
      'common.actual_size': 'Actual size',
      'common.actual_size_shortcut': 'Actual size (1)',
      'common.current_zoom': `Current zoom: ${values?.percent}%`,
    }[key] ?? key),
  }),
}));
vi.mock('../../src/context/SettingsContext', () => ({
  useSettings: () => ({ settings: { vpnMode: false, bandwidthLimitDownKBs: 0 } }),
}));
vi.mock('../../src/services/imagePreviewCache', () => ({
  forgetPreview: vi.fn(),
  forgetThumbnail: vi.fn(),
  getCachedPreview: vi.fn(() => null),
  getCachedThumbnail: vi.fn(() => null),
  loadPreview: mocks.loadPreview,
  loadThumbnail: mocks.loadThumbnail,
}));

function prepareImageLayout(image: HTMLImageElement): void {
  Object.defineProperties(image, {
    naturalWidth: { configurable: true, value: 1600 },
    naturalHeight: { configurable: true, value: 1200 },
    clientWidth: { configurable: true, value: 800 },
    clientHeight: { configurable: true, value: 600 },
  });
  const viewport = image.parentElement as HTMLDivElement;
  Object.defineProperties(viewport, {
    clientWidth: { configurable: true, value: 800 },
    clientHeight: { configurable: true, value: 600 },
    getBoundingClientRect: {
      configurable: true,
      value: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}) }),
    },
  });
}

async function renderLoadedPreview(onNext = vi.fn()) {
  const result = render(
    <PreviewModal
      file={{ id: 42, name: 'photo.jpg', size: 2_000_000, sizeStr: '1.9 MB' }}
      activeFolderId={null}
      onClose={vi.fn()}
      onNext={onNext}
    />,
  );
  const image = await screen.findByAltText('photo.jpg') as HTMLImageElement;
  prepareImageLayout(image);
  fireEvent.load(image);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Zoom in' })).not.toBeNull());
  return { ...result, image, viewport: image.parentElement as HTMLDivElement, onNext };
}

describe('PreviewModal image controls', () => {
  beforeEach(() => {
    mocks.listen.mockReset().mockResolvedValue(() => {});
    mocks.loadPreview.mockReset().mockResolvedValue('asset://localhost/photo.jpg');
    mocks.loadThumbnail.mockReset().mockResolvedValue(null);
  });

  it('supports desktop controls and reserves arrow keys for panning while zoomed', async () => {
    const { image, onNext } = await renderLoadedPreview();

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(image.style.transform).toContain('scale(1.25)');

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(onNext).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: '0' });
    expect(image.style.transform).toContain('scale(1)');
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(onNext).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Actual size' }));
    expect(image.style.transform).toContain('scale(2)');
  });

  it('supports Android-style pinch zoom and double-tap reset', async () => {
    const { image, viewport } = await renderLoadedPreview();

    fireEvent.pointerDown(viewport, { pointerId: 1, pointerType: 'touch', button: 0, clientX: 250, clientY: 300 });
    fireEvent.pointerDown(viewport, { pointerId: 2, pointerType: 'touch', button: 0, clientX: 550, clientY: 300 });
    fireEvent.pointerMove(viewport, { pointerId: 2, pointerType: 'touch', clientX: 700, clientY: 300 });
    expect(image.style.transform).toContain('scale(1.5)');
    fireEvent.pointerUp(viewport, { pointerId: 2, pointerType: 'touch', button: 0, clientX: 700, clientY: 300 });
    fireEvent.pointerUp(viewport, { pointerId: 1, pointerType: 'touch', button: 0, clientX: 250, clientY: 300 });

    fireEvent.pointerDown(viewport, { pointerId: 3, pointerType: 'touch', button: 0, clientX: 400, clientY: 300 });
    fireEvent.pointerUp(viewport, { pointerId: 3, pointerType: 'touch', button: 0, clientX: 400, clientY: 300 });
    fireEvent.pointerDown(viewport, { pointerId: 4, pointerType: 'touch', button: 0, clientX: 400, clientY: 300 });
    fireEvent.pointerUp(viewport, { pointerId: 4, pointerType: 'touch', button: 0, clientX: 400, clientY: 300 });
    expect(image.style.transform).toContain('scale(1)');
  });
});

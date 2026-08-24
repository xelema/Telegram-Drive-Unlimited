import { describe, expect, it } from 'vitest';
import {
  downloadItemToTransferRequest,
  mergeTransferJob,
  transferJobToDownloadItem,
  transferJobToUploadItem,
  uploadItemToTransferRequest,
  type DesktopTransferJob,
} from '../../src/services/desktopTransferEngine';

const uploadJob = (revision = 1): DesktopTransferJob => ({
  id: 'upload-1',
  direction: 'upload',
  kind: 'local_upload',
  status: 'pending',
  path: '/tmp/report.pdf',
  folderId: 42,
  filename: 'report.pdf',
  progress: 0,
  transferredBytes: 0,
  totalBytes: 100,
  speedBytesPerSec: 0,
  queuePosition: 1,
  revision,
  createdAt: 1,
  updatedAt: revision,
});

describe('desktop transfer engine projections', () => {
  it('maps backend terminal states to the established transfer-center states', () => {
    expect(transferJobToUploadItem({ ...uploadJob(), status: 'completed' }).status).toBe('success');
    expect(transferJobToUploadItem({ ...uploadJob(), status: 'failed' }).status).toBe('error');

    const download = transferJobToDownloadItem({
      ...uploadJob(),
      direction: 'download',
      kind: 'download',
      messageId: 7,
      savePath: '/tmp/report.pdf',
      status: 'completed',
    });
    expect(download.status).toBe('success');
    expect(download.downloadedBytes).toBe(0);
  });

  it('never puts a staged credential handle into a projected queue item', () => {
    const projected = transferJobToUploadItem({
      ...uploadJob(),
      protectionMode: 'passphrase',
      protectMetadata: true,
    });
    expect(projected.protection).toEqual({ mode: 'passphrase', protectMetadata: true });
    expect(projected.protection?.promptToken).toBeUndefined();
  });

  it('creates complete upload and download enqueue contracts', () => {
    expect(uploadItemToTransferRequest({
      id: 'up',
      path: '/tmp/a.txt',
      folderId: null,
      status: 'pending',
    })).toMatchObject({ direction: 'upload', kind: 'local_upload', filename: 'a.txt' });

    expect(downloadItemToTransferRequest({
      id: 'down',
      messageId: 9,
      filename: 'a.txt',
      folderId: null,
      savePath: '/tmp/a.txt',
      status: 'paused',
    })).toMatchObject({ direction: 'download', kind: 'download', initialStatus: 'paused' });
  });

  it('ignores stale events and orders newly merged jobs by queue position', () => {
    const current = { ...uploadJob(3), status: 'uploading' as const };
    expect(mergeTransferJob([current], { ...uploadJob(2), status: 'pending' })).toEqual([current]);

    const earlier = { ...uploadJob(), id: 'earlier', queuePosition: 0 };
    expect(mergeTransferJob([current], earlier).map(job => job.id)).toEqual(['earlier', 'upload-1']);
  });
});

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
  it('preserves collision decisions, actual published names, and skipped outcomes', () => {
    const item = transferJobToDownloadItem({
      ...uploadJob(), ownerId: 'owner-a', direction: 'download', kind: 'download', messageId: 7,
      filename: 'report (2).pdf', savePath: '/tmp/report (2).pdf', status: 'completed',
      collisionPolicy: 'keep_both', downloadOutcome: 'saved',
    });
    expect(item).toMatchObject({ filename: 'report (2).pdf', savePath: '/tmp/report (2).pdf', downloadOutcome: 'saved', ownerId: 'owner-a' });
    expect(downloadItemToTransferRequest(item).collisionPolicy).toBe('keep_both');
    const skipped = transferJobToDownloadItem({ ...uploadJob(), direction: 'download', kind: 'download', status: 'completed', downloadOutcome: 'skipped', collisionPolicy: 'skip' });
    expect(skipped.downloadOutcome).toBe('skipped');
    expect(downloadItemToTransferRequest(skipped).collisionPolicy).toBe('skip');
    expect(downloadItemToTransferRequest({ ...item, collisionPolicy: undefined }).collisionPolicy).toBe('keep_both');
  });

});

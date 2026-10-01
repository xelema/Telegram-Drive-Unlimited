import { FolderOpen, Plus, UploadCloud } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui';

interface EmptyStateProps {
    onUpload: () => void;
}

export function EmptyState({ onUpload }: EmptyStateProps) {
    const { t } = useTranslation();

    return (
        <div className="flex min-h-full flex-col items-center justify-center px-8 py-16 text-center">
            <div className="relative mb-5 flex h-20 w-20 items-center justify-center rounded-overlay border border-app-border-subtle bg-app-surface/55 text-app-accent shadow-[var(--shadow-raised)]">
                <FolderOpen className="h-8 w-8" strokeWidth={1.6} />
                <span className="absolute -bottom-1 -end-1 flex h-6 w-6 items-center justify-center rounded-full border border-app-border bg-app-surface-raised text-app-accent">
                    <Plus className="h-3.5 w-3.5" />
                </span>
            </div>

            <h3 className="mb-1.5 text-app-title font-semibold text-app-text">
                This folder is empty
            </h3>
            <p className="mb-5 max-w-sm text-ui text-app-text-secondary">
                Drag and drop files here, or click the button below to upload from your computer.
            </p>

            <Button
                variant="primary"
                onClick={onUpload}
                leadingIcon={<UploadCloud className="h-3.5 w-3.5" />}
                className="toolbar-upload-action"
            >
                {t('common.upload_file')}
            </Button>

            <p className="mt-5 text-badge text-app-text-tertiary">
                Tip: Use <kbd className="rounded-control border border-app-border bg-app-surface-sunken/45 px-1.5 py-0.5 font-mono text-app-text-secondary">Ctrl/Cmd + F</kbd> to search
            </p>
        </div>
    );
}

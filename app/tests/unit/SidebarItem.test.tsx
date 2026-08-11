import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SidebarItem } from '../../src/components/desktop/dashboard/SidebarItem';

vi.mock('@dnd-kit/sortable', () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
    isOver: false,
    active: null,
  }),
}));

vi.mock('@dnd-kit/utilities', () => ({ CSS: { Transform: { toString: () => undefined } } }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'files.folder_settings': 'Folder settings',
      'files.rename': 'Rename',
      'files.make_public': 'Make public',
      'files.make_private': 'Make private',
      'files.copy_link': 'Copy link',
      'files.move_to_group': 'Move to group',
      'files.delete': 'Delete',
      'common.unassigned': 'Unassigned',
    }[key] ?? key),
  }),
}));

const FolderIcon = () => <svg aria-hidden="true" />;

describe('SidebarItem folder actions', () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 300, right: 332, top: 10, bottom: 42, width: 32, height: 32, x: 300, y: 10, toJSON: () => ({}) }),
    });
  });

  it('runs an action opened from the folder options button', () => {
    const onRename = vi.fn();
    render(
      <SidebarItem
        icon={FolderIcon}
        label="Photos"
        active={false}
        onClick={vi.fn()}
        onDelete={vi.fn()}
        onRename={onRename}
        folderId={42}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Folder settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    expect(onRename).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull();
  });

  it('runs an action opened by right-click without selecting the folder', () => {
    const onDelete = vi.fn();
    const onSelect = vi.fn();
    render(
      <SidebarItem
        icon={FolderIcon}
        label="Photos"
        active={false}
        onClick={onSelect}
        onDelete={onDelete}
        folderId={42}
      />,
    );

    fireEvent.contextMenu(screen.getByText('Photos').parentElement!, { clientX: 120, clientY: 80 });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDelete).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });
});

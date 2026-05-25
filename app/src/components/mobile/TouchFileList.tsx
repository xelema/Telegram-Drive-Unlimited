import { DownloadCloud, Trash2 } from 'lucide-react';
import { FileTypeIcon } from '../shared/FileTypeIcon';

export function TouchFileList() {
  // Mobile mock data list
  const mockFiles = [
    { id: 1, name: 'Tauri_Android_Blueprint.pdf', size: '12.4 MB', date: 'May 24, 2026', type: 'document' },
    { id: 2, name: 'Vacation_Photo_2026.jpg', size: '4.8 MB', date: 'May 22, 2026', type: 'image' },
    { id: 3, name: 'Actix_Streaming_Server.rs', size: '18 KB', date: 'May 21, 2026', type: 'code' },
  ];

  return (
    <div className="space-y-2.5">
      {mockFiles.map((file) => (
        <div
          key={file.id}
          className="flex items-center justify-between p-3.5 rounded-2xl bg-telegram-hover/30 border border-telegram-border/20 active:bg-telegram-hover/55 transition-all duration-200"
        >
          <div className="flex items-center gap-3.5 min-w-0">
            <div className="flex-shrink-0">
              <FileTypeIcon filename={file.name} />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-telegram-text truncate max-w-[200px] leading-snug">{file.name}</p>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-[10px] text-telegram-subtext/80 font-medium font-mono">{file.size}</span>
                <span className="w-1 h-1 bg-telegram-border rounded-full" />
                <span className="text-[10px] text-telegram-subtext/80 font-medium">{file.date}</span>
              </div>
            </div>
          </div>
          
          <div className="flex items-center gap-1">
            <button className="p-2.5 rounded-xl bg-telegram-primary/10 text-telegram-primary active:scale-90 transition-all duration-200">
              <DownloadCloud className="w-4 h-4" />
            </button>
            <button className="p-2.5 rounded-xl bg-red-500/10 text-red-400 active:scale-90 transition-all duration-200">
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

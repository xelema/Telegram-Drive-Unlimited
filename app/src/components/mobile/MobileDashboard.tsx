import { useState, useEffect } from 'react';
import { Sparkles, Folder, Download, Menu, LogOut, RefreshCw } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { BottomNavBar } from './BottomNavBar';
import { TouchFileList } from './TouchFileList';
import { ThemeToggle } from '../shared/ThemeToggle';
import { usePlatform } from '../../hooks/usePlatform';

export default function MobileDashboard({ onLogout }: { onLogout?: () => void }) {
  const [activeTab, setActiveTab] = useState<'files' | 'downloads' | 'settings'>('files');
  const activeFolder = 'Saved Messages';
  const { isAndroid } = usePlatform();

  useEffect(() => {
    if (isAndroid) {
      invoke('show_ad').catch((e) => console.error('Failed to show ad:', e));
    }
  }, [isAndroid]);

  return (
    <div className="flex flex-col h-screen w-full bg-telegram-bg text-telegram-text overflow-hidden select-none font-sans">
      {/* Premium Gradient Top Header */}
      <header className="flex items-center justify-between px-5 py-4 bg-gradient-to-r from-telegram-hover/40 to-telegram-bg border-b border-telegram-border/60 shadow-lg backdrop-blur-md sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-telegram-primary/10 border border-telegram-primary/20 text-telegram-primary shadow-inner">
            <Sparkles className="w-5 h-5 animate-pulse" />
          </div>
          <div>
            <h1 className="text-base font-bold tracking-tight bg-gradient-to-r from-white to-telegram-subtext bg-clip-text text-transparent">Telegram Drive</h1>
            <p className="text-[10px] text-telegram-subtext/80 font-medium font-mono uppercase tracking-wider">{activeFolder}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <button className="p-2 rounded-xl bg-telegram-hover/30 hover:bg-telegram-hover/60 border border-telegram-border/40 text-telegram-subtext transition-all duration-300">
            <Menu className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* Main Responsive Viewport */}
      <main className="flex-1 overflow-y-auto px-4 py-3 space-y-4 pb-24 scroll-smooth">
        {activeTab === 'files' && (
          <div className="space-y-4 animate-fade-in">
            {/* Folder Header Breadcrumb */}
            <div className="flex items-center justify-between bg-telegram-hover/20 p-3 rounded-2xl border border-telegram-border/30">
              <div className="flex items-center gap-2.5">
                <Folder className="w-5 h-5 text-telegram-primary" />
                <span className="text-sm font-semibold">{activeFolder}</span>
              </div>
              <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-telegram-primary/15 text-telegram-primary border border-telegram-primary/10 active:scale-95 transition-all duration-200">
                <RefreshCw className="w-3.5 h-3.5" />
                Sync
              </button>
            </div>
            
            {/* Scrollable File List */}
            <TouchFileList />
          </div>
        )}

        {activeTab === 'downloads' && (
          <div className="flex flex-col items-center justify-center h-[60vh] space-y-3 text-center px-6 animate-fade-in">
            <div className="p-4 rounded-full bg-telegram-primary/10 text-telegram-primary border border-telegram-primary/20">
              <Download className="w-8 h-8 animate-bounce" />
            </div>
            <h3 className="text-base font-bold">No Active Transfers</h3>
            <p className="text-xs text-telegram-subtext max-w-xs leading-relaxed">
              Your uploaded and downloaded files will appear here dynamically.
            </p>
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="space-y-4 animate-fade-in">
            <div className="p-4 rounded-2xl bg-telegram-hover/20 border border-telegram-border/30 space-y-4">
              <h3 className="text-sm font-bold text-telegram-primary tracking-wide uppercase text-[10px]">Preferences</h3>
              <div className="flex items-center justify-between py-2 border-b border-telegram-border/20">
                <span className="text-xs font-medium">Automatic Zipping</span>
                <input type="checkbox" defaultChecked className="accent-telegram-primary w-4 h-4 rounded" />
              </div>
              <div className="flex items-center justify-between py-2">
                <span className="text-xs font-medium">Show Hidden Files</span>
                <input type="checkbox" className="accent-telegram-primary w-4 h-4 rounded" />
              </div>
            </div>

            <button onClick={onLogout} className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 font-semibold text-xs active:scale-98 transition-all duration-200">
              <LogOut className="w-4 h-4" />
              Log Out
            </button>
          </div>
        )}
      </main>

      {/* Floating Bottom Nav Bar */}
      <BottomNavBar activeTab={activeTab} setActiveTab={setActiveTab} isAndroid={isAndroid} />
    </div>
  );
}

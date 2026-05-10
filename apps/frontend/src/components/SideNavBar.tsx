'use client';
import { useSidebar } from '@/context/SidebarContext';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export default function SideNavBar() {
  const { collapsed, toggle } = useSidebar();
  const pathname = usePathname();

  const isActive = (path: string) => pathname === path;

  return (
    <aside className={`fixed left-0 top-14 h-[calc(100vh-3.5rem)] bg-slate-950 border-r border-slate-800 flex flex-col py-4 text-sm transition-all duration-300 ${
      collapsed ? 'w-16' : 'w-64'
    }`}>
      <button 
        onClick={toggle}
        className="absolute -right-3 top-6 w-6 h-6 bg-slate-800 border border-slate-700 rounded-full flex items-center justify-center hover:bg-slate-700 transition-colors z-10"
      >
        <span className="material-symbols-outlined text-xs text-slate-400">
          {collapsed ? 'chevron_right' : 'chevron_left'}
        </span>
      </button>

      <div className="flex-1 space-y-1 px-3">
        <Link href="/" className={`flex items-center gap-4 px-3 py-3 transition-all rounded-r-lg ${
          isActive('/') ? 'bg-blue-500/10 text-blue-400 border-r-2 border-blue-500' : 'text-slate-500 hover:bg-slate-900 hover:text-slate-300'
        } ${collapsed ? 'justify-center' : ''}`}>
          <span className="material-symbols-outlined text-xl">folder_open</span>
          {!collapsed && <span>Projects</span>}
        </Link>
        
        <Link href="/settings" className={`flex items-center gap-4 px-3 py-3 transition-all rounded-lg ${
          isActive('/settings') ? 'bg-blue-500/10 text-blue-400 border-r-2 border-blue-500' : 'text-slate-500 hover:bg-slate-900 hover:text-slate-300'
        } ${collapsed ? 'justify-center' : ''}`}>
          <span className="material-symbols-outlined text-xl">settings</span>
          {!collapsed && <span>Settings</span>}
        </Link>
      </div>
      
      <div className="mt-auto border-t border-slate-900 pt-4 space-y-1 px-3">
        <a className={`flex items-center gap-4 px-3 py-2 text-slate-500 hover:bg-slate-900 hover:text-slate-300 transition-all rounded-lg ${
          collapsed ? 'justify-center' : ''
        }`} href="#">
          <span className="material-symbols-outlined text-xl">menu_book</span>
          {!collapsed && <span>Documentation</span>}
        </a>
      </div>
    </aside>
  );
}
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export default function TopNavBar() {
  const pathname = usePathname();

  return (
    <nav className="fixed top-0 w-full z-50 flex justify-between items-center px-6 h-14 bg-slate-900/80 backdrop-blur-md border-b border-slate-800 tracking-tight">
      <div className="flex items-center gap-1">
        <Link href="/" className="text-lg font-bold text-slate-100 uppercase tracking-widest hover:text-blue-400 transition-colors">
          GitHubDemo
        </Link>
      </div>
      <div className="flex items-center gap-4">
        <div className="hidden md:flex items-center gap-6 mr-4">
          <Link 
            href="/" 
            className={`font-semibold transition-colors ${pathname === '/' ? 'text-blue-400' : 'text-slate-400 hover:text-blue-400'}`}
          >
            Projects
          </Link>
          <Link 
            href="/settings" 
            className={`font-semibold transition-colors ${pathname === '/settings' ? 'text-blue-400' : 'text-slate-400 hover:text-blue-400'}`}
          >
            Settings
          </Link>
        </div>
        <div className="flex items-center gap-2">
          <button className="p-1 text-slate-400 hover:text-blue-400 transition-colors active:scale-95 duration-100">
            <span className="material-symbols-outlined">notifications</span>
          </button>
          <button className="p-1 text-slate-400 hover:text-blue-400 transition-colors active:scale-95 duration-100">
            <span className="material-symbols-outlined">help</span>
          </button>
          <button className="p-1 text-slate-400 hover:text-blue-400 transition-colors active:scale-95 duration-100">
            <span className="material-symbols-outlined">account_circle</span>
          </button>
        </div>
      </div>
    </nav>
  );
}
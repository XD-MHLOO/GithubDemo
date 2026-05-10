'use client';
import Link from 'next/link';
import { useState, useRef, useEffect } from 'react';

interface ProjectCardProps {
  id?: string;
  name: string;
  ref: string;
  status: 'running' | 'deploying' | 'failed' | 'fixing' | 'cancelled' | 'completed';
  lastUpdated: string;
  url?: string;
  icon: string;
  onTerminate?: (id: string) => void;
  onDelete?: (id: string) => void;
}

export default function ProjectCard({ 
  id, name, ref, status, lastUpdated, url, icon,
  onTerminate, onDelete
}: ProjectCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  
  const isDeploying = status === 'deploying';
  const isFailed = status === 'failed';
  const isFixing = status === 'fixing';
  const isCancelled = status === 'cancelled';
  const isCompleted = status === 'completed';
  const isRunning = status === 'running';
  
  // Close menu on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const getStatusConfig = () => {
    if (isFailed) return { color: 'text-error', bgColor: 'bg-error', text: 'Failed', icon: 'error' };
    if (isDeploying) return { color: 'text-warning', bgColor: 'bg-warning', text: 'Deploying', icon: 'progress_activity' };
    if (isFixing) return { color: 'text-tertiary', bgColor: 'bg-tertiary', text: 'Fixing', icon: 'build' };
    if (isCancelled) return { color: 'text-on-surface-variant', bgColor: 'bg-outline', text: 'Terminated', icon: 'cancel' };
    if (isCompleted) return { color: 'text-primary', bgColor: 'bg-primary', text: 'Completed', icon: 'task_alt' };
    return { color: 'text-success', bgColor: 'bg-success', text: 'Running', icon: 'check_circle' };
  };
  
  const statusConfig = getStatusConfig();
  
  const canTerminate = isRunning || isDeploying || isFixing;
  const canDelete = isCancelled || isCompleted || isFailed || isDeploying || isFixing;  
  
  return (
    <div className="bg-surface-container border border-outline-variant rounded-lg overflow-hidden flex flex-col group hover:border-primary/50 transition-colors">
      <div className="p-4 flex justify-between items-start border-b border-outline-variant">
        <div className="flex items-center gap-2">
          <div className="w-10 h-10 rounded bg-surface-container-highest border border-outline-variant flex items-center justify-center">
            <span className="material-symbols-outlined text-on-surface-variant">{icon}</span>
          </div>
          <div>
            <h3 className="font-headline-md text-base leading-none">
              {url ? (
                <a href={url} target="_blank" rel="noopener noreferrer" className="hover:text-primary transition-colors">
                  {name}
                </a>
              ) : (
                name
              )}
            </h3>
            <div className="flex items-center gap-1 mt-1">
              <span className="material-symbols-outlined text-xs text-slate-500">database</span>
              <span className="text-xs text-slate-500 font-code-sm">{ref}</span>
            </div>
          </div>
        </div>
        
        {/* Dropdown Menu */}
        <div ref={menuRef} className="relative">
          <button 
            onClick={() => setMenuOpen(!menuOpen)}
            className="material-symbols-outlined text-slate-500 hover:text-white cursor-pointer p-1 rounded hover:bg-surface-container-highest transition-colors"
          >
            more_vert
          </button>
          
          {menuOpen && (
              <div className="absolute right-0 top-8 w-44 bg-surface-container-highest border border-outline-variant rounded-lg shadow-xl z-50 py-1">
                  {canTerminate && (
                      <button
                          onClick={() => { onTerminate?.(id!); setMenuOpen(false); }}
                          className="w-full text-left px-4 py-2 text-sm text-error hover:bg-error/10 transition-colors flex items-center gap-2"
                      >
                          <span className="material-symbols-outlined text-sm">stop_circle</span>
                          Terminate
                      </button>
                  )}
                  {canDelete && (
                      <button
                          onClick={() => { onDelete?.(id!); setMenuOpen(false); }}
                          className="w-full text-left px-4 py-2 text-sm text-error hover:bg-error/10 transition-colors flex items-center gap-2"
                      >
                          <span className="material-symbols-outlined text-sm">delete</span>
                          {isDeploying || isFixing ? 'Force Delete' : 'Delete'}
                      </button>
                  )}
              </div>
          )}
        </div>
      </div>
      
      <div className="p-4 flex-1">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${statusConfig.bgColor} ${isDeploying || isFixing ? 'animate-pulse' : ''}`}></div>
            <span className={`text-xs font-label-caps ${statusConfig.color}`}>{statusConfig.text}</span>
          </div>
          <div className="flex items-center gap-1 text-on-surface-variant">
            <span className="material-symbols-outlined text-sm">schedule</span>
            <span className="text-[10px] font-code-sm">{lastUpdated}</span>
          </div>
        </div>
        
        <div className="bg-surface-container-low rounded p-2 border border-slate-800 min-h-[60px]">
          {isDeploying && <div className="font-code-sm text-[11px] text-warning/80"><span className="animate-pulse">&gt; Deploying...</span></div>}
          {isFailed && <div className="font-code-sm text-[11px] text-error/80">&gt; Deployment failed</div>}
          {isFixing && <div className="font-code-sm text-[11px] text-tertiary/80"><span className="animate-pulse">&gt; Applying fixes...</span></div>}
          {isCancelled && <div className="font-code-sm text-[11px] text-on-surface-variant/80">&gt; Terminated by user</div>}
          {isCompleted && <div className="font-code-sm text-[11px] text-primary/80">&gt; Deployment completed</div>}
          {isRunning && <div className="font-code-sm text-[11px] text-success/80">&gt; Running normally</div>}
        </div>
      </div>
      
      <div className="p-4 bg-surface-container-low border-t border-outline-variant flex items-center justify-between">
        <span className="material-symbols-outlined text-slate-500">settings_ethernet</span>
        {id ? (
          <Link href={`/projects/${id}`} className="text-xs font-label-caps text-primary hover:text-primary-container transition-colors flex items-center gap-1">
            MANAGE <span className="material-symbols-outlined text-sm">chevron_right</span>
          </Link>
        ) : (
          <button className="text-xs font-label-caps text-primary hover:text-primary-container transition-colors flex items-center gap-1">
            MANAGE <span className="material-symbols-outlined text-sm">chevron_right</span>
          </button>
        )}
      </div>
    </div>
  );
}
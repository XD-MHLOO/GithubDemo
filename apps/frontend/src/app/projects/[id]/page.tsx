'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'next/navigation';
import TopNavBar from '@/components/TopNavBar';
import SideNavBar from '@/components/SideNavBar';
import Link from 'next/link';
import { useSidebar } from '@/context/SidebarContext';

interface TimelineEvent {
  id: string;
  timestamp: string;
  stage: string;
  status: 'completed' | 'in-progress' | 'failed' | 'pending';
  message: string;
  details?: string;
  duration?: string;
}

interface LogEntry {
  timestamp: string;
  level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
  message: string;
  stream?: 'stdout' | 'stderr';
}

export default function ProjectDetailPage() {
  const { collapsed } = useSidebar();
  const params = useParams();
  const projectId = params.id as string;
  const eventSourceRef = useRef<EventSource | null>(null);
  
  const [project, setProject] = useState<any>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'overview' | 'timeline'>('overview');
  const [logFilter, setLogFilter] = useState<string>('all');
  const [isTerminating, setIsTerminating] = useState(false);
  const [isFixing, setIsFixing] = useState(false);
  const [elapsed, setElapsed] = useState('');


  // Calculate elapsed time
  useEffect(() => {
      if (!project?.createdAt) return;
      
      const updateElapsed = () => {
          const start = new Date(project.createdAt).getTime();
          
          if (project.completedAt) {
              const end = new Date(project.completedAt).getTime();
              const totalMinutes = Math.floor((end - start) / 60000);
              const hours = Math.floor(totalMinutes / 60);
              const minutes = totalMinutes % 60;
              setElapsed(hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`);
              return;
          }
          
          const now = Date.now();
          const totalMinutes = Math.floor((now - start) / 60000);
          const hours = Math.floor(totalMinutes / 60);
          const minutes = totalMinutes % 60;
          setElapsed(hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`);
      };
      
      updateElapsed();
      const interval = setInterval(updateElapsed, 10000);
      return () => clearInterval(interval);
  }, [project?.createdAt, project?.completedAt]);

  const exportLogs = () => {
      const logText = logs.map(l => 
          `[${l.timestamp}] [${l.level}] ${l.message}`
      ).join('\n');
      
      const blob = new Blob([logText], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `deployment-${projectId}-logs.txt`;
      a.click();
      URL.revokeObjectURL(url);
  };

  // Fetch initial project details
  const fetchProjectDetails = useCallback(async () => {
    try {
      setIsLoading(true);
      const response = await fetch(`/api/deployments/${projectId}`);
        if (!response.ok) {
            if (response.status === 404) {
                setProject(null);  // Set to null to show "not found"
                setIsLoading(false);
                return;
            }
            throw new Error('Failed to fetch project details');
        }
        const data = await response.json();
        console.log('Fetched project data:', data);  // Debug
        console.log('Has githubUrl:', !!data.githubUrl);
        console.log('Keys:', Object.keys(data));
        console.log('createdAt:', data.createdAt);
console.log('status:', data.status);
console.log('config:', data.config);
      setProject(data);
      
      // Set timeline from backend
      if (data.timeline) {
        setTimeline(data.timeline.map((event: any) => ({
          id: event.id,
          timestamp: new Date(event.timestamp).toLocaleTimeString(),
          stage: event.stage || event.type?.toUpperCase() || '',
          status: event.status || 'completed',
          message: event.message,
          details: event.details,
          duration: event.metadata?.duration,
        })));
      }
      
      // Set logs from backend
      if (data.logs) {
        setLogs(data.logs.map((log: any) => ({
          timestamp: new Date(log.timestamp).toLocaleTimeString(),
          level: log.level,
          message: log.message,
          stream: log.stream,
        })));
      }
    } catch (error) {
      console.error('Error fetching project details:', error);
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  // Connect to SSE for real-time updates
  const connectToSSE = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const eventSource = new EventSource(`/api/deployments/${projectId}/stream`);
    eventSourceRef.current = eventSource;
    let counter = 0;
    eventSource.onmessage = (event) => {
      counter++;
      const data = JSON.parse(event.data);
      
      // Update timeline
      if (data.type !== 'log') {
          setTimeline((prev) => [...prev, {
              id: `${Date.now()}-${counter}`,
              timestamp: new Date(data.timestamp).toLocaleTimeString(),
              stage: data.data?.stage || data.type?.toUpperCase() || '',
              status: data.data?.status || (data.type === 'error' ? 'failed' : 'completed'),
              message: data.data?.message || data.type,
              details: data.data?.details,
              duration: data.data?.duration,
          }]);
      }

      // Update logs if it's a log event
      if (data.type === 'log') {
        setLogs((prev) => [...prev, {
          timestamp: new Date(data.timestamp).toLocaleTimeString(),
          level: data.data?.level || 'INFO',
          message: data.data?.message,
          stream: data.data?.stream || 'stdout',
        }]);
      }

      // Update project status
    if (data.type === 'deployment_ready' ||     
        data.type === 'deployment_cancelled' ||   
        data.type === 'deployment_stopped') {
        fetchProjectDetails();
    }
    };

    eventSource.onerror = () => {
      console.log('SSE connection error, reconnecting...');
      eventSource.close();
      setTimeout(connectToSSE, 3000);
    };

    return eventSource;
  }, [projectId, fetchProjectDetails]);

  useEffect(() => {
    fetchProjectDetails();
    const eventSource = connectToSSE();
    
    return () => {
      eventSource.close();
    };
  }, [projectId, fetchProjectDetails, connectToSSE]);

  // Auto-scroll logs to bottom
  useEffect(() => {
    const logContainer = document.getElementById('log-container');
    if (logContainer) {
      logContainer.scrollTop = logContainer.scrollHeight;
    }
  }, [logs]);

  if (isLoading) {
    return (
      <>
        <TopNavBar />
        <SideNavBar />
          <main className={`${collapsed ? 'ml-16' : 'ml-64'} mt-14 p-6 bg-surface-dim min-h-screen transition-all duration-300`}>
          <div className="flex justify-center items-center h-96">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
          </div>
        </main>
      </>
    );
  }

  if (!project || !project.githubUrl) {
    return (
      <>
        <TopNavBar />
        <SideNavBar />
        <main className={`${collapsed ? 'ml-16' : 'ml-64'} mt-14 p-6 transition-all duration-300`}>
          <div className="text-center">
            <h2 className="text-2xl font-bold">Project not found</h2>
            <Link href="/" className="text-primary hover:underline mt-4 inline-block">
              ← Back to projects
            </Link>
          </div>
        </main>
      </>
    );
  }

  const repoName = project.githubUrl.split('/').pop()?.replace('.git', '') || 'unknown';
  const filteredLogs = logFilter === 'all' 
    ? logs 
    : logs.filter(log => log.level === logFilter);

  const isDone = project.status === 'CANCELLED' || 
              project.status === 'COMPLETED' || 
              project.status === 'FAILED';

  const isTerminatingNow = project.status === 'PROCESSING' && 
                          project.currentStage === 'terminating';
                          
  return (
    <>
      <TopNavBar />
      <SideNavBar />
      <main className={`${collapsed ? 'ml-16' : 'ml-64'} mt-14 p-6 bg-surface-dim min-h-screen transition-all duration-300`}>
        {/* Breadcrumb */}
        <div className="mb-6">
          <Link 
            href="/" 
            className="text-on-surface-variant hover:text-primary transition-colors flex items-center gap-2 font-code-sm text-sm"
          >
            <span className="material-symbols-outlined text-sm">arrow_back</span>
            Back to Projects
          </Link>
        </div>

        {/* Project Header */}
        <header className="mb-8">
          <div className="flex items-start justify-between mb-4">
            <div className="flex gap-2">
              {/* FIX Button */}
              <button 
                onClick={async () => {
                  setIsFixing(true);
                  try {
                    await fetch(`/api/deployments/${projectId}/fix`, { method: 'POST' });
                    await fetchProjectDetails();
                  } finally {
                    setIsFixing(false);
                  }
                }}
                disabled={project.status !== 'SUCCESS' || isFixing}
                className={`font-label-caps px-4 py-2 rounded transition-all flex items-center gap-2 ${
                  project.status === 'SUCCESS' && !isFixing
                    ? 'bg-warning/20 text-warning hover:bg-warning/30 cursor-pointer' 
                    : 'bg-outline-variant/10 text-on-surface-variant/30 cursor-not-allowed'
                }`}
              >
                <span className={`material-symbols-outlined text-sm ${isFixing ? 'animate-spin' : ''}`}>
                  {isFixing ? 'progress_activity' : 'build'}
                </span>
                {isFixing ? 'FIXING...' : 'FIX'}
              </button>

              {/* TERMINATE Button */}
              <button 
                onClick={async () => {
                    try {
                        await fetch(`/api/deployments/${projectId}/terminate`, { method: 'POST' });
                        await fetchProjectDetails(); // Refresh to get new status
                    } catch (error) {
                        console.error('Terminate failed:', error);
                    }
                }}
                disabled={isDone || isTerminatingNow}
                className={`font-label-caps px-4 py-2 rounded transition-all flex items-center gap-2 ${
                    !isDone && !isTerminatingNow
                        ? 'bg-error/10 text-error hover:bg-error/20 cursor-pointer' 
                        : 'bg-outline-variant/10 text-on-surface-variant/30 cursor-not-allowed'
                }`}
            >
                <span className={`material-symbols-outlined text-sm ${isTerminatingNow ? 'animate-spin' : ''}`}>
                    {isTerminatingNow ? 'progress_activity' : 'stop_circle'}
                </span>
                {isTerminatingNow ? 'TERMINATING...' : 'TERMINATE'}
            </button>
            </div>
          </div>
        </header>

        {/* Tabs */}
        <div className="flex gap-1 mb-6 border-b border-outline-variant">
          {(['overview', 'timeline'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-6 py-3 font-label-caps text-sm transition-all border-b-2 ${
                activeTab === tab
                  ? 'border-primary text-primary'
                  : 'border-transparent text-on-surface-variant hover:text-on-surface'
              }`}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-12 gap-6">
          {/* Main Content Area */}
          <div className="col-span-12 lg:col-span-8 space-y-6">
            {/* Overview Tab */}
            {activeTab === 'overview' && (
              <>
                {/* Quick Stats */}
                <div className="grid grid-cols-3 gap-4">
                {/* Started */}
                <div className="bg-surface-container border border-outline-variant p-4 rounded-lg">
                    <span className="text-xs text-on-surface-variant font-label-caps">STARTED</span>
                    <div className="text-lg font-headline-md text-on-surface mt-1">
                        {project.createdAt ? new Date(project.createdAt).toLocaleTimeString() : '--'}
                    </div>
                </div>

                {/* Elapsed */}
                <div className="bg-surface-container border border-outline-variant p-4 rounded-lg">
                    <span className="text-xs text-on-surface-variant font-label-caps">TIME ELAPSED</span>
                    <div className="text-lg font-headline-md mt-1">
                        {project.completedAt ? (
                            <span className="text-on-surface">{elapsed} <span className="text-xs text-on-surface-variant">(done)</span></span>
                        ) : (
                            <span className="text-success">{elapsed || '--'}<span className="animate-pulse ml-2 text-xs">●</span></span>
                        )}
                    </div>
                </div>

                {/* Status */}
                <div className="bg-surface-container border border-outline-variant p-4 rounded-lg">
                    <span className="text-xs text-on-surface-variant font-label-caps">STATUS</span>
                    <div className="mt-2">
                        <span className={`px-3 py-1 rounded-full text-xs font-label-caps ${
                            project.status === 'SUCCESS' ? 'bg-success/10 text-success border border-success/20' :
                            project.status === 'CANCELLED' ? 'bg-warning/10 text-warning border border-warning/20' :
                            project.status === 'COMPLETED' ? 'bg-primary/10 text-primary border border-primary/20' :
                            project.status === 'FAILED' ? 'bg-error/10 text-error border border-error/20' :
                            'bg-warning/10 text-warning border border-warning/20'
                        }`}>
                            {project.status}
                        </span>
                    </div>
                </div>
            </div>

                {/* Deployment URLs */}
                {project.urls && project.urls.length > 0 && (
                  <div className="bg-surface-container border border-outline-variant rounded-lg p-6">
                    <h3 className="font-headline-md text-lg text-on-surface mb-4">Deployed Services</h3>
                    <div className="space-y-3">
                      {project.urls.map((url: any, idx: number) => (
                        <div key={idx} className="flex items-center justify-between py-3 border-b border-outline-variant/30 last:border-0">
                          <div className="flex items-center gap-3">
                            {/* Status indicator */}
                            <div className={`w-2.5 h-2.5 rounded-full ${
                              url.reachable === false ? 'bg-error' : 'bg-success'
                            } ${project.status === 'PROCESSING' ? 'animate-pulse' : ''}`}></div>
                            <div>
                              <p className="font-code-sm text-on-surface text-sm">{url.service || url.url}</p>
                              <a 
                                href={url.url} 
                                target="_blank" 
                                rel="noopener noreferrer"
                                className="text-xs text-primary hover:underline font-code-sm"
                              >
                                {url.url}
                              </a>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {url.reachable === false ? (
                              <span className="text-xs text-error font-label-caps bg-error/10 px-2 py-1 rounded">Offline</span>
                            ) : (
                              <span className="text-xs text-success font-label-caps bg-success/10 px-2 py-1 rounded">Running</span>
                            )}
                            <a 
                              href={url.url} 
                              target="_blank" 
                              rel="noopener noreferrer"
                              className="material-symbols-outlined text-on-surface-variant hover:text-primary text-sm"
                            >
                              open_in_new
                            </a>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Deployment Info */}
                <div className="bg-surface-container border border-outline-variant rounded-lg p-6">
                  <h3 className="font-headline-md text-lg text-on-surface mb-4">Deployment Configuration</h3>
                  <div className="space-y-3">
                      <div className="flex justify-between items-center py-2 border-b border-outline-variant/30">
                          <span className="text-on-surface-variant">Repository</span>
                          <span className="font-code-sm text-on-surface text-right max-w-[60%] truncate">{project.githubUrl}</span>
                      </div>
                      <div className="flex justify-between items-center py-2 border-b border-outline-variant/30">
                          <span className="text-on-surface-variant">Ref</span>
                          <span className="font-code-sm text-primary">{project.ref || 'main'}</span>
                      </div>
                      <div className="flex justify-between items-center py-2 border-b border-outline-variant/30">
                          <span className="text-on-surface-variant">Timeout</span>
                          <span className="font-code-sm text-on-surface">
                              {project.config?.timeoutMinutes || 60} minutes
                          </span>
                      </div>
                      <div className="flex justify-between items-center py-2 border-b border-outline-variant/30">
                          <span className="text-on-surface-variant">Resources</span>
                          <span className="font-code-sm text-on-surface">
                              {project.config?.cpuLimit || 1} CPU · {project.config?.memoryLimit || '1G'}
                          </span>
                      </div>
                      {project.config?.webhookUrl && (
                          <div className="flex justify-between items-center py-2 border-b border-outline-variant/30">
                              <span className="text-on-surface-variant">Webhook</span>
                              <button
                                  onClick={() => {
                                      navigator.clipboard.writeText(project.config.webhookUrl);
                                  }}
                                  className="font-code-sm text-primary hover:text-primary-container transition-colors flex items-center gap-1 max-w-[70%] cursor-pointer group"
                                  title="Click to copy"
                              >
                                  <span className="truncate">{project.config.webhookUrl}</span>
                                  <span className="material-symbols-outlined text-xs text-on-surface-variant/0 group-hover:text-on-surface-variant/50 transition-all shrink-0">
                                      content_copy
                                  </span>
                                  <span className="absolute -bottom-6 left-1/2 -translate-x-1/2 text-[10px] text-success opacity-0 group-active:opacity-100 transition-opacity whitespace-nowrap">
                                      Copied!
                                  </span>
                              </button>
                          </div>
                      )}
                  </div>
              </div>
              </>
            )}

            {/* Timeline Tab - Temporal-like visualization */}
            {activeTab === 'timeline' && (
              <div className="bg-surface-container border border-outline-variant rounded-lg p-6">
                <h3 className="font-headline-md text-lg text-on-surface mb-6">Execution Timeline</h3>
                <div className="relative">
                  {/* Vertical line */}
                  <div className="absolute left-4 top-0 bottom-0 w-0.5 bg-outline-variant"></div>
                  
                  <div className="space-y-6">
                    {timeline.map((event, idx) => (
                      <div key={event.id || idx} className="relative pl-12">
                        {/* Circle indicator */}
                        <div className={`absolute left-2.5 w-3 h-3 rounded-full border-2 bg-surface-container ${
                          event.status === 'completed' ? 'border-success bg-success' :
                          event.status === 'in-progress' ? 'border-primary bg-primary animate-pulse' :
                          event.status === 'failed' ? 'border-error bg-error' :
                          'border-outline-variant'
                        }`}></div>
                        
                        <div className="bg-surface-container-low border border-outline-variant rounded-lg p-4">
                          <div className="flex items-start justify-between mb-2">
                            <div>
                              <span className="font-label-caps text-sm text-primary">{event.stage}</span>
                              <span className={`ml-3 text-xs px-2 py-0.5 rounded-full ${
                                event.status === 'completed' ? 'bg-success/10 text-success' :
                                event.status === 'in-progress' ? 'bg-primary/10 text-primary' :
                                event.status === 'failed' ? 'bg-error/10 text-error' :
                                'bg-surface-container-highest text-on-surface-variant'
                              }`}>
                                {event.status}
                              </span>
                            </div>
                            <span className="font-code-sm text-xs text-on-surface-variant">
                              {event.timestamp}
                              {event.duration && ` • ${event.duration}`}
                            </span>
                          </div>
                          <p className="text-on-surface text-sm">{event.message}</p>
                          {event.details && (
                            <p className="mt-2 font-code-sm text-xs text-on-surface-variant">{event.details}</p>
                          )}
                        </div>
                      </div>
                    ))}
                    
                    {timeline.length === 0 && (
                      <div className="text-center text-on-surface-variant py-8">
                        No timeline events yet
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Logs Sidebar */}
          <div className="col-span-12 lg:col-span-4">
            <div className="bg-surface-container-lowest border border-outline-variant rounded-lg overflow-hidden sticky top-20">
              {/* Log Header */}
              <div className="bg-surface-container-highest px-4 py-3 border-b border-outline-variant flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-primary text-sm">terminal</span>
                  <span className="font-label-caps text-xs text-on-surface">DEPLOYMENT LOGS</span>
                </div>
                <div className="flex items-center gap-2">
                  {/* Log level filter */}
                  <select 
                    value={logFilter}
                    onChange={(e) => setLogFilter(e.target.value)}
                    className="bg-surface-container border border-outline-variant rounded px-2 py-1 text-xs font-code-sm text-on-surface-variant"
                  >
                    <option value="all">ALL</option>
                    <option value="INFO">INFO</option>
                    <option value="WARN">WARN</option>
                    <option value="ERROR">ERROR</option>
                    <option value="DEBUG">DEBUG</option>
                  </select>
                  <div className="flex gap-1">
                    <div className="w-2 h-2 rounded-full bg-success/60"></div>
                    <div className="w-2 h-2 rounded-full bg-warning/60"></div>
                    <div className="w-2 h-2 rounded-full bg-error/60"></div>
                  </div>
                </div>
              </div>

              {/* Log Content */}
              <div 
                id="log-container"
                className="p-4 font-code-sm text-xs space-y-1 overflow-y-auto max-h-[600px] bg-black/50"
              >
                {filteredLogs.map((log, idx) => (
                  <div key={idx} className="flex gap-2 hover:bg-surface-container-highest/10 py-0.5 px-1 rounded">
                    <span className="text-slate-600 shrink-0">{log.timestamp}</span>
                    <span className={`shrink-0 ${
                      log.level === 'ERROR' ? 'text-error' :
                      log.level === 'WARN' ? 'text-warning' :
                      log.level === 'DEBUG' ? 'text-slate-500' :
                      'text-secondary'
                    }`}>
                      [{log.level}]
                    </span>
                    {/* {log.stream && (
                      <span className="text-slate-500 shrink-0">[{log.stream}]</span>
                    )} */}
                    <span className="text-slate-300 break-all">{log.message}</span>
                  </div>
                ))}
                
                {/* Empty state */}
                {filteredLogs.length === 0 && (
                  <div className="text-slate-600 text-center py-8">
                    {logs.length === 0 
                      ? 'Waiting for agent logs...' 
                      : 'No logs matching filter'}
                  </div>
                )}
                
                {/* Live indicator */}
                {(project.status === 'PROCESSING' || project.status === 'PENDING') && (
                  <div className="flex items-center gap-2 text-slate-500 pt-2">
                    <span className="w-2 h-2 rounded-full bg-primary animate-pulse"></span>
                    <span>Streaming logs...</span>
                  </div>
                )}
              </div>

              {/* Log Actions */}
              <div className="bg-surface-container-highest px-4 py-2 border-t border-outline-variant flex items-center justify-between">
                <button 
                  onClick={fetchProjectDetails}
                  className="text-xs font-label-caps text-primary hover:text-primary-container transition-colors flex items-center gap-1"
                >
                  <span className="material-symbols-outlined text-sm">refresh</span>
                  REFRESH
                </button>
                <button onClick={exportLogs} className="text-xs font-label-caps text-on-surface-variant hover:text-on-surface transition-colors flex items-center gap-1">
                  <span className="material-symbols-outlined text-sm">download</span>
                  EXPORT
                </button>
              </div>
            </div>
          </div>
        </div>
      </main>
    </>
  );
}
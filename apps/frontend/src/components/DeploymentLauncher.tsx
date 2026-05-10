'use client';

import { useState, useEffect } from 'react';

interface DeploymentLauncherProps {
  isOpen: boolean;
  onClose: () => void;
  onDeploymentSuccess?: (deploymentId: string) => void;
}

export default function DeploymentLauncher({ isOpen, onClose, onDeploymentSuccess }: DeploymentLauncherProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repoUrl, setRepoUrl] = useState('');
  const [ref, setRef] = useState('');
  const [timeoutMinutes, setTimeoutMinutes] = useState(60);
  const [cpuLimit, setCpuLimit] = useState(1);
  const [memoryLimit, setMemoryLimit] = useState('1G');
  const [showWebhook, setShowWebhook] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState('');
  // Load saved settings when launcher opens
  useEffect(() => {
      if (isOpen) {
          const saved = localStorage.getItem('deployment-defaults');
          if (saved) {
              try {
                  const defaults = JSON.parse(saved);
                  setTimeoutMinutes(defaults.timeoutMinutes || 60);
                  setCpuLimit(defaults.cpuLimit || 1);
                  setMemoryLimit(defaults.memoryLimit || '1G');
                  setWebhookUrl(defaults.webhookUrl || '');
                  if (defaults.webhookUrl) setShowWebhook(true);
              } catch {}
          }
      }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };


  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);

    let githubUrl = repoUrl;
    let branchRef = ref;
    
    if (repoUrl.includes('/tree/')) {
      const parts = repoUrl.split('/tree/');
      githubUrl = parts[0];
      branchRef = parts[1].replace('.git', '');
    }
    
    githubUrl = githubUrl.replace('.git', '');

    try {
      const response = await fetch('/api/deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          repositoryUrl: githubUrl,
          ref: branchRef || ref,
          timeoutMinutes,
          cpuLimit,
          memoryLimit,
          webhookUrl: showWebhook ? webhookUrl : null,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Deployment failed');
      }

      const result = await response.json();
      if (onDeploymentSuccess && result.deploymentId) {
        onDeploymentSuccess(result.deploymentId);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start deployment');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <div 
        className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 transition-all duration-300"
        onClick={handleBackdropClick}
      />
      
      <div className="fixed inset-0 z-50 overflow-y-auto pointer-events-none">
        <div className="flex min-h-full items-center justify-center p-4 pointer-events-none">
          <div className="max-w-2xl w-full pointer-events-auto">
            <form onSubmit={handleSubmit}>
              <section className="bg-surface-container border border-outline-variant rounded-lg overflow-hidden shadow-2xl relative">
                {/* Header */}
                <div className="bg-surface-container-highest px-6 py-3 border-b border-outline-variant flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="flex gap-1.5">
                      <div className="w-3 h-3 rounded-full bg-error/40"></div>
                      <div className="w-3 h-3 rounded-full bg-tertiary/40"></div>
                      <div className="w-3 h-3 rounded-full bg-secondary/40"></div>
                    </div>
                    <span className="ml-4 font-label-caps text-label-caps text-on-surface-variant uppercase">Project Launcher</span>
                  </div>
                  <span className="font-code-sm text-code-sm text-secondary flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-secondary animate-pulse shadow-[0_0_8px_#4edea3]"></span>
                    SYSTEM_READY
                  </span>
                </div>
                
                <div className="p-8 space-y-6">
                  {error && (
                    <div className="bg-error-container/20 border border-error rounded-lg p-4 text-error text-sm">
                      <strong>Error:</strong> {error}
                    </div>
                  )}
                  
                  <div>
                    <h1 className="font-display-lg text-display-lg text-on-surface mb-2">Launch New Project</h1>
                    <p className="text-on-surface-variant text-body-base opacity-70">Enter your GitHub repository URL to start deployment.</p>
                  </div>
                  
                  {/* GitHub Repository URL */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <label className="font-label-caps text-label-caps text-primary uppercase">GitHub Repository URL</label>
                      <span className="text-xs text-on-surface-variant/50 font-code-sm">REQUIRED</span>
                    </div>
                    <div className="relative">
                      <span className="absolute left-4 top-1/2 -translate-y-1/2 material-symbols-outlined text-outline">link</span>
                      <input 
                        required
                        value={repoUrl}
                        onChange={(e) => setRepoUrl(e.target.value)}
                        className="w-full bg-surface-container-low border border-outline-variant rounded py-3 pl-12 pr-4 text-on-surface focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 transition-all font-code-sm" 
                        placeholder="https://github.com/organization/repository" 
                        type="text"
                      />
                    </div>
                  </div>
                  
                  {/* Branch/Tag */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <label className="font-label-caps text-label-caps text-on-surface-variant uppercase">Branch / Tag</label>
                      <span className="text-xs text-on-surface-variant/30 font-code-sm">OPTIONAL</span>
                    </div>
                    <div className="relative">
                      <span className="absolute left-4 top-1/2 -translate-y-1/2 material-symbols-outlined text-outline">fork_right</span>
                      <input 
                        value={ref}
                        onChange={(e) => setRef(e.target.value.trim().replace(/[^a-zA-Z0-9._/-]/g, ''))}
                        className="w-full bg-surface-container-low border border-outline-variant rounded py-3 pl-12 pr-4 text-on-surface focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20 transition-all font-code-sm" 
                        placeholder="main (default)" 
                        type="text"
                      />
                    </div>
                  </div>

                  {/* Configuration */}
                  <div className="grid grid-cols-3 gap-4">
                    <div className="space-y-2">
                      <label className="font-label-caps text-xs text-on-surface-variant uppercase">Timeout (min)</label>
                      <input type="number" min={1} max={1440} value={timeoutMinutes}
                        onChange={(e) => setTimeoutMinutes(parseInt(e.target.value) || 60)}
                        className="w-full bg-surface-container-low border border-outline-variant rounded py-2 px-3 text-on-surface text-sm focus:outline-none focus:border-primary/50"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="font-label-caps text-xs text-on-surface-variant uppercase">CPU Cores</label>
                      <select value={cpuLimit} onChange={(e) => setCpuLimit(parseFloat(e.target.value))}
                        className="w-full bg-surface-container-low border border-outline-variant rounded py-2 px-3 text-on-surface text-sm focus:outline-none focus:border-primary/50">
                        <option value={0.5}>0.5</option>
                        <option value={1}>1</option>
                        <option value={2}>2</option>
                        <option value={4}>4</option>
                      </select>
                    </div>
                    <div className="space-y-2">
                      <label className="font-label-caps text-xs text-on-surface-variant uppercase">Memory</label>
                      <select value={memoryLimit} onChange={(e) => setMemoryLimit(e.target.value)}
                        className="w-full bg-surface-container-low border border-outline-variant rounded py-2 px-3 text-on-surface text-sm focus:outline-none focus:border-primary/50">
                        <option value="512M">512 MB</option>
                        <option value="1G">1 GB</option>
                        <option value="2G">2 GB</option>
                        <option value="4G">4 GB</option>
                      </select>
                    </div>
                  </div>

                  {/* Webhook Toggle */}
                  <div className="border-t border-outline-variant/30 pt-4">
                    <button
                      type="button"
                      onClick={() => setShowWebhook(!showWebhook)}
                      className="flex items-center gap-2 text-xs font-label-caps text-on-surface-variant hover:text-primary transition-colors"
                    >
                      <span className="material-symbols-outlined text-sm">
                        {showWebhook ? 'remove_circle' : 'add_circle'}
                      </span>
                      {showWebhook ? 'Remove Webhook' : 'Add Webhook Notification'}
                    </button>
                    
                    {showWebhook && (
                        <div className="mt-3 space-y-2">
                            <div className="flex items-center gap-2">
                                <label className="font-label-caps text-xs text-on-surface-variant uppercase">Webhook URL</label>
                                {/* Help Icon with Tooltip */}
                                <div className="relative group">
                                    <span className="material-symbols-outlined text-xs text-on-surface-variant/50 cursor-help">help</span>
                                      <div className="absolute bottom-full left-0 mb-2 w-64 hidden group-hover:block z-50">
                                          <div className="bg-surface-container-highest border border-outline-variant/50 rounded-lg p-3 shadow-lg">
                                              <p className="font-label-caps text-[11px] text-on-surface mb-1.5">Webhook Payload</p>
                                              <pre className="text-on-surface-variant font-code-sm text-[10px] leading-relaxed">
{`{
  "deploymentId": "550e8400-...",
  "type": "deployment_ready",
  "data": { "urls": [...] },
  "timestamp": "2026-05-10T14:30:00Z"
}`}
                                              </pre>
                                              <div className="flex gap-1.5 mt-2 text-[9px] font-code-sm flex-wrap">
                                                  <span className="text-success">deployment_ready</span>
                                                  <span className="text-on-surface-variant/30">·</span>
                                                  <span className="text-error">deployment_cancelled</span>
                                                  <span className="text-on-surface-variant/30">·</span>
                                                  <span className="text-warning">deployment_stopped</span>
                                              </div>
                                          </div>
                                      </div>
                                </div>
                            </div>
                            <div className="relative">
                                <span className="absolute left-4 top-1/2 -translate-y-1/2 material-symbols-outlined text-outline text-sm">webhook</span>
                                <input 
                                    value={webhookUrl}
                                    onChange={(e) => setWebhookUrl(e.target.value)}
                                    className="w-full bg-surface-container-low border border-outline-variant rounded py-2 pl-12 pr-4 text-on-surface text-sm focus:outline-none focus:border-primary/50 transition-all font-code-sm" 
                                    placeholder="https://your-app.com/webhook" 
                                    type="url"
                                />
                            </div>
                        </div>
                    )}
                  </div>
                  
                  {/* Action Button */}
                  <div className="pt-4">
                    <button 
                      type="submit"
                      disabled={isSubmitting}
                      className="w-full bg-primary hover:bg-primary-container disabled:opacity-50 disabled:cursor-not-allowed text-on-primary-container font-headline-md py-4 rounded-lg flex items-center justify-center gap-3 transition-all active:scale-[0.98] shadow-lg shadow-primary/20"
                    >
                      {isSubmitting ? (
                        <><span className="material-symbols-outlined animate-spin">progress_activity</span>DEPLOYING...</>
                      ) : (
                        <><span className="material-symbols-outlined">rocket_launch</span>Start Deployment Process</>
                      )}
                    </button>
                  </div>
                </div>
              </section>
            </form>
          </div>
        </div>
      </div>
    </>
  );
}
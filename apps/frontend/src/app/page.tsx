'use client';

import { useState, useEffect, useCallback } from 'react';
import TopNavBar from '@/components/TopNavBar';
import SideNavBar from '@/components/SideNavBar';
import MetricsCards from '@/components/MetricsCards';
import ProjectCard from '@/components/ProjectCard';
import DeploymentLauncher from '@/components/DeploymentLauncher';
import { useSidebar } from '@/context/SidebarContext';

interface Deployment {
  id: string;
  jobId: string;
  githubUrl: string;
  ref: string;
  status: 'PENDING' | 'PROCESSING' | 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'COMPLETED';
  currentStage?: string;
  urls?: any;
  createdAt: string;
  completedAt?: string;
}

export default function Home() {
  const { collapsed } = useSidebar();
  const [isLauncherOpen, setIsLauncherOpen] = useState(false);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [lastDeploymentId, setLastDeploymentId] = useState<string | null>(null);

  const fetchDeployments = useCallback(async () => {
    try {
      setIsLoading(true);
      const response = await fetch('/api/deployments');
      if (!response.ok) throw new Error('Failed to fetch deployments');
      const data = await response.json();
      setDeployments(data);
    } catch (error) {
      console.error('Error fetching deployments:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDeployments();
  }, [fetchDeployments]);

  useEffect(() => {
      const interval = setInterval(() => fetchDeployments(), 10000);
      return () => clearInterval(interval);
  }, [fetchDeployments]);

  const handleDeploymentLaunched = (deploymentId: string) => {
    setLastDeploymentId(deploymentId);
    fetchDeployments();
  };

  const handleTerminate = async (deploymentId: string) => {
    await fetch(`/api/deployments/${deploymentId}/terminate`, { method: 'POST' });
    fetchDeployments();
  };

  const handleDelete = async (deploymentId: string) => {
    await fetch(`/api/deployments/${deploymentId}`, { method: 'DELETE' });
    fetchDeployments();
  };

  const transformToProjectCard = (deployment: Deployment) => {
    const repoName = deployment.githubUrl.split('/').pop()?.replace('.git', '') || 'unknown';
    
    let cardStatus: 'running' | 'deploying' | 'failed' | 'fixing' | 'cancelled' | 'completed' = 'running';
    
    switch (deployment.status) {
      case 'PENDING':
        cardStatus = 'deploying';
        break;
      case 'PROCESSING':
        cardStatus = deployment.currentStage === 'fixing' ? 'fixing' : 'deploying';
        break;
      case 'SUCCESS':
        cardStatus = 'running';
        break;
      case 'FAILED':
        cardStatus = 'failed';
        break;
      case 'CANCELLED':
        cardStatus = 'cancelled';
        break;
      case 'COMPLETED':
        cardStatus = 'completed';
        break;
    }

    let url = undefined;
    if (deployment.urls && Array.isArray(deployment.urls) && deployment.urls.length > 0) {
      url = deployment.urls[0].url;
    }

    return {
      name: repoName,
      ref: deployment.ref || 'main',
      status: cardStatus,
      lastUpdated: new Date(deployment.createdAt).toLocaleString(),
      url: url,
      icon: getIconForRepo(repoName),
    };
  };

  const getIconForRepo = (name: string): string => {
    if (name.includes('api')) return 'api';
    if (name.includes('dashboard')) return 'dashboard';
    if (name.includes('worker')) return 'memory';
    if (name.includes('auth')) return 'lock';
    return 'code';
  };

  const activeCount = deployments.filter(d => d.status === 'SUCCESS').length;
  const deployingCount = deployments.filter(d => d.status === 'PROCESSING' || d.status === 'PENDING').length;

  return (
    <>
      <TopNavBar />
      <SideNavBar />
      <main className={`${collapsed ? 'ml-16' : 'ml-64'} mt-14 p-6 bg-surface-dim min-h-[calc(100vh-3.5rem)] transition-all duration-300`}>        <header className="flex justify-between items-end mb-10">
          <div>
            <h1 className="font-headline-md text-headline-md text-on-surface mb-1">Active Projects</h1>
            <p className="text-on-surface-variant text-sm">
              {activeCount} active · {deployingCount} deploying
            </p>
          </div>
          <div className="flex gap-3">
            <button 
              onClick={fetchDeployments}
              disabled={isLoading}
              className="bg-surface-container hover:bg-surface-container-highest text-on-surface font-label-caps px-4 py-3 rounded transition-all active:scale-95 flex items-center gap-2"
            >
              <span className="material-symbols-outlined text-sm">refresh</span>
              REFRESH
            </button>
            <button 
              onClick={() => setIsLauncherOpen(true)}
              className="bg-primary hover:bg-primary-container text-on-primary font-label-caps px-6 py-3 rounded transition-all active:scale-95 flex items-center gap-2"
            >
              <span className="material-symbols-outlined">add</span>
              NEW PROJECT
            </button>
          </div>
        </header>

        <MetricsCards deployments={deployments} />

        {isLoading && deployments.length === 0 ? (
          <div className="flex justify-center items-center h-64">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {deployments.map((deployment) => {
              const project = transformToProjectCard(deployment);
              return (
                <ProjectCard 
                  key={deployment.id}
                  id={deployment.id}
                  name={project.name}
                  ref={project.ref}
                  status={project.status}
                  lastUpdated={project.lastUpdated}
                  url={project.url}
                  icon={project.icon}
                  onTerminate={handleTerminate}
                  onDelete={handleDelete}
                />
              );
            })}
            
            {deployments.length === 0 && !isLoading && (
              <div 
                onClick={() => setIsLauncherOpen(true)}
                className="bg-surface-dim border border-dashed border-outline-variant rounded-lg overflow-hidden flex flex-col items-center justify-center min-h-[220px] group hover:border-primary/50 transition-colors cursor-pointer"
              >
                <span className="material-symbols-outlined text-outline-variant group-hover:text-primary transition-colors mb-2" style={{ fontSize: 32 }}>add_box</span>
                <span className="font-label-caps text-on-surface-variant">DEPLOY FIRST PROJECT</span>
              </div>
            )}
          </div>
        )}

      </main>

      <DeploymentLauncher 
        isOpen={isLauncherOpen} 
        onClose={() => setIsLauncherOpen(false)}
        onDeploymentSuccess={handleDeploymentLaunched}
      />
    </>
  );
}
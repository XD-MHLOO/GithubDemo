'use client';

interface MetricsCardsProps {
  deployments: Array<{
    status: 'PENDING' | 'PROCESSING' | 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'COMPLETED'; 
  }>;
}

export default function MetricsCards({ deployments }: MetricsCardsProps) {
  const readyCount = deployments.filter(d => d.status === 'SUCCESS').length;
  const processingCount = deployments.filter(d => d.status === 'PROCESSING' || d.status === 'PENDING').length;
  const failedCount = deployments.filter(d => d.status === 'FAILED').length;
  
  return (
    <div className="grid grid-cols-12 gap-4 mb-8">
      <div className="col-span-12 md:col-span-4 bg-surface-container border border-outline-variant p-4 rounded-lg">
        <div className="flex justify-between items-start mb-4">
          <span className="font-label-caps text-on-surface-variant">RUNNING</span>
          <span className="material-symbols-outlined text-success">check_circle</span>
        </div>
        <div className="text-headline-md font-headline-md text-success">{readyCount}</div>
      </div>

      <div className="col-span-12 md:col-span-4 bg-surface-container border border-outline-variant p-4 rounded-lg">
        <div className="flex justify-between items-start mb-4">
          <span className="font-label-caps text-on-surface-variant">PROCESSING</span>
          <span className="material-symbols-outlined text-warning animate-spin">progress_activity</span>
        </div>
        <div className="text-headline-md font-headline-md text-warning">{processingCount}</div>
      </div>

      <div className="col-span-12 md:col-span-4 bg-surface-container border border-outline-variant p-4 rounded-lg">
        <div className="flex justify-between items-start mb-4">
          <span className="font-label-caps text-on-surface-variant">FAILED</span>
          <span className="material-symbols-outlined text-error">error</span>
        </div>
        <div className="text-headline-md font-headline-md text-error">{failedCount}</div>
      </div>
    </div>
  );
}
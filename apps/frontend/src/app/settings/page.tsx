'use client';

import { useState, useEffect } from 'react';
import TopNavBar from '@/components/TopNavBar';
import SideNavBar from '@/components/SideNavBar';
import { useSidebar } from '@/context/SidebarContext';

export default function SettingsPage() {
  const { collapsed } = useSidebar();
  const [saved, setSaved] = useState(false);
  const [config, setConfig] = useState({
    timeoutMinutes: 60,
    cpuLimit: 1,
    memoryLimit: '1G',
    webhookUrl: '',
  });

  // Load saved settings from localStorage
  useEffect(() => {
    const saved = localStorage.getItem('deployment-defaults');
    if (saved) {
      try { setConfig(JSON.parse(saved)); } catch {}
    }
  }, []);

  const saveSettings = () => {
    localStorage.setItem('deployment-defaults', JSON.stringify(config));
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <>
      <TopNavBar />
      <SideNavBar />
      <main className={`${collapsed ? 'ml-16' : 'ml-64'} mt-14 p-6 bg-surface-dim min-h-screen transition-all duration-300`}>
        <h1 className="font-headline-md text-2xl text-on-surface mb-8">Default Deployment Settings</h1>
        
        <div className="max-w-2xl space-y-6">
          <div className="bg-surface-container border border-outline-variant rounded-lg p-6">
            <h3 className="font-headline-md text-lg text-on-surface mb-4">Resources</h3>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="font-label-caps text-xs text-on-surface-variant uppercase">Timeout (min)</label>
                <input type="number" min={1} max={1440} value={config.timeoutMinutes}
                  onChange={(e) => setConfig({...config, timeoutMinutes: parseInt(e.target.value) || 60})}
                  className="w-full bg-surface-container-low border border-outline-variant rounded py-2 px-3 text-on-surface text-sm"
                />
              </div>
              <div className="space-y-2">
                <label className="font-label-caps text-xs text-on-surface-variant uppercase">CPU Cores</label>
                <select value={config.cpuLimit}
                  onChange={(e) => setConfig({...config, cpuLimit: parseFloat(e.target.value)})}
                  className="w-full bg-surface-container-low border border-outline-variant rounded py-2 px-3 text-on-surface text-sm">
                  <option value={0.5}>0.5</option>
                  <option value={1}>1</option>
                  <option value={2}>2</option>
                  <option value={4}>4</option>
                </select>
              </div>
            </div>
            <div className="mt-4 space-y-2">
              <label className="font-label-caps text-xs text-on-surface-variant uppercase">Memory</label>
              <select value={config.memoryLimit}
                onChange={(e) => setConfig({...config, memoryLimit: e.target.value})}
                className="w-full bg-surface-container-low border border-outline-variant rounded py-2 px-3 text-on-surface text-sm">
                <option value="512M">512 MB</option>
                <option value="1G">1 GB</option>
                <option value="2G">2 GB</option>
                <option value="4G">4 GB</option>
              </select>
            </div>
          </div>

          <div className="bg-surface-container border border-outline-variant rounded-lg p-6">
            <h3 className="font-headline-md text-lg text-on-surface mb-4">Notifications</h3>
            <div className="space-y-2">
              <label className="font-label-caps text-xs text-on-surface-variant uppercase">Default Webhook URL</label>
              <input type="url" value={config.webhookUrl}
                onChange={(e) => setConfig({...config, webhookUrl: e.target.value})}
                placeholder="https://your-app.com/webhook (optional)"
                className="w-full bg-surface-container-low border border-outline-variant rounded py-2 px-3 text-on-surface text-sm"
              />
            </div>
          </div>

          <button onClick={saveSettings}
            className="bg-primary hover:bg-primary-container text-on-primary font-label-caps px-6 py-3 rounded transition-all active:scale-95">
            {saved ? '✓ SAVED' : 'SAVE SETTINGS'}
          </button>
        </div>
      </main>
    </>
  );
}
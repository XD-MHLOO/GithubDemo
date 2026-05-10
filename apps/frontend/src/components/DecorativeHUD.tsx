'use client';

export default function DecorativeHUD() {
  return (
    <>
      {/* Decorative HUD Elements */}
      <div className="fixed bottom-6 right-6 z-10 pointer-events-none opacity-20">
        <div className="relative w-32 h-32">
          <div className="absolute inset-0 border-4 border-dashed border-primary rounded-full animate-[spin_20s_linear_infinite]"></div>
          <div className="absolute inset-4 border-2 border-secondary/50 rounded-full animate-[spin_10s_linear_infinite_reverse]"></div>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-[10px] font-code-sm text-primary">SCANNING_</span>
          </div>
        </div>
      </div>
      
      <div className="fixed top-20 right-8 z-10 hidden xl:block">
        <div className="bg-surface-container border border-outline-variant p-4 w-48 space-y-3">
          <div className="h-1 w-full bg-outline-variant rounded-full overflow-hidden">
            <div className="h-full bg-secondary w-[65%]"></div>
          </div>
          <div className="flex justify-between font-code-sm text-[10px]">
            <span>CPU_LOAD</span>
            <span className="text-secondary">65.2%</span>
          </div>
          <div className="h-1 w-full bg-outline-variant rounded-full overflow-hidden">
            <div className="h-full bg-primary w-[32%]"></div>
          </div>
          <div className="flex justify-between font-code-sm text-[10px]">
            <span>MEM_USE</span>
            <span className="text-primary">32.8%</span>
          </div>
        </div>
      </div>
    </>
  );
}
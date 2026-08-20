export function renderAutonomy(outlet) {
  outlet.innerHTML = \`
    <div class="p-6">
      <div class="mb-6 flex items-center justify-between">
        <div>
          <h2 class="text-lg font-semibold text-text-primary">Autonomy Metrics</h2>
          <p class="text-sm text-text-dim">Sprint 6 Success Metrics computed from historical decisions</p>
        </div>
        <button id="refresh-autonomy" class="px-3 py-1.5 bg-base-800 hover:bg-base-700 border border-line rounded-md text-xs font-medium transition">
          Refresh
        </button>
      </div>
      
      <div class="grid grid-cols-4 gap-4 mb-6" id="autonomy-cards">
        <div class="bg-base-900 border border-line rounded-lg p-5">
          <div class="text-xs text-text-dim mb-1">Autonomous Resolution</div>
          <div class="text-2xl font-bold text-text-primary" id="metric-rate">--</div>
          <div class="text-[11px] text-text-muted mt-2">Target: >60%</div>
        </div>
        <div class="bg-base-900 border border-line rounded-lg p-5">
          <div class="text-xs text-text-dim mb-1">False Resolve Rate</div>
          <div class="text-2xl font-bold text-text-primary" id="metric-false">--</div>
          <div class="text-[11px] text-text-muted mt-2">Target: <5%</div>
        </div>
        <div class="bg-base-900 border border-line rounded-lg p-5">
          <div class="text-xs text-text-dim mb-1">MTTR</div>
          <div class="text-2xl font-bold text-text-primary" id="metric-mttr">--</div>
          <div class="text-[11px] text-text-muted mt-2">Target: <15m</div>
        </div>
        <div class="bg-base-900 border border-line rounded-lg p-5">
          <div class="text-xs text-text-dim mb-1">Tool Coverage</div>
          <div class="flex gap-2 mt-2" id="metric-layers">
            <span class="px-2 py-0.5 rounded bg-base-800 text-xs text-text-dim" id="layer-linux">LNX</span>
            <span class="px-2 py-0.5 rounded bg-base-800 text-xs text-text-dim" id="layer-docker">DCK</span>
            <span class="px-2 py-0.5 rounded bg-base-800 text-xs text-text-dim" id="layer-k8s">K8S</span>
            <span class="px-2 py-0.5 rounded bg-base-800 text-xs text-text-dim" id="layer-cloud">CLD</span>
          </div>
          <div class="text-[11px] text-text-muted mt-2">Linux, Docker, K8s, Cloud</div>
        </div>
      </div>
    </div>
  \`;

  async function load() {
    const rateEl = document.getElementById('metric-rate');
    const falseEl = document.getElementById('metric-false');
    const mttrEl = document.getElementById('metric-mttr');
    if (!rateEl) return;

    try {
      const res = await fetch('/api/metrics/autonomy');
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      
      rateEl.textContent = (data.autonomousResolutionRate * 100).toFixed(1) + '%';
      rateEl.className = \`text-2xl font-bold \${data.autonomousResolutionRate >= 0.6 ? 'text-ok' : 'text-warn'}\`;
      
      falseEl.textContent = (data.falseResolveRate * 100).toFixed(1) + '%';
      falseEl.className = \`text-2xl font-bold \${data.falseResolveRate <= 0.05 ? 'text-ok' : 'text-warn'}\`;
      
      mttrEl.textContent = data.mttrMinutes !== null ? data.mttrMinutes.toFixed(1) + 'm' : 'N/A';
      mttrEl.className = \`text-2xl font-bold \${data.mttrMinutes !== null && data.mttrMinutes <= 15 ? 'text-ok' : 'text-warn'}\`;

      ['linux', 'docker', 'kubernetes', 'cloud'].forEach(k => {
        const span = document.getElementById('layer-' + (k==='kubernetes'?'k8s':k));
        if (span) {
          span.className = \`px-2 py-0.5 rounded text-xs \${data.layerCoverage[k] ? 'bg-accent-600/20 text-accent-400' : 'bg-base-800 text-text-dim'}\`;
        }
      });
    } catch (e) {
      rateEl.textContent = 'Err';
    }
  }

  load();
  document.getElementById('refresh-autonomy').addEventListener('click', load);

  return () => {};
}

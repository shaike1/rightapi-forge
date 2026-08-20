// ReportFormatter — pure functions that render a ReportData payload into
// one of three formats. Stateless, no I/O, no side effects: feed in a
// ReportData and get back a string. The scheduler picks the format per
// channel (HTML for email, Markdown for chat/Telegram, JSON for webhooks).

import type { ReportData } from './ReportTypes.js';

// ── Markdown ──────────────────────────────────────────────────────────

export function renderMarkdown(report: ReportData): string {
  const lines: string[] = [];
  lines.push(`# ${reportTitle(report)} — ${report.period.label}`);
  lines.push('');
  lines.push(`_Generated ${report.generatedAt}_`);
  lines.push('');

  lines.push('## Incidents');
  lines.push(`- Created: **${report.incidents.createdInPeriod}**`);
  lines.push(`- Resolved: **${report.incidents.resolvedInPeriod}**`);
  lines.push(`- Active (at end of period): **${report.incidents.activeAtEnd}**`);
  const sevs = report.incidents.activeBySeverity;
  lines.push(`  - critical=${sevs.critical}, high=${sevs.high}, medium=${sevs.medium}, low=${sevs.low}`);
  if (report.incidents.topRecurring.length > 0) {
    lines.push('- Top recurring:');
    for (const r of report.incidents.topRecurring) {
      lines.push(`  - ${escapeMd(r.title)} (×${r.count})`);
    }
  }
  lines.push('');

  lines.push('## SLA');
  const o = report.sla.overall;
  lines.push(`- Compliance: **${formatPercent(o.compliancePercent)}**`);
  lines.push(`- MTTR (resolve): **${formatMinutes(o.mttrMinutes)}**`);
  lines.push(`- MTTA (acknowledge): **${formatMinutes(o.mttaMinutes)}**`);
  lines.push(`- Active breaches: **${report.sla.activeBreaches}**`);
  lines.push('');

  lines.push('## Servers');
  lines.push(`- Monitored: **${report.servers.monitored}**`);
  for (const s of report.servers.healthSnapshots.slice(0, 10)) {
    const cpu = s.avgCpu !== null ? `${s.avgCpu}%` : 'n/a';
    const mem = s.avgMemory !== null ? `${s.avgMemory}%` : 'n/a';
    const disk = s.avgDisk !== null ? `${s.avgDisk}%` : 'n/a';
    lines.push(`  - **${escapeMd(s.name)}** (${s.lastCheckStatus}) — cpu ${cpu}, mem ${mem}, disk ${disk}`);
  }
  lines.push('');

  if (report.postMortems.createdInPeriod > 0) {
    lines.push('## Post-mortems');
    lines.push(`- Created in period: **${report.postMortems.createdInPeriod}**`);
    for (const pm of report.postMortems.recent) {
      lines.push(`  - [${pm.incidentId}] ${escapeMd(pm.title)} (${pm.severity})`);
    }
    lines.push('');
  }

  if (report.runbooks.runsInPeriod > 0) {
    lines.push('## Runbooks');
    lines.push(`- Runs in period: **${report.runbooks.runsInPeriod}**`);
    const status = Object.entries(report.runbooks.byStatus).map(([s, n]) => `${s}=${n}`).join(', ');
    if (status) lines.push(`  - by status: ${status}`);
    if (report.runbooks.top.length > 0) {
      lines.push('  - Top templates:');
      for (const t of report.runbooks.top) {
        lines.push(`    - ${escapeMd(t.templateName)} (×${t.runs})`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ── HTML ──────────────────────────────────────────────────────────────

export function renderHtml(report: ReportData): string {
  const sevs = report.incidents.activeBySeverity;
  const o = report.sla.overall;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(reportTitle(report))}</title>
<style>
  body { font-family: -apple-system, Inter, sans-serif; color: #1f2937; max-width: 720px; margin: 24px auto; padding: 0 16px; }
  h1 { font-size: 1.5rem; margin: 0 0 4px; color: #111827; }
  h2 { font-size: 1.05rem; margin: 24px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #e5e7eb; color: #111827; }
  .meta { color: #6b7280; font-size: 0.875rem; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; font-size: 0.875rem; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #f3f4f6; }
  th { color: #6b7280; font-weight: 600; text-transform: uppercase; font-size: 0.7rem; letter-spacing: 0.04em; }
  .kpi { display: inline-block; min-width: 120px; margin: 4px 12px 4px 0; padding: 8px 12px; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; }
  .kpi .num { display: block; font-size: 1.25rem; font-weight: 700; color: #111827; }
  .kpi .lbl { color: #6b7280; font-size: 0.75rem; text-transform: uppercase; }
  .sev-critical { color: #ef4444; font-weight: 600; }
  .sev-high     { color: #e8734a; font-weight: 600; }
  .sev-medium   { color: #f59e0b; }
  .sev-low      { color: #306ef0; }
  .bad  { color: #ef4444; font-weight: 600; }
  .good { color: #22c55e; font-weight: 600; }
</style></head><body>
  <h1>${escapeHtml(reportTitle(report))}</h1>
  <div class="meta">${escapeHtml(report.period.label)} · generated ${escapeHtml(report.generatedAt)}</div>

  <h2>Incidents</h2>
  <div>
    <span class="kpi"><span class="num">${report.incidents.createdInPeriod}</span><span class="lbl">Created</span></span>
    <span class="kpi"><span class="num">${report.incidents.resolvedInPeriod}</span><span class="lbl">Resolved</span></span>
    <span class="kpi"><span class="num">${report.incidents.activeAtEnd}</span><span class="lbl">Active</span></span>
  </div>
  <table>
    <thead><tr><th>Severity</th><th>Active</th></tr></thead>
    <tbody>
      <tr><td class="sev-critical">Critical</td><td>${sevs.critical}</td></tr>
      <tr><td class="sev-high">High</td><td>${sevs.high}</td></tr>
      <tr><td class="sev-medium">Medium</td><td>${sevs.medium}</td></tr>
      <tr><td class="sev-low">Low</td><td>${sevs.low}</td></tr>
    </tbody>
  </table>
  ${report.incidents.topRecurring.length > 0 ? `
  <table>
    <thead><tr><th>Recurring titles</th><th>Count</th></tr></thead>
    <tbody>
      ${report.incidents.topRecurring.map(r => `<tr><td>${escapeHtml(r.title)}</td><td>${r.count}</td></tr>`).join('')}
    </tbody>
  </table>` : ''}

  <h2>SLA</h2>
  <div>
    <span class="kpi"><span class="num ${(o.compliancePercent ?? 0) < 80 ? 'bad' : 'good'}">${formatPercent(o.compliancePercent)}</span><span class="lbl">Compliance</span></span>
    <span class="kpi"><span class="num">${formatMinutes(o.mttrMinutes)}</span><span class="lbl">MTTR</span></span>
    <span class="kpi"><span class="num">${formatMinutes(o.mttaMinutes)}</span><span class="lbl">MTTA</span></span>
    <span class="kpi"><span class="num ${report.sla.activeBreaches > 0 ? 'bad' : ''}">${report.sla.activeBreaches}</span><span class="lbl">Active breaches</span></span>
  </div>

  <h2>Servers</h2>
  <div>Monitoring <strong>${report.servers.monitored}</strong> servers.</div>
  <table>
    <thead><tr><th>Server</th><th>Status</th><th>Avg CPU</th><th>Avg Memory</th><th>Worst Disk</th></tr></thead>
    <tbody>
      ${report.servers.healthSnapshots.slice(0, 20).map(s => `<tr>
        <td>${escapeHtml(s.name)}</td>
        <td>${escapeHtml(s.lastCheckStatus)}</td>
        <td>${s.avgCpu !== null ? s.avgCpu + '%' : '—'}</td>
        <td>${s.avgMemory !== null ? s.avgMemory + '%' : '—'}</td>
        <td>${s.avgDisk !== null ? s.avgDisk + '%' : '—'}</td>
      </tr>`).join('')}
    </tbody>
  </table>

  ${report.postMortems.createdInPeriod > 0 ? `
  <h2>Post-mortems</h2>
  <div><strong>${report.postMortems.createdInPeriod}</strong> created in this period.</div>
  <table>
    <thead><tr><th>Incident</th><th>Title</th><th>Severity</th><th>Created</th></tr></thead>
    <tbody>
      ${report.postMortems.recent.map(pm => `<tr>
        <td>${escapeHtml(pm.incidentId)}</td>
        <td>${escapeHtml(pm.title)}</td>
        <td class="sev-${escapeHtml(pm.severity)}">${escapeHtml(pm.severity)}</td>
        <td>${escapeHtml(pm.createdAt)}</td>
      </tr>`).join('')}
    </tbody>
  </table>` : ''}

  ${report.runbooks.runsInPeriod > 0 ? `
  <h2>Runbooks</h2>
  <div><strong>${report.runbooks.runsInPeriod}</strong> runs in this period.</div>
  <table>
    <thead><tr><th>Template</th><th>Runs</th></tr></thead>
    <tbody>
      ${report.runbooks.top.map(t => `<tr><td>${escapeHtml(t.templateName)}</td><td>${t.runs}</td></tr>`).join('')}
    </tbody>
  </table>` : ''}
</body></html>`;
}

// ── JSON ──────────────────────────────────────────────────────────────

export function renderJson(report: ReportData): string {
  return JSON.stringify(report, null, 2);
}

// ── Helpers ───────────────────────────────────────────────────────────

function reportTitle(report: ReportData): string {
  switch (report.type) {
    case 'daily_summary': return 'Daily Summary';
    case 'weekly_report': return 'Weekly Report';
    case 'monthly_report': return 'Monthly Report';
  }
}

function formatPercent(v: number | null): string {
  return v === null ? 'n/a' : `${v.toFixed(1)}%`;
}

function formatMinutes(v: number | null): string {
  if (v === null) return 'n/a';
  if (v < 60) return `${v.toFixed(0)}m`;
  const h = v / 60;
  if (h < 24) return `${h.toFixed(1)}h`;
  const d = h / 24;
  return `${d.toFixed(1)}d`;
}

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeMd(s: string): string {
  return String(s).replace(/([*_`\[\]])/g, '\\$1');
}

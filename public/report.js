/* PowerApps Solution Migrator — PDF report (Download report).
 * Built in the browser from the current selections and the latest check results (Options & review),
 * or from a finished run (summary / history). Uses jsPDF + AutoTable, bundled in /vendor (no internet needed). */
'use strict';

const REPORT_COLORS = { purple: [32, 10, 64], orange: [255, 81, 38], orangeText: [194, 56, 15], ink: [17, 15, 26], muted: [95, 90, 112], line: [227, 216, 212], zebra: [251, 247, 246], ok: [16, 124, 16], warn: [180, 83, 9], err: [196, 49, 75] };

let reportLibs = null;
function loadReportLibs() {
  if (reportLibs) return reportLibs;
  const add = (src) => new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.append(el);
  });
  reportLibs = add('vendor/jspdf.umd.min.js')
    .then(() => Promise.all([add('vendor/jspdf.plugin.autotable.min.js'), add('vendor/svg2pdf.umd.min.js').catch(() => null)]))
    .catch((e) => { reportLibs = null; throw e; });
  return reportLibs;
}

// The standard PDF fonts only cover Latin-1: replace common symbols, drop the rest.
function pdfText(v) {
  if (v === null || v === undefined || v === '') return '-';
  return String(v)
    .replace(/[→⟶]/g, '->').replace(/[✓✔]/g, 'OK').replace(/[✗✕×]/g, 'X').replace(/[›»]/g, '>')
    .replace(/…/g, '...').replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/•/g, '-')
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '');
}

// The Powercraft logo: drawn as vector paths (svg2pdf) so it stays sharp at any zoom; a high-resolution
// image is the fallback if the vector drawing isn't available.
async function logoPng() {
  try {
    const svgText = await (await fetch('brand/powercraft-logo-white.svg')).text();
    const img = new Image();
    img.src = 'brand/powercraft-logo-white.svg';
    await img.decode();
    const w = img.naturalWidth || 300;
    const h = img.naturalHeight || 80;
    const scale = Math.max(1, 600 / h); // at least 600 px high
    const c = document.createElement('canvas');
    c.width = Math.round(w * scale); c.height = Math.round(h * scale);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return { data: c.toDataURL('image/png'), ratio: w / h, svgText };
  } catch { return null; }
}

async function drawLogo(doc, logo, x, y, w, h) {
  if (logo.svgText && typeof doc.svg === 'function') {
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:-10000px;top:0;width:0;height:0;overflow:hidden';
    holder.innerHTML = logo.svgText;
    document.body.append(holder);
    try {
      await doc.svg(holder.querySelector('svg'), { x, y, width: w, height: h });
      return;
    } catch { /* fall back to the image */ } finally { holder.remove(); }
  }
  doc.addImage(logo.data, 'PNG', x, y, w, h, 'powercraft-logo', 'FAST'); // one compressed copy, reused on every page
}

const MODE_LABEL = { package: 'Package only (export and download, no import)', same: 'Same tenant', cross: 'Cross tenant' };

/** Collects everything the report shows. m = a migration run, or null for the current selections. */
function collectReportData(m) {
  const now = new Date();
  const live = !m || (state.migration && state.migration.id === m.id && state.solutionId); // wizard data still available
  const sol = live ? selectedSolution() : null;
  const s = m && m.summary;
  const req = m && m.request;
  const mode = m ? (m.packageOnly ? 'package' : m.crossTenant ? 'cross' : 'same') : state.mode;
  const pkg = mode === 'package';

  // Source / target
  const srcEnv = live ? findEnv(state.source) : null;
  const srcTenant = live ? findTenant(state.source) : null;
  const source = req
    ? { tenant: req.source.tenant.displayName, environment: req.source.environment.name, url: req.source.environment.url }
    : { tenant: srcTenant && srcTenant.displayName, environment: srcEnv && srcEnv.name, url: srcEnv && srcEnv.url };
  let target = null;
  if (!pkg) {
    if (req && req.target) target = { tenant: req.target.tenant.displayName, environment: req.target.environment.name, url: req.target.environment.url };
    else if (live) {
      const te = targetEnv();
      const tt = state.mode === 'same' ? srcTenant : findTenant(state.target);
      target = { tenant: tt && tt.displayName, environment: te && te.name, url: te && te.url };
    }
  }

  // Solution and naming
  const plan = m && m.plan;
  const solution = plan
    ? { displayName: plan.solution.displayName, uniqueName: plan.solution.uniqueName, version: plan.solution.version, publisher: plan.solution.publisher }
    : sol ? { displayName: sol.displayName, uniqueName: sol.uniqueName, version: sol.version, publisher: sol.publisher && (sol.publisher.displayName || sol.publisher) } : {};
  const renamed = m ? Boolean(req.rename && req.rename.enabled) : state.rename.enabled;
  const finalName = plan ? { displayName: plan.finalDisplayName, uniqueName: plan.finalUniqueName }
    : renamed ? { displayName: state.rename.displayName || state.rename.uniqueName, uniqueName: state.rename.uniqueName } : { displayName: solution.displayName, uniqueName: solution.uniqueName };
  const options = m ? req.options : state.options;

  // Components
  let included = [];
  let excluded = [];
  let added = [];
  if (s && s.components) {
    included = s.components.includedList || [];
    excluded = s.components.excludedList || [];
    added = s.components.addedDependencies || [];
  } else if (live) {
    included = state.components.filter((c) => !state.excluded.has(c.id));
    excluded = state.components.filter((c) => state.excluded.has(c.id));
  }
  const totalComponents = s ? s.components.total : live ? state.components.length : (plan ? plan.componentCounts.total : 0);
  const byType = {};
  for (const c of included) byType[c.typeName] = (byType[c.typeName] || 0) + 1;
  for (const a of added) byType[a.typeName] = (byType[a.typeName] || 0) + 1;

  // Connection references and environment variables
  const cfg = live && state.cfg.data && !pkg ? state.cfg : null;
  const cfgReq = req && req.configuration;
  const skipped = m ? Boolean(cfgReq && cfgReq.skipped) : state.cfg.skipped;
  const applied = s && s.configuration;
  const appliedRef = new Map(((applied && applied.connectionReferences) || []).map((x) => [x.logicalName, x]));
  const appliedVar = new Map(((applied && applied.environmentVariables) || []).map((x) => [x.schemaName, x]));
  let connections = [];
  let variables = [];
  const fromComponents = (connText, varText) => {
    connections = included.filter((c) => /connection reference/i.test(c.typeName)).concat(added.filter((a) => /connection reference/i.test(a.typeName)))
      .map((c) => ({ name: c.displayName, logical: c.name || '', connector: '', inTarget: '-', selected: connText }));
    variables = included.filter((c) => /environment variable/i.test(c.typeName))
      .map((c) => ({ name: c.displayName, schema: c.name || '', type: '', source: '-', inTarget: '-', value: varText }));
  };
  if (pkg) {
    connections = included.filter((c) => /connection reference/i.test(c.typeName)).concat(added.filter((a) => /connection reference/i.test(a.typeName)))
      .map((c) => ({ name: c.displayName, logical: c.name || '', connector: '', inTarget: '-', selected: 'Chosen by the importer' }));
    variables = included.filter((c) => /environment variable/i.test(c.typeName))
      .map((c) => ({ name: c.displayName, schema: c.name || '', type: '', source: '-', inTarget: '-', value: 'Entered by the importer' }));
  } else if (cfg) {
    const payload = configurationPayload();
    const chosen = new Map(payload.connectionReferences.map((c) => [c.logicalName, c]));
    const values = new Map(payload.environmentVariables.map((v) => [v.schemaName, v]));
    connections = cfg.data.connectionReferences.map((r) => {
      const c = chosen.get(r.logicalName);
      const res = appliedRef.get(r.logicalName);
      return {
        name: r.displayName, logical: r.logicalName, connector: r.connectorName || '',
        inTarget: r.targetConnectionId ? 'Connected' : r.existsInTarget ? 'No connection' : 'New in target',
        selected: skipped ? 'Skipped (configure in target)' : c ? `${c.connectionName || c.connectionId}${res ? ` (${res.result})` : ''}` : r.targetConnectionId ? 'Keep current connection' : 'Not selected',
        needsAction: !skipped && !c && !r.targetConnectionId,
      };
    });
    variables = cfg.data.environmentVariables.map((v) => {
      const val = values.get(v.schemaName);
      const res = appliedVar.get(v.schemaName);
      const src = v.sourceValue ?? v.defaultValue;
      const secret = v.type === ENV_TYPE.SECRET;
      return {
        name: v.displayName, schema: v.schemaName, type: v.typeName,
        source: secret ? '(secret reference)' : src,
        inTarget: !v.existsInTarget ? 'New in target' : v.targetValue ?? (v.targetDefaultValue != null ? `${v.targetDefaultValue} (default)` : 'Not set'),
        value: skipped ? 'Skipped (configure in target)' : val ? `${secret ? '(secret reference set)' : val.value}${res ? ` (${res.result})` : ''}` : 'Keep target value',
        needsAction: !skipped && !val && (!v.existsInTarget || (v.targetValue == null && v.targetDefaultValue == null)) && v.defaultValue == null,
      };
    });
  } else if (skipped || !(cfgReq && ((cfgReq.connectionReferences || []).length || (cfgReq.environmentVariables || []).length))) {
    // No mapping was made: list the references and variables from the solution's components.
    fromComponents(skipped ? 'Skipped (configure in target)' : 'Not set', skipped ? 'Skipped (configure in target)' : 'Not set');
  } else if (cfgReq) {
    connections = (cfgReq.connectionReferences || []).map((c) => ({ name: c.displayName || c.logicalName, logical: c.logicalName, connector: '', inTarget: '-', selected: `${c.connectionName || c.connectionId}${appliedRef.get(c.logicalName) ? ` (${appliedRef.get(c.logicalName).result})` : ''}` }));
    variables = (cfgReq.environmentVariables || []).map((v) => ({ name: v.displayName || v.schemaName, schema: v.schemaName, type: '', source: '-', inTarget: '-', value: `${v.value}${appliedVar.get(v.schemaName) ? ` (${appliedVar.get(v.schemaName).result})` : ''}` }));
  }

  // Canvas app check (latest result)
  let canvas = null;
  if (live && !m && (state.canvas.result || state.canvas.error)) {
    canvas = state.canvas.result
      ? { ...state.canvas.result, ack: state.canvas.ack, override: state.canvas.override, checkedAt: state.canvas.checkedAt }
      : { status: 'error', message: `The check could not run: ${state.canvas.error.message}`, apps: [], ack: state.canvas.ack };
  } else if (m && m.canvasCheck) canvas = { ...m.canvasCheck, ack: options.acknowledgeUnverifiedCanvasApps, override: options.overrideCanvasCheck };

  // Target solution check
  let targetCheck = null;
  if (pkg) targetCheck = { label: 'Not applicable', text: 'Package only: the package is not imported, so no target is checked.' };
  else if (m && plan) {
    targetCheck = plan.operation === 'update'
      ? { label: 'Solution already exists', tone: 'warn', text: `"${plan.finalUniqueName}" existed in the target and was updated after you confirmed "Update the existing solution".` }
      : { label: 'Solution name available', tone: 'ok', text: `"${plan.finalUniqueName}" did not exist in the target; a new solution was installed.` };
  } else if (live && state.targetCheck) {
    const st = targetCheckState();
    const t = state.targetCheck;
    if (st === 'new') targetCheck = { label: 'Solution name available', tone: 'ok', text: `"${t.name}" doesn't exist in the target; a new solution will be created.` };
    else if (st === 'update') targetCheck = { label: 'Solution already exists', tone: 'err', text: `"${t.name}" v${t.result.solution.version} (${t.result.solution.isManaged ? 'managed' : 'unmanaged'}) is in the target. Update the existing solution: ${t.confirm ? 'confirmed' : 'NOT confirmed (required to start)'}.` };
    else if (st === 'blocked') targetCheck = { label: 'Solution already exists (blocked)', tone: 'err', text: `"${t.name}" v${t.result.solution.version} is installed as ${t.result.solution.isManaged ? 'managed' : 'unmanaged'} and cannot be replaced by this package type. Use a different name or change the package type.` };
    else if (st === 'error') targetCheck = { label: 'Not checked', tone: 'warn', text: `Availability couldn't be checked (${t.error.message}). It is checked again before the import.` };
    else targetCheck = { label: 'Checking...', text: 'The check had not finished when the report was created.' };
  }

  // Warnings and required actions
  const actions = [];
  const warnings = [];
  if (canvas) {
    if (canvas.status === 'unpublished') (canvas.override ? warnings : actions).push(canvas.override ? `Canvas apps reported as unpublished; the user confirmed they are published. ${canvas.message}` : `Publish the canvas apps with unpublished changes before starting. ${canvas.message}`);
    if (canvas.status === 'unverified' || canvas.status === 'error') (canvas.ack ? warnings : actions).push(canvas.ack ? 'Canvas app publish state not verified; the user confirmed the apps are published.' : 'Canvas app publish state could not be verified: confirm the apps are published on Options & review.');
  }
  if (targetCheck && targetCheck.tone === 'err') actions.push(`${targetCheck.label}: ${targetCheck.text}`);
  if (live && !m && state.rename.enabled && renameError()) actions.push(`Solution name: ${renameError()}`);
  for (const c of connections) if (c.needsAction) actions.push(`Connection reference "${c.name}": no connection selected and none in the target. Bind it in the target after the import.`);
  for (const v of variables) if (v.needsAction) actions.push(`Environment variable "${v.name}": no value for the target. Set it after the import.`);
  if (!m && skipped && !pkg) warnings.push('Connections & variables step skipped: connection references and variable values must be configured in the target after the import.');
  if (mode === 'cross') warnings.push('Cross-tenant move: connections, users, security role assignments and data are not part of a solution and must be set up in the target tenant.');
  if (excluded.length) warnings.push(`${excluded.length} component(s) excluded by the user. A temporary copy of the solution is exported; the original is not changed.`);
  if (s) {
    const ar = s.actionRequired;
    if (ar) {
      for (const x of ar.connectionReferences || []) actions.push(`Connection reference "${x.name}": create or pick a connection in the target and bind it.`);
      for (const x of ar.environmentVariables || []) actions.push(`Environment variable "${x.name}": has no value in the target. Set its current value.`);
      for (const x of ar.flows || []) actions.push(`Cloud flow "${x.name}": ${x.message || 'turn it on once its connections are configured.'}`);
    }
    for (const p of s.prerequisites || []) actions.push(`Prerequisite for the import: ${p.typeName} "${p.displayName}". ${p.message}`);
    for (const r of s.recommendations || []) warnings.push(r);
  }

  // Result of a run
  let result = null;
  if (m) {
    const outcomeLabel = m.status === 'running' ? 'Running' : m.status === 'cancelled' ? 'Stopped by user' : m.status === 'failed' || m.status === 'interrupted' ? 'Failed'
      : m.outcome === 'package' ? 'Package ready' : m.outcome === 'errors' ? 'Completed with errors' : m.outcome === 'action' ? 'Successful - configuration required' : 'Successful';
    result = {
      outcome: outcomeLabel,
      tone: /Failed|errors/.test(outcomeLabel) ? 'err' : /Stopped|configuration|Running/.test(outcomeLabel) ? 'warn' : 'ok',
      started: m.startedAt, finished: m.finishedAt, by: m.startedBy,
      duration: m.finishedAt ? Date.parse(m.finishedAt) - Date.parse(m.startedAt) : null,
      error: m.error ? `${m.error.step ? `${m.error.step}: ` : ''}${m.error.message}` : null,
      steps: m.steps.map((x) => ({ label: x.label, status: x.status, detail: x.detail, ms: x.startedAt && x.finishedAt ? Date.parse(x.finishedAt) - Date.parse(x.startedAt) : null })),
      failures: (s && s.failureItems) || [],
      verification: s && s.verification,
      packageFile: s && s.packageFile ? s.packageFile : s && s.package ? { name: null, sizeBytes: s.package.sizeBytes } : null,
    };
  }

  return {
    now, kind: m ? 'result' : 'review', mode, pkg, source, target, solution, finalName, renamed, options,
    profile: m ? m.profile : state.profile, preparedBy: (state.auth.source && state.auth.source.account && state.auth.source.account.username) || (m && m.startedBy) || null,
    components: { total: totalComponents, included, excluded, added, byType },
    connections, variables, skipped, canvas, targetCheck, actions, warnings, result,
  };
}

async function downloadReport(m, btn) {
  const label = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>&nbsp;Creating PDF…'; }
  try {
    await loadReportLibs();
    const data = collectReportData(m || null);
    const doc = await buildReportPdf(data);
    const sol = (data.finalName.uniqueName || data.solution.uniqueName || 'Solution').replace(/[^\w-]+/g, '_');
    const stamp = `${data.now.getFullYear()}${String(data.now.getMonth() + 1).padStart(2, '0')}${String(data.now.getDate()).padStart(2, '0')}-${String(data.now.getHours()).padStart(2, '0')}${String(data.now.getMinutes()).padStart(2, '0')}`;
    doc.save(`${data.pkg ? 'Package' : 'Migration'}_Report_${sol}_${stamp}.pdf`);
    toast('Report downloaded');
  } catch (err) {
    showError(err, 'Could not create the report');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = label; }
  }
}

async function buildReportPdf(d) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const C = REPORT_COLORS;
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 40;
  const logo = await logoPng();
  const title = d.pkg ? 'Package report' : 'Migration report';
  const subtitle = d.kind === 'review' ? 'Pre-migration review (current selections and latest checks)' : 'Result of a run';

  // First-page letterhead: report type, title, solution and date on the left; Powercraft logo top-right.
  const BAND = 136;
  doc.setFillColor(...C.purple); doc.rect(0, 0, W, BAND, 'F');
  doc.setFillColor(...C.orange); doc.rect(0, BAND, W, 4, 'F');
  let logoW = 0;
  if (logo) { logoW = 22 * logo.ratio; await drawLogo(doc, logo, W - 28 - logoW, 20, logoW, 22); } // top-right corner
  const textW = W - 2 * M - (logoW ? logoW + 24 : 0);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(255, 140, 110);
  doc.text(pdfText(subtitle.split(' (')[0].toUpperCase()), M, 38, { maxWidth: textW });
  doc.setTextColor(255, 255, 255); doc.setFontSize(19);
  doc.text(pdfText(`PowerApps Solution Migrator - ${title}`), M, 66, { maxWidth: W - 2 * M });
  const solLine = `Solution: ${d.solution.displayName || d.solution.uniqueName || '-'}${d.solution.version ? `  v${d.solution.version}` : ''}${d.renamed && d.finalName.uniqueName ? `   ->   ${d.finalName.displayName || d.finalName.uniqueName}` : ''}`;
  doc.setFontSize(12.5); doc.setTextColor(255, 214, 200);
  doc.text(doc.splitTextToSize(pdfText(solLine), W - 2 * M)[0], M, 92);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(226, 218, 240);
  doc.text(pdfText(`Generated ${d.now.toLocaleString()}${d.preparedBy ? `   |   ${d.preparedBy}` : ''}`), M, 116, { maxWidth: W - 2 * M });
  let y = BAND + 30;

  const section = (text) => {
    y += 8;
    if (y > H - 120) { doc.addPage(); y = 60; }
    doc.setTextColor(...C.purple); doc.setFont('helvetica', 'bold'); doc.setFontSize(13);
    doc.text(pdfText(text), M, y);
    doc.setDrawColor(...C.orange); doc.setLineWidth(1.2); doc.line(M, y + 5, W - M, y + 5);
    y += 16;
  };
  const para = (text, opts = {}) => {
    doc.setTextColor(...(opts.color || C.muted)); doc.setFont('helvetica', opts.bold ? 'bold' : 'normal'); doc.setFontSize(opts.size || 9.5);
    const lines = doc.splitTextToSize(pdfText(text), W - 2 * M);
    if (y + lines.length * 12 > H - 50) { doc.addPage(); y = 60; }
    doc.text(lines, M, y + 8); y += lines.length * 12 + 6;
  };
  const CW = W - 2 * M; // content width
  // widths: fractions of the content width; fixed widths stop long values from squeezing other columns.
  const table = (head, body, opts = {}) => {
    const { widths, ...rest } = opts;
    const columnStyles = { ...(rest.columnStyles || {}) };
    if (widths) widths.forEach((f, i) => { columnStyles[i] = { ...(columnStyles[i] || {}), cellWidth: Math.floor(CW * f) }; });
    doc.autoTable({
      startY: y, margin: { left: M, right: M, top: 50, bottom: 50 },
      head: head ? [head.map(pdfText)] : undefined,
      body: body.map((r) => r.map((c) => (c && typeof c === 'object' && 'content' in c ? { ...c, content: pdfText(c.content) } : pdfText(c)))),
      theme: 'grid',
      styles: { font: 'helvetica', fontSize: 8.5, cellPadding: { top: 5, right: 5, bottom: 5, left: 5 }, textColor: C.ink, lineColor: C.line, lineWidth: 0.5, overflow: 'linebreak', valign: 'top', minCellHeight: 14 },
      headStyles: { fillColor: C.purple, textColor: 255, fontStyle: 'bold', valign: 'middle', overflow: 'linebreak' },
      alternateRowStyles: { fillColor: C.zebra },
      showHead: 'everyPage',
      rowPageBreak: 'avoid',
      tableWidth: CW,
      ...rest,
      columnStyles,
    });
    y = doc.lastAutoTable.finalY + 14;
  };
  const kv = (rows) => table(null, rows.filter(Boolean), { widths: [0.26, 0.74], columnStyles: { 0: { fontStyle: 'bold', textColor: C.purple } } });
  const toneColor = (t) => (t === 'ok' ? C.ok : t === 'err' ? C.err : t === 'warn' ? C.warn : C.ink);

  // 1. Overview
  section('1. Overview');
  kv([
    ['Migration type', MODE_LABEL[d.mode] || d.mode],
    d.result ? ['Result', { content: d.result.outcome, styles: { textColor: toneColor(d.result.tone), fontStyle: 'bold' } }] : ['Status', 'Not started (review before migration)'],
    ['Source', `${d.source.environment || '-'} (${d.source.tenant || '-'})\n${d.source.url || ''}`],
    ['Target', d.pkg ? 'None: the package is only downloaded' : d.target ? `${d.target.environment || '-'} (${d.target.tenant || '-'})\n${d.target.url || ''}` : '-'],
    ['Solution', `${d.solution.displayName || '-'} (${d.solution.uniqueName || '-'})`],
    ['Version', d.solution.version],
    d.solution.publisher ? ['Publisher', d.solution.publisher] : null,
    [d.pkg ? 'Name in package' : 'Name in target', `${d.finalName.displayName || '-'} (${d.finalName.uniqueName || '-'})${d.renamed ? ' - renamed' : ' - original name'}`],
    ['Package type', d.options.managed ? 'Managed' : 'Unmanaged'],
    ['Components', `${d.components.included.length + d.components.added.length} selected of ${d.components.total}${d.components.excluded.length ? ` (${d.components.excluded.length} excluded)` : ''}${d.components.added.length ? `, ${d.components.added.length} added automatically` : ''}`],
    d.profile ? ['Profile', d.profile.name] : null,
    d.result && d.result.by ? ['Started by', d.result.by] : d.preparedBy ? ['Prepared by', d.preparedBy] : null,
    d.result ? ['Started / finished', `${new Date(d.result.started).toLocaleString()} / ${d.result.finished ? new Date(d.result.finished).toLocaleString() : '-'}${d.result.duration != null ? ` (${fmtDuration(d.result.duration)})` : ''}`] : null,
  ]);
  const opt = d.options;
  kv([
    ['Export options', `Include missing required components: ${opt.includeMissingDependencies ? 'Yes' : 'No'}\nPublish all customizations before export: ${opt.publishBeforeExport ? 'Yes' : 'No'}`],
    d.pkg ? ['Import options', 'Chosen by whoever imports the package'] : ['Import options', `Overwrite unmanaged customizations: ${opt.overwriteUnmanagedCustomizations ? 'Yes' : 'No'}\nActivate processes and flows: ${opt.publishWorkflows ? 'Yes' : 'No'}${opt.managed ? '' : `\nPublish all customizations after import: ${opt.publishAfterImport ? 'Yes' : 'No'}`}`],
  ]);

  // 2. Pre-migration checks
  section('2. Pre-migration checks');
  const cv = d.canvas;
  const cvLabel = !cv ? 'Not run yet' : cv.status === 'ok' ? 'Passed: all canvas apps published' : cv.status === 'none' ? 'Passed: no canvas apps' : cv.status === 'unpublished' ? (cv.override ? 'Unpublished changes reported - continued on user confirmation' : 'Blocked: unpublished changes') : cv.status === 'error' ? 'Could not run' : (cv.ack ? 'Not verified - confirmed by the user' : 'Not verified');
  const cvTone = !cv ? '' : (cv.status === 'ok' || cv.status === 'none') ? 'ok' : cv.status === 'unpublished' && !cv.override ? 'err' : 'warn';
  kv([
    ['Canvas apps', { content: `${cvLabel}${cv && cv.message ? `\n${cv.message}` : ''}`, styles: { textColor: toneColor(cvTone) } }],
    d.targetCheck ? ['Target solution', { content: `${d.targetCheck.label}\n${d.targetCheck.text}`, styles: { textColor: toneColor(d.targetCheck.tone) } }] : null,
  ]);
  if (cv && cv.apps && cv.apps.length) {
    table(['Canvas app', 'Result', 'Last saved', 'Last published', 'Checked with'], cv.apps.map((a) => [
      a.displayName,
      { content: a.state === 'published' ? 'Published' : a.state === 'unpublished' ? 'Unpublished changes' : 'Not verified', styles: { textColor: toneColor(a.state === 'published' ? 'ok' : a.state === 'unpublished' ? 'err' : 'warn') } },
      a.lastSaved ? new Date(a.lastSaved).toLocaleString() : '-', a.lastPublished ? new Date(a.lastPublished).toLocaleString() : '-', a.evidence || a.reason || '-',
    ]), { widths: [0.25, 0.16, 0.19, 0.19, 0.21] });
  }

  // 3. Warnings and required actions
  section('3. Conflicts, warnings and required actions');
  if (!d.actions.length && !d.warnings.length) para('No conflicts, warnings or required actions.', { color: C.ok });
  else {
    table(['Type', 'Details'], [
      ...d.actions.map((a) => [{ content: 'Action required', styles: { textColor: C.err, fontStyle: 'bold' } }, a]),
      ...d.warnings.map((w) => [{ content: 'Note', styles: { textColor: C.warn, fontStyle: 'bold' } }, w]),
    ], { widths: [0.19, 0.81] });
  }

  // 4. Components
  section('4. Components');
  const counts = Object.entries(d.components.byType).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (counts.length) table(['Component type', 'Count'], [...counts.map(([k, v]) => [k, String(v)]), [{ content: 'Total', styles: { fontStyle: 'bold' } }, { content: String(d.components.included.length + d.components.added.length), styles: { fontStyle: 'bold' } }]], { widths: [0.82, 0.18], columnStyles: { 1: { halign: 'right' } } });
  const list = [
    ...d.components.included.map((c) => [c.typeName, c.displayName, c.name && c.name !== c.displayName ? c.name : '', 'Selected']),
    ...d.components.added.map((a) => [a.typeName, a.displayName, '', `Added automatically${a.neededBy && a.neededBy.length ? ` (needed by ${a.neededBy.join(', ')})` : ''}`]),
    ...d.components.excluded.map((c) => [c.typeName, c.displayName, c.name && c.name !== c.displayName ? c.name : '', { content: 'Excluded', styles: { textColor: C.warn } }]),
  ].sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1])));
  if (list.length) table(['Type', 'Name', 'Logical name', 'Status'], list, { widths: [0.2, 0.3, 0.28, 0.22] });
  else para('The component list is not available.');

  // 5. Connections and variables
  section('5. Connection references and environment variables');
  if (d.pkg) para('Package only: connections and variable values are set by whoever imports the package.');
  else if (d.skipped) para('The Connections & variables step was skipped. Configure these in the target after the import.', { color: C.warn });
  if (d.connections.length) {
    table(['Connection reference', 'Connector', 'In target now', d.pkg ? 'Connection' : 'Use connection'], d.connections.map((c) => [
      `${c.name}${c.logical ? `\n${c.logical}` : ''}`, c.connector || '-', c.inTarget,
      c.needsAction ? { content: c.selected, styles: { textColor: C.err } } : c.selected,
    ]), { widths: [0.32, 0.17, 0.17, 0.34] });
  } else para('No connection references.');
  if (d.variables.length) {
    table(['Environment variable', 'Type', 'Source value', 'In target now', 'Value for target'], d.variables.map((v) => [
      `${v.name}${v.schema ? `\n${v.schema}` : ''}`, v.type || '-', String(v.source ?? '-').slice(0, 300), String(v.inTarget ?? '-').slice(0, 300),
      v.needsAction ? { content: String(v.value), styles: { textColor: C.err } } : String(v.value).slice(0, 300),
    ]), { widths: [0.25, 0.12, 0.21, 0.21, 0.21] });
  } else para('No environment variables.');

  // 6. Result
  if (d.result) {
    section('6. Migration steps and result');
    if (d.result.error) para(d.result.error, { color: C.err });
    if (d.result.verification) para(d.result.verification.versionOk ? `Verified: v${d.result.verification.version} found in the target.` : `Version mismatch: v${d.result.verification.version} in the target, v${d.result.verification.expectedVersion} expected.`, { color: d.result.verification.versionOk ? C.ok : C.err });
    if (d.result.packageFile && d.result.packageFile.name) para(`Package file: ${d.result.packageFile.name} (${fmtBytes(d.result.packageFile.sizeBytes)})`, { color: C.ink });
    table(['Step', 'Status', 'Details', 'Time'], d.result.steps.map((x) => [x.label,
      { content: x.status === 'done' ? 'Done' : x.status[0].toUpperCase() + x.status.slice(1), styles: { textColor: toneColor(x.status === 'done' ? 'ok' : x.status === 'failed' ? 'err' : '') } },
      x.detail || '', x.ms != null ? fmtDuration(x.ms) : '']), { widths: [0.3, 0.12, 0.48, 0.1], columnStyles: { 3: { halign: 'right' } } });
    if (d.result.failures.length) table(['Failure', 'Component', 'Message'], d.result.failures.map((f) => [f.source, f.name, f.message || '']), { widths: [0.2, 0.25, 0.55] });
  }

  // Header strip and footer on every page
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    if (i > 1) {
      doc.setFillColor(...C.purple); doc.rect(0, 0, W, 30, 'F');
      doc.setFillColor(...C.orange); doc.rect(0, 30, W, 2, 'F');
      if (logo) await drawLogo(doc, logo, M, 9, 12 * logo.ratio, 12);
      doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
      doc.text(pdfText(`PowerApps Solution Migrator - ${title}`), W - M, 19, { align: 'right' });
    }
    doc.setDrawColor(...C.orange); doc.setLineWidth(0.8); doc.line(M, H - 34, W - M, H - 34);
    doc.setTextColor(...C.muted); doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
    doc.text(pdfText(`(c) ${d.now.getFullYear()} Powercraft - powercraft.co  |  ${d.solution.displayName || ''}`), M, H - 22);
    doc.text(`Page ${i} of ${pages}`, W - M, H - 22, { align: 'right' });
  }
  doc.setProperties({ title: `PowerApps Solution Migrator - ${title}`, subject: d.solution.displayName || '', creator: 'PowerApps Solution Migrator (Powercraft)' });
  return doc;
}

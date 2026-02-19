function buildHtml(port) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>UCM Dashboard</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='20' fill='%230d1117'/><text x='50' y='68' font-size='52' font-weight='bold' text-anchor='middle' fill='%2358a6ff'>U</text></svg>">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
:root {
  --bg: #0d1117; --surface: #161b22; --border: #30363d;
  --text: #c9d1d9; --text-muted: #8b949e; --text-bright: #f0f6fc;
  --accent: #58a6ff; --accent-dark: #1a4b8c; --green: #3fb950; --red: #f85149; --yellow: #d29922; --purple: #bc8cff;
  --focus-ring: 0 0 0 2px var(--bg), 0 0 0 4px var(--accent);
}
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; background: var(--bg); color: var(--text); height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
a { color: var(--accent); text-decoration: none; }
button { cursor: pointer; border: 1px solid var(--border); background: var(--surface); color: var(--text); padding: 6px 12px; border-radius: 6px; font-size: 13px; }
button:hover { background: #1f2937; }
button:focus-visible { box-shadow: var(--focus-ring); outline: none; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
button:disabled:hover { background: var(--surface); }
button.primary { background: #238636; border-color: #2ea043; color: #fff; }
button.primary:hover { background: #2ea043; }
button.danger { background: #da3633; border-color: #f85149; color: #fff; }
button.danger:hover { background: #f85149; }
button.btn-muted { background: transparent; border-color: var(--border); color: var(--text-muted); font-size: 12px; }
button.btn-muted:hover { color: var(--red); border-color: var(--red); }
button.warning { background: #9e6a03; border-color: #d29922; color: #fff; }
input:focus-visible, select:focus-visible, textarea:focus-visible { box-shadow: var(--focus-ring); outline: none; }

/* Header */
.header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--border); background: var(--surface); flex-shrink: 0; }
.header h1 { font-size: 18px; color: var(--text-bright); font-weight: 700; letter-spacing: -0.3px; }
.header .status { display: flex; align-items: center; gap: 8px; }
.header .dot { width: 8px; height: 8px; border-radius: 50%; }
.dot.running { background: var(--green); }
.dot.paused { background: var(--yellow); }
.dot.offline { background: var(--text-muted); }

/* Main Layout */
.main { display: flex; flex: 1; overflow: hidden; }

/* Left Panel */
.left { width: 340px; border-right: 1px solid var(--border); display: flex; flex-direction: column; flex-shrink: 0; }
.left .toolbar { padding: 8px; border-bottom: 1px solid var(--border); display: flex; gap: 8px; justify-content: flex-end; }
.task-list { flex: 1; overflow-y: auto; }
.task-item { padding: 10px 12px; border-bottom: 1px solid var(--border); cursor: pointer; }
.task-item:hover { background: #1c2128; }
.task-item.selected { background: #1f2937; border-left: 3px solid var(--accent); }
.task-item .title { font-size: 13px; color: var(--text-bright); margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.task-item .meta { font-size: 11px; color: var(--text-muted); display: flex; gap: 8px; }
.badge { display: inline-block; padding: 1px 6px; border-radius: 10px; font-size: 11px; font-weight: 500; }
.badge.running { background: #0d419d; color: #58a6ff; }
.badge.review { background: #3d2200; color: #d29922; }
.badge.pending { background: #1c2128; color: #8b949e; }
.badge.done { background: #0f2d16; color: #3fb950; }
.badge.failed { background: #3d1214; color: #f85149; }
.badge.suspended { background: #2d2000; color: #d29922; }

/* Right Panel */
.right { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
#detailView { display: flex; flex-direction: column; flex: 1; overflow: hidden; }
#detailView.empty { display: flex; align-items: center; justify-content: center; }
.right .detail-header { padding: 16px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.right .detail-header h2 { font-size: 18px; color: var(--text-bright); margin-bottom: 8px; word-break: break-word; }
.right .detail-header .meta { font-size: 12px; color: var(--text-muted); }
.right .detail-header p { margin-top: 8px; font-size: 13px; color: var(--text-muted); white-space: pre-wrap; word-break: break-word; }
.right .actions { display: flex; gap: 8px; margin-top: 12px; }
.tabs { display: flex; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.tabs button { border: none; border-bottom: 2px solid transparent; border-radius: 0; padding: 8px 16px; }
.tabs button.active { border-bottom-color: var(--accent); color: var(--text-bright); }
.tab-content { flex: 1; overflow-y: auto; padding: 16px; }
.tab-content pre { background: var(--surface); padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }

/* Footer */
.footer { display: flex; align-items: center; justify-content: space-between; padding: 6px 16px; border-top: 1px solid var(--border); background: var(--surface); font-size: 12px; color: var(--text-muted); flex-shrink: 0; }

/* Modal */
.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: none; align-items: center; justify-content: center; z-index: 100; }
.modal-overlay.show { display: flex; }
.modal { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 24px; width: 480px; max-width: 90vw; position: relative; }
.modal h2, .modal h3 { margin-bottom: 16px; color: var(--text-bright); }
.modal label { display: block; font-size: 13px; color: var(--text-muted); margin-bottom: 4px; margin-top: 12px; }
.modal input, .modal textarea, .modal select { width: 100%; padding: 8px 10px; background: var(--bg); border: 1px solid var(--border); color: var(--text); border-radius: 6px; font-size: 13px; }
.modal textarea { min-height: 80px; resize: vertical; }
.modal .modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.project-row { display: flex; gap: 6px; }
.project-row input { flex: 1; }
.dir-browser { position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: var(--surface); border-radius: 12px; display: flex; flex-direction: column; z-index: 10; }
.dir-header { display: flex; align-items: center; gap: 8px; padding: 12px; border-bottom: 1px solid var(--border); }
.dir-header span { flex: 1; font-size: 12px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dir-list { flex: 1; overflow-y: auto; }
.dir-item { padding: 8px 12px; cursor: pointer; font-size: 13px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 8px; }
.dir-item:hover { background: #1c2128; }
.dir-item .icon { color: var(--accent); }
.dir-actions { padding: 8px 12px; border-top: 1px solid var(--border); display: flex; justify-content: flex-end; }
.pipeline-bar { display: flex; gap: 4px; margin-top: 8px; flex-wrap: wrap; }
.pipeline-bar .stage { padding: 4px 10px; border-radius: 4px; font-size: 11px; background: var(--bg); border: 1px solid var(--border); }
.pipeline-bar .stage.done { border-color: var(--green); color: var(--green); }
.pipeline-bar .stage.running { border-color: var(--accent); color: var(--accent); animation: pulse 1.5s infinite; }
.pipeline-bar .stage.failed { border-color: var(--red); color: var(--red); }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }

/* Gather Panel */
.gather-panel { border-top: 1px solid var(--border); padding: 16px; background: #1c1f26; }
.gather-panel h4 { color: var(--purple); margin-bottom: 8px; font-size: 13px; }
.gather-panel .question { margin-bottom: 8px; }
.gather-panel .question label { display: block; font-size: 12px; color: var(--text-bright); margin-bottom: 4px; }
.gather-panel .question input { width: 100%; padding: 6px 8px; background: var(--bg); border: 1px solid var(--border); color: var(--text); border-radius: 4px; font-size: 13px; }
.gather-panel .gather-actions { display: flex; gap: 8px; margin-top: 8px; }
.gather-panel .gather-actions button { font-size: 12px; }

/* Project Ask Panel */
.project-ask-panel { border-top: 1px solid var(--border); padding: 16px; background: #1c1f26; }
.project-ask-panel h4 { color: var(--purple); margin-bottom: 8px; font-size: 13px; }
.project-ask-panel input { width: 100%; padding: 6px 8px; background: var(--bg); border: 1px solid var(--border); color: var(--text); border-radius: 4px; font-size: 13px; margin-bottom: 8px; }
.project-ask-panel .project-ask-actions { display: flex; gap: 8px; }
.project-ask-panel .project-ask-actions button { font-size: 12px; }

/* Refinement Panel */
.refinement-panel { padding: 16px; overflow-y: auto; flex: 1; }
.refinement-panel h3 { color: var(--purple); margin-bottom: 12px; font-size: 15px; }
.refinement-panel .ref-status { color: var(--text-muted); font-size: 12px; margin-bottom: 12px; }
.refinement-panel .coverage-bar { margin-bottom: 12px; }
.refinement-panel .coverage-bar .area { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; font-size: 12px; }
.refinement-panel .coverage-bar .area .bar-track { flex: 1; height: 8px; background: var(--bg); border-radius: 4px; overflow: hidden; }
.refinement-panel .coverage-bar .area .bar-fill { height: 100%; background: var(--accent); border-radius: 4px; transition: width 0.3s; }
.refinement-panel .coverage-bar .area .bar-fill.full { background: var(--green); }
.refinement-panel .ref-question { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px; margin-bottom: 12px; }
.refinement-panel .ref-question .q-text { font-size: 13px; color: var(--text-bright); margin-bottom: 8px; }
.refinement-panel .ref-option { display: block; width: 100%; text-align: left; padding: 8px 10px; margin-bottom: 4px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); cursor: pointer; font-size: 12px; }
.refinement-panel .ref-option:hover { border-color: var(--accent); color: var(--text-bright); }
.refinement-panel .ref-option .opt-reason { display: block; color: var(--text-muted); font-size: 11px; margin-top: 2px; }
.refinement-panel .ref-custom { width: 100%; padding: 8px 10px; background: var(--bg); border: 1px solid var(--border); color: var(--text); border-radius: 6px; font-size: 13px; margin-top: 8px; }
.refinement-panel .ref-actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
.refinement-panel .ref-actions button { font-size: 12px; }
.refinement-panel .decisions-list { margin-top: 12px; }
.refinement-panel .decision-item { font-size: 12px; padding: 6px 0; border-bottom: 1px solid var(--border); }
.refinement-panel .decision-item .d-area { color: var(--accent); font-weight: 500; }
.refinement-panel .decision-item .d-q { color: var(--text-muted); }
.refinement-panel .decision-item .d-a { color: var(--text-bright); }
.refinement-panel .ref-complete { text-align: center; padding: 20px; }
.refinement-panel .ref-complete h4 { color: var(--green); margin-bottom: 12px; }
.ref-autopilot-status { display: flex; align-items: center; gap: 8px; color: var(--accent); font-size: 13px; padding: 8px 0; }
@keyframes ref-spin { to { transform: rotate(360deg); } }
.ref-spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: ref-spin 0.8s linear infinite; flex-shrink: 0; }
button.refine { background: #1a1e3e; border-color: var(--purple); color: var(--purple); }
button.refine:hover { background: #252a50; }

/* Tab Toggle */
.tab-toggle { display: flex; gap: 0; }
.tab-toggle .toggle { border-radius: 0; border: 1px solid var(--border); background: var(--bg); color: var(--text-muted); font-size: 12px; padding: 5px 0; width: 80px; text-align: center; }
.tab-toggle .toggle:first-child { border-radius: 6px 0 0 6px; }
.tab-toggle .toggle + .toggle { border-left: none; }
.tab-toggle .toggle:last-child { border-radius: 0 6px 6px 0; }
.tab-toggle .toggle.active { background: var(--accent-dark); color: var(--text-bright); border-color: var(--accent); font-weight: 600; }

/* Proposal List */
.proposal-list { flex: 1; overflow-y: auto; }
.proposal-item { padding: 10px 12px; border-bottom: 1px solid var(--border); cursor: pointer; }
.proposal-item:hover { background: #1c2128; }
.proposal-item.selected { background: #1f2937; border-left: 3px solid var(--purple); }
.proposal-item .title { font-size: 13px; color: var(--text-bright); margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.proposal-item .meta { font-size: 11px; color: var(--text-muted); display: flex; gap: 8px; }
.badge.proposed { background: #1a1e3e; color: var(--purple); }
.badge.approved { background: #0f2d16; color: var(--green); }
.badge.implemented { background: #0d419d; color: var(--accent); }
.badge.rejected { background: #3d1214; color: var(--red); }

/* Proposal Detail */
.proposal-detail { padding: 16px; }
.proposal-detail h2 { font-size: 18px; color: var(--text-bright); margin-bottom: 8px; word-break: break-word; }
.proposal-detail .meta { font-size: 12px; color: var(--text-muted); margin-bottom: 12px; }
.proposal-detail .section { margin-bottom: 16px; }
.proposal-detail .section h4 { font-size: 13px; color: var(--accent); margin-bottom: 6px; }
.proposal-detail .section p { font-size: 13px; white-space: pre-wrap; word-break: break-word; }
.proposal-detail .actions { display: flex; gap: 8px; margin-top: 12px; }
.eval-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px; margin-top: 16px; }
.eval-card h4 { font-size: 13px; color: var(--purple); margin-bottom: 8px; }
.eval-card .verdict { font-size: 14px; font-weight: 600; margin-bottom: 8px; }
.eval-card .verdict.positive { color: var(--green); }
.eval-card .verdict.negative { color: var(--red); }
.eval-card .verdict.neutral { color: var(--yellow); }
.eval-card .deltas { font-size: 12px; color: var(--text-muted); }
.eval-card .deltas span { margin-right: 12px; }
button.up { background: #1a2e1a; border-color: var(--green); color: var(--green); }
button.up:hover { background: #253025; }
button.down { background: #2e1a1a; border-color: var(--red); color: var(--red); }
button.down:hover { background: #302525; }

/* Terminal Panel */
.terminal-container { display: flex; flex-direction: column; flex: 1; overflow: hidden; }
.terminal-toolbar { padding: 8px 16px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 10px; font-size: 12px; color: var(--text-muted); flex-shrink: 0; }
.terminal-toolbar .actions { margin-left: auto; display: flex; gap: 6px; }
.terminal-toolbar .actions button { font-size: 11px; padding: 3px 8px; }
#terminal { flex: 1; overflow: hidden; }

/* ── Toast ── */
.toast-container { position: fixed; top: 16px; right: 16px; z-index: 200; display: flex; flex-direction: column; gap: 8px; pointer-events: none; }
.toast { padding: 10px 16px; border-radius: 8px; font-size: 13px; color: #fff; max-width: 360px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); animation: toastIn 0.25s ease-out; pointer-events: auto; }
.toast.fade-out { animation: toastOut 0.3s ease-in forwards; }
.toast.success { background: #238636; }
.toast.error { background: #da3633; }
.toast.warning { background: #9e6a03; }
.toast.info { background: #1f6feb; }
@keyframes toastIn { from { opacity: 0; transform: translateX(40px); } to { opacity: 1; transform: translateX(0); } }
@keyframes toastOut { to { opacity: 0; transform: translateX(40px); } }

/* ── Spinner ── */
.spinner { border: 2px solid #30363d; border-top: 2px solid #58a6ff; border-radius: 50%; width: 16px; height: 16px; animation: spin 0.6s linear infinite; display: inline-block; vertical-align: middle; }
.spinner-lg { width: 24px; height: 24px; border-width: 3px; }
@keyframes spin { to { transform: rotate(360deg); } }

/* ── Detail Metadata Grid ── */
.meta-grid { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 12px; margin-top: 8px; }
.meta-grid .label { color: var(--text-muted); }
.meta-grid .value { color: var(--text); }
.badge-sm { display: inline-block; padding: 0 5px; border-radius: 8px; font-size: 11px; font-weight: 500; }

/* ── Timeline Table ── */
.timeline-table { width: 100%; border-collapse: collapse; margin-bottom: 16px; font-size: 12px; }
.timeline-table th { text-align: left; padding: 6px 10px; border-bottom: 2px solid var(--border); color: var(--text-muted); font-weight: 600; }
.timeline-table td { padding: 5px 10px; border-bottom: 1px solid var(--border); }
.timeline-table .status-done { color: var(--green); }
.timeline-table .status-running { color: var(--accent); }
.timeline-table .status-failed { color: var(--red); }

/* ── Resource Pressure ── */
.resource-badge { display: inline-block; padding: 1px 6px; border-radius: 8px; font-size: 11px; font-weight: 500; }
.resource-badge.normal { background: #0f2d16; color: var(--green); }
.resource-badge.pressure { background: #3d2200; color: var(--yellow); }
.resource-badge.critical { background: #3d1214; color: var(--red); }
.pause-reason { color: var(--yellow); font-style: italic; }

/* ── Filter Bar ── */
.filter-bar { display: flex; gap: 6px; padding: 8px; border-bottom: 1px solid var(--border); }
.filter-bar select, .filter-bar input { background: var(--bg); border: 1px solid var(--border); color: var(--text); border-radius: 4px; padding: 4px 6px; font-size: 12px; }
.filter-bar input { flex: 1; min-width: 0; }

/* ── Keyboard Overlay ── */
.kbd-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: none; align-items: center; justify-content: center; z-index: 300; }
.kbd-overlay.show { display: flex; }
.kbd-panel { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 24px; width: 400px; max-width: 90vw; }
.kbd-panel h2, .kbd-panel h3 { color: var(--text-bright); margin-bottom: 16px; }
.kbd-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; }
.kbd-row kbd { background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 2px 8px; font-family: monospace; font-size: 12px; color: var(--accent); }

/* ── Admin / Cleanup ── */
.admin-section { padding: 12px; border-top: 1px solid var(--border); }
.admin-section h4, .admin-section .admin-heading { font-size: 12px; color: var(--text-muted); margin-bottom: 8px; font-weight: 600; }
.admin-row { display: flex; gap: 6px; align-items: center; }
.admin-row input { width: 60px; background: var(--bg); border: 1px solid var(--border); color: var(--text); border-radius: 4px; padding: 4px 6px; font-size: 12px; }

/* ── Proposals Toolbar ── */
.proposal-toolbar { padding: 8px; border-bottom: 1px solid var(--border); display: flex; gap: 8px; align-items: center; justify-content: space-between; font-size: 11px; color: var(--text-muted); }

/* ── Diff Syntax Highlighting ── */
.diff-view { font-size: 12px; line-height: 1.6; }
.diff-view .diff-file { color: var(--text-bright); font-weight: bold; }
.diff-view .diff-hunk { color: var(--purple); }
.diff-view .diff-add { color: var(--green); }
.diff-view .diff-del { color: var(--red); }
.diff-view .diff-ctx { color: var(--text-muted); }

/* ── Count Badge ── */
.count-badge { display: inline-block; min-width: 16px; height: 16px; line-height: 16px; padding: 0 4px; border-radius: 8px; background: var(--red); color: #fff; font-size: 10px; font-weight: 700; text-align: center; vertical-align: middle; margin-left: 4px; }

/* ── Connection Indicator ── */
.conn-indicator { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-muted); }
.conn-dot { width: 6px; height: 6px; border-radius: 50%; }
.conn-dot.connected { background: var(--green); }
.conn-dot.connecting { background: var(--yellow); animation: pulse 1s infinite; }
.conn-dot.disconnected { background: var(--red); }

/* ── Scrollbar ── */
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }

/* ── Sort Control ── */
.sort-control { display: flex; align-items: center; gap: 4px; }
.sort-control select { background: var(--bg); border: 1px solid var(--border); color: var(--text-muted); border-radius: 4px; padding: 2px 4px; font-size: 11px; }

/* ── Log Toolbar ── */
.log-toolbar { display: flex; justify-content: flex-end; gap: 8px; margin-bottom: 8px; align-items: center; font-size: 12px; color: var(--text-muted); }
.log-toolbar label { display: flex; align-items: center; gap: 4px; cursor: pointer; }
.log-toolbar input[type="checkbox"] { accent-color: var(--accent); }

/* ── Stats Bar ── */
.stats-bar { display: flex; gap: 16px; padding: 8px 16px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--text-muted); overflow-x: auto; flex-shrink: 0; flex-wrap: wrap; }
.stat-item { display: flex; align-items: center; gap: 4px; white-space: nowrap; }
.stat-value { color: var(--text-bright); font-weight: 600; }
.stat-value.green { color: var(--green); }
.stat-value.red { color: var(--red); }
.stat-value.yellow { color: var(--yellow); }

/* ── Mobile ── */
@media (max-width: 640px) {
  .header { flex-wrap: wrap; gap: 8px; padding: 8px 12px; }
  .header h1 { width: 100%; }
  .tab-toggle .toggle { min-height: 44px; font-size: 13px; padding: 8px 0; }
  .header .status { gap: 6px; }
  .header .status button { min-height: 44px; }
  .stats-bar { gap: 8px 16px; padding: 8px 12px; }
  .left { width: 100%; border-right: none; max-height: 40vh; }
  .main { flex-direction: column; }
  .footer { flex-wrap: wrap; gap: 4px; font-size: 11px; }
}
@media (min-width: 769px) and (max-width: 1024px) {
  .left { width: 40%; min-width: 280px; max-width: 380px; }
}

/* ── Empty State ── */
.empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 48px 24px; color: var(--text-muted); text-align: center; }
.empty-state .empty-icon { font-size: 36px; margin-bottom: 12px; opacity: 0.5; }
.empty-state .empty-title { font-size: 14px; color: var(--text); margin-bottom: 4px; }
.empty-state .empty-desc { font-size: 12px; }

/* ── Summary Markdown ── */
.summary-content h1, .summary-content h2, .summary-content h3 { color: var(--text-bright); margin: 12px 0 6px 0; }
.summary-content h1 { font-size: 16px; }
.summary-content h2 { font-size: 14px; }
.summary-content h3 { font-size: 13px; }
.summary-content p { margin: 4px 0; }
.summary-content ul { margin: 4px 0 4px 20px; }
.summary-content li { margin: 2px 0; }
.summary-content code { background: var(--bg); padding: 1px 4px; border-radius: 3px; font-size: 12px; }
.summary-content pre { background: var(--surface); padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 12px; line-height: 1.5; margin: 8px 0; }
.summary-content strong { color: var(--text-bright); }
.code-block { background: var(--bg); border: 1px solid var(--border); padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 12px; line-height: 1.5; margin: 8px 0; font-family: 'SF Mono', 'Fira Code', Menlo, monospace; }
.md-table { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 12px; }
.md-table th { text-align: left; padding: 6px 10px; border-bottom: 2px solid var(--border); color: var(--text-bright); font-weight: 600; background: var(--bg); }
.md-table td { padding: 5px 10px; border-bottom: 1px solid var(--border); }
.spec-details { margin-top: 8px; }
.spec-toggle { cursor: pointer; color: var(--text-muted); font-size: 12px; padding: 4px 0; }
.spec-toggle:hover { color: var(--text); }
.spec-details[open] .spec-toggle { margin-bottom: 8px; }
.current-stage { font-size: 11px; color: var(--accent); background: rgba(88,166,255,0.1); padding: 1px 6px; border-radius: 3px; margin-left: 4px; }
.task-item.needs-review { border-left: 3px solid var(--yellow); }
.review-hint { font-size: 11px; color: var(--yellow); margin-left: 4px; }

/* ── Copy Button ── */
.copy-btn { background: none; border: none; color: var(--text-muted); cursor: pointer; padding: 2px 4px; font-size: 12px; border-radius: 4px; }
.copy-btn:hover { color: var(--accent); background: var(--bg); }

/* ── Autopilot ── */
.ap-badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; background: #1a0a2e; color: #a371f7; border: 1px solid #a371f7; cursor: pointer; animation: apPulse 2s infinite; }
.ap-badge:hover { background: #2a1a3e; }
@keyframes apPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.7; } }

.ap-session-list { flex: 1; overflow-y: auto; }
.ap-session-card { padding: 12px; border-bottom: 1px solid var(--border); cursor: pointer; }
.ap-session-card:hover { background: #1c2128; }
.ap-session-card.selected { background: #1f2937; border-left: 3px solid #a371f7; }
.ap-session-card .ap-name { font-size: 13px; color: var(--text-bright); margin-bottom: 4px; display: flex; align-items: center; gap: 6px; }
.ap-session-card .ap-meta { font-size: 11px; color: var(--text-muted); display: flex; gap: 8px; }
.badge.planning { background: #1a0a2e; color: #a371f7; }
.badge.reviewing { background: #3d2200; color: #d29922; }
.badge.releasing { background: #0f2d16; color: #3fb950; }
.badge.stopped { background: #1c2128; color: #8b949e; }
.badge.paused { background: #2d2000; color: #d29922; }
.badge.error { background: #3d1214; color: #f85149; }

.ap-progress { height: 4px; background: var(--bg); border-radius: 2px; margin-top: 6px; overflow: hidden; }
.ap-progress-fill { height: 100%; background: #a371f7; border-radius: 2px; transition: width 0.3s; }

.ap-detail { padding: 16px; overflow-y: auto; flex: 1; }
.ap-detail h2 { font-size: 16px; color: var(--text-bright); margin-bottom: 8px; }
.ap-detail .ap-actions { display: flex; gap: 8px; margin-bottom: 16px; }
.ap-detail .ap-section { margin-bottom: 16px; }
.ap-detail .ap-section h4 { font-size: 13px; color: #a371f7; margin-bottom: 8px; }

.ap-roadmap-item { padding: 6px 10px; border-bottom: 1px solid var(--border); font-size: 12px; display: flex; align-items: center; gap: 8px; }
.ap-roadmap-item .ap-type { padding: 1px 6px; border-radius: 8px; font-size: 10px; font-weight: 500; }
.ap-type.feature { background: #0d419d; color: #58a6ff; }
.ap-type.refactor { background: #3d2200; color: #d29922; }
.ap-type.docs { background: #0f2d16; color: #3fb950; }
.ap-type.test { background: #1a0a2e; color: #a371f7; }

.ap-release-item { padding: 8px 10px; border-bottom: 1px solid var(--border); font-size: 12px; }
.ap-release-item .version { color: var(--green); font-weight: 600; }
.ap-release-item .timestamp { color: var(--text-muted); font-size: 11px; }

.ap-log-entry { font-size: 11px; padding: 2px 0; font-family: monospace; }
.ap-log-entry .ts { color: var(--text-muted); }
.ap-log-entry.warn { color: var(--yellow); }
.ap-log-entry.error { color: var(--red); }

.ap-directive-item { display:flex; align-items:center; justify-content:space-between; padding:6px 8px; border-radius:4px; margin:2px 0; font-size:12px; }
.ap-directive-item.pending { background:rgba(210,153,34,0.1); border:1px solid rgba(210,153,34,0.2); }
.ap-directive-item.consumed { background:var(--bg); opacity:0.6; }
.ap-directive-input { display:flex; gap:6px; margin-bottom:8px; }
.ap-directive-input input { flex:1; padding:6px 10px; background:var(--bg); border:1px solid var(--border); color:var(--text); border-radius:6px; font-size:12px; }
.ap-directive-input button { white-space:nowrap; }

.ap-start-form { padding: 16px; }
.ap-start-form label { display: block; font-size: 13px; color: var(--text-muted); margin-bottom: 4px; margin-top: 12px; }
.ap-start-form input, .ap-start-form select { width: 100%; padding: 8px 10px; background: var(--bg); border: 1px solid var(--border); color: var(--text); border-radius: 6px; font-size: 13px; }
.ap-start-form .form-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }

.ap-toolbar { padding: 8px; border-bottom: 1px solid var(--border); display: flex; gap: 8px; justify-content: flex-end; }

.ap-task-icon { display: inline-block; font-size: 11px; margin-right: 2px; color: #a371f7; }

/* ── Mobile Back Button ── */
.mobile-back { display: none; }

/* ── Responsive ── */
@media (max-width: 768px) {
  .main { flex-direction: column; }
  .left { width: 100%; max-width: none; min-height: 0; flex: 1; }
  .right { width: 100%; display: none; }
  .right.has-detail { display: flex; position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 100; background: var(--bg); }
  .mobile-back { display: block; padding: 12px 16px; background: var(--bg-secondary); border: none; border-bottom: 1px solid var(--border); color: var(--accent); font-size: 14px; cursor: pointer; flex-shrink: 0; }
  .header { padding: 8px 12px; flex-wrap: wrap; gap: 8px; }
  .header h1 { font-size: 14px; }
  .stats-bar { padding: 6px 12px; gap: 10px; }
  .toolbar button, .admin-section button { min-height: 44px; min-width: 44px; }
  .admin-section input { min-height: 44px; }
}
</style>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5/css/xterm.min.css">
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0/lib/addon-fit.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-web-links@0/lib/addon-web-links.min.js"></script>
</head>
<body>
<div class="toast-container" id="toastContainer"></div>

<header class="header" role="banner">
  <h1>UCM Dashboard</h1>
  <nav class="tab-toggle" role="navigation" aria-label="Main navigation">
    <button class="toggle" onclick="switchPanel('chat')">Chat</button>
    <button class="toggle active" aria-current="page" id="tasksToggle" onclick="switchPanel('tasks')">Tasks</button>
    <button class="toggle" onclick="switchPanel('proposals')">Proposals</button>
    <button class="toggle" id="autopilotToggle" onclick="switchPanel('autopilot')">Autopilot</button>
  </nav>
  <span id="apBadge" class="ap-badge" style="display:none" onclick="switchPanel('autopilot')">AUTOPILOT</span>
  <div class="status" role="status" aria-live="polite">
    <div class="conn-indicator"><span class="conn-dot connecting" id="connDot" aria-hidden="true"></span><span id="connText">ws</span></div>
    <span class="dot running" id="statusDot" aria-hidden="true"></span>
    <span id="statusText">connecting...</span>
    <button id="pauseBtn" onclick="togglePause()" aria-label="Pause daemon">Pause</button>
    <button id="stopDaemonBtn" class="danger" onclick="stopDaemon()" style="display:none" aria-label="Stop daemon">Stop Daemon</button>
  </div>
</header>
<div class="stats-bar" id="statsBar" role="status" aria-label="System statistics"></div>

<main class="main">
  <div class="left" id="leftPanel">
    <div class="toolbar" id="taskToolbar">
      <button class="primary" onclick="showModal()">+ New</button>
    </div>
    <div class="filter-bar" id="filterBar">
      <select id="filterState" onchange="applyFilter()" aria-label="Filter by status">
        <option value="all">all</option>
        <option value="running">running</option>
        <option value="review">review</option>
        <option value="pending">pending</option>
        <option value="suspended">suspended</option>
        <option value="done">done</option>
        <option value="failed">failed</option>
      </select>
      <select id="sortOrder" onchange="applyFilter()" style="width:auto" aria-label="Sort order">
        <option value="state">by state</option>
        <option value="newest">newest</option>
        <option value="oldest">oldest</option>
        <option value="priority">priority</option>
      </select>
      <input id="filterSearch" placeholder="Search..." oninput="applyFilter()" aria-label="Search tasks">
    </div>
    <div class="task-list" id="taskList"></div>
    <div class="proposal-toolbar" id="proposalToolbar" style="display:none">
      <span id="observerStatus">-</span>
      <div style="display:flex;gap:4px">
        <button onclick="showAnalyzeForm()" style="font-size:11px;padding:3px 8px">Analyze</button>
        <button onclick="showResearchForm()" style="font-size:11px;padding:3px 8px">Research</button>
        <button onclick="runObserver()" style="font-size:11px;padding:3px 8px">Run Observer</button>
      </div>
    </div>
    <div class="proposal-list" id="proposalList" style="display:none"></div>
    <div class="admin-section" id="adminSection" style="display:none">
      <h2 class="admin-heading">Admin</h2>
      <div class="admin-row">
        <span style="font-size:12px">Cleanup tasks older than</span>
        <input id="cleanupDays" type="number" value="30" min="1" aria-label="Cleanup days threshold">
        <span style="font-size:12px">days</span>
        <button onclick="cleanupTasks()" style="font-size:11px;padding:3px 8px">Cleanup</button>
      </div>
    </div>
    <div class="ap-toolbar" id="apToolbar" style="display:none">
      <button class="primary" onclick="showApStartForm()">+ New Autopilot</button>
    </div>
    <div class="ap-session-list" id="apSessionList" style="display:none"></div>
  </div>
  <div class="right">
    <div id="detailView" class="empty"><div class="empty-state"><div class="empty-icon">\u2190</div><div class="empty-title">Select a task</div><div class="empty-desc">Choose a task from the list to view details</div></div></div>
    <div id="chatView" style="display:none" class="terminal-container">
      <div class="terminal-toolbar">
        <span id="terminalStatus">disconnected</span>
        <div class="actions">
          <button onclick="terminalNew()">New Session</button>
        </div>
      </div>
      <div id="terminalPlaceholder" class="empty-state"><div class="empty-icon">\u{1F4BB}</div><div class="empty-title">Terminal</div><div class="empty-desc">Connecting to daemon... A terminal session will start automatically.</div></div>
      <div id="terminal"></div>
    </div>
  </div>
</main>

<footer class="footer" role="contentinfo">
  <span id="footerStats">-</span>
  <span id="footerResources">-</span>
</footer>

<div class="modal-overlay" id="modalOverlay" onclick="if(event.target===this)hideModal()">
  <form class="modal" onsubmit="event.preventDefault();submitTask()" role="dialog" aria-label="New task">
    <h2 style="font-size:18.72px">New Task</h2>
    <label>Title</label>
    <input id="taskTitle" placeholder="Task title" required>
    <label>Project path</label>
    <div class="project-row">
      <input id="taskProject" placeholder="~/my-project">
      <button type="button" onclick="openBrowser()">Browse</button>
    </div>
    <div class="dir-browser" id="dirBrowser" style="display:none">
      <div class="dir-header">
        <button type="button" onclick="browseUp()">\u2191</button>
        <span id="dirCurrent"></span>
        <button type="button" onclick="closeBrowser()">\u00d7</button>
      </div>
      <div class="dir-list" id="dirList"></div>
      <div class="dir-actions">
        <button type="button" onclick="createNewFolder(browserCurrentPath, browseDir)" style="margin-right:auto">New Folder</button>
        <button type="button" class="primary" onclick="selectCurrentDir()">Select this folder</button>
      </div>
    </div>
    <label>Description</label>
    <textarea id="taskDesc" placeholder="What needs to be done..."></textarea>
    <label>Pipeline</label>
    <select id="taskPipeline">
      <option value="auto">auto</option>
      <option value="small">small</option>
      <option value="medium">medium</option>
      <option value="large">large</option>
    </select>
    <div class="modal-actions">
      <button type="button" onclick="hideModal()">Cancel</button>
      <button type="button" class="refine" onclick="startRefinement('interactive')" title="AI asks clarifying questions to improve the task description">Q&amp;A Refine</button>
      <button type="button" class="refine" onclick="startRefinement('autopilot')" title="AI automatically improves the task description">Auto Refine</button>
      <button type="submit" class="primary" id="submitBtn">Submit</button>
    </div>
  </form>
</div>

<div class="modal-overlay" id="feedbackOverlay" onclick="if(event.target===this)hideFeedbackModal()">
  <form class="modal" onsubmit="event.preventDefault();submitFeedback()" role="dialog" aria-label="Request Changes">
    <h3>Request Changes</h3>
    <label>Feedback</label>
    <textarea id="feedbackText" placeholder="What needs to change..." rows="6" required style="min-height:120px"></textarea>
    <div class="modal-actions">
      <button type="button" onclick="hideFeedbackModal()">Cancel</button>
      <button type="submit" class="primary warning" id="feedbackSubmitBtn">Submit Feedback</button>
    </div>
  </form>
</div>

<div class="kbd-overlay" id="kbdOverlay" onclick="if(event.target===this)hideKbd()">
  <div class="kbd-panel">
    <h2 style="font-size:18.72px">Keyboard Shortcuts</h2>
    <div class="kbd-row"><span>Chat panel</span><kbd>1</kbd></div>
    <div class="kbd-row"><span>Tasks panel</span><kbd>2</kbd></div>
    <div class="kbd-row"><span>Proposals panel</span><kbd>3</kbd></div>
    <div class="kbd-row"><span>Autopilot panel</span><kbd>4</kbd></div>
    <div class="kbd-row"><span>New task</span><kbd>n</kbd></div>
    <div class="kbd-row"><span>Navigate tasks</span><kbd>\u2191 / \u2193</kbd></div>
    <div class="kbd-row"><span>Open selected task</span><kbd>Enter</kbd></div>
    <div class="kbd-row"><span>Close modal / overlay</span><kbd>Esc</kbd></div>
    <div class="kbd-row"><span>Show this help</span><kbd>?</kbd></div>
  </div>
</div>

<script>
const PORT = ${port};
let ws;
let tasks = [];
let stats = {};
let selectedTaskId = null;
let detailAbort = null;
let daemonStatus = 'running';
let refinementSession = null;
let currentRefinementQuestion = null;
let proposals = [];
let selectedProposalId = null;
let currentPanel = 'tasks';
let browserCurrentPath = '';
let taskLogs = new Map();
let currentFilter = 'all';
let currentSearch = '';
let currentSort = 'state';
let tabState = new Map();
let wsConnected = false;
let reconnectTimer = null;
let logAutoScroll = true;
let lastSelectedTaskState = null;
let autopilotSessions = [];
let selectedApSessionId = null;
let apDetailView = null; // 'list' | 'detail' | 'start'

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Toast Notifications ──

function showToast(message, type) {
  type = type || 'info';
  var container = document.getElementById('toastContainer');
  var el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(function() {
    el.classList.add('fade-out');
    setTimeout(function() { el.remove(); }, 300);
  }, 3000);
}

// ── Loading Helpers ──

function setButtonLoading(btn, loading) {
  if (!btn) return;
  btn.disabled = loading;
  if (loading) {
    btn._origText = btn.textContent;
    btn.innerHTML = '<span class="spinner"></span>';
  } else if (btn._origText) {
    btn.textContent = btn._origText;
    delete btn._origText;
  }
}

function showContentSpinner(el) {
  if (el) el.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;padding:32px"><span class="spinner spinner-lg"></span></div>';
}

// ── Format Helpers ──

function formatElapsed(startStr, endStr) {
  if (!startStr) return '-';
  var start = new Date(startStr).getTime();
  var end = endStr ? new Date(endStr).getTime() : Date.now();
  var diff = Math.max(0, end - start);
  if (diff < 1000) return diff + 'ms';
  var secs = Math.floor(diff / 1000);
  if (secs < 60) return secs + 's';
  var mins = Math.floor(secs / 60);
  var remSecs = secs % 60;
  if (mins < 60) return mins + 'm ' + remSecs + 's';
  var hours = Math.floor(mins / 60);
  return hours + 'h ' + (mins % 60) + 'm';
}

function formatDuration(ms) {
  if (!ms && ms !== 0) return '-';
  if (ms < 1000) return ms + 'ms';
  var secs = Math.round(ms / 1000);
  if (secs < 60) return secs + 's';
  return Math.floor(secs / 60) + 'm ' + (secs % 60) + 's';
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  var diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 0) return 'just now';
  var secs = Math.floor(diff / 1000);
  if (secs < 60) return secs + 's ago';
  var mins = Math.floor(secs / 60);
  if (mins < 60) return mins + 'm ago';
  var hours = Math.floor(mins / 60);
  if (hours < 24) return hours + 'h ago';
  var days = Math.floor(hours / 24);
  return days + 'd ago';
}

function formatUptime(seconds) {
  if (!seconds) return '-';
  var h = Math.floor(seconds / 3600);
  var m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}

// ── Diff Renderer ──

function renderDiffHtml(diffText) {
  if (!diffText) return '';
  return diffText.split('\\n').map(function(line) {
    var cls = '';
    if (line.startsWith('+++') || line.startsWith('---')) cls = 'diff-file';
    else if (line.startsWith('@@')) cls = 'diff-hunk';
    else if (line.startsWith('+')) cls = 'diff-add';
    else if (line.startsWith('-')) cls = 'diff-del';
    else cls = 'diff-ctx';
    return '<span class="' + cls + '">' + esc(line) + '</span>';
  }).join('\\n');
}

// ── Simple Markdown Renderer ──

function renderMarkdown(text) {
  if (!text) return '';
  var lines = text.split('\\n');
  var html = '';
  var inList = false;
  var inCode = false;
  var codeLines = [];
  var inTable = false;
  var tableRows = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    // Code blocks
    if (line.trim().startsWith('\`\`\`')) {
      if (inCode) {
        html += '<pre class="code-block">' + esc(codeLines.join('\\n')) + '</pre>';
        codeLines = [];
        inCode = false;
      } else {
        if (inList) { html += '</ul>'; inList = false; }
        if (inTable) { html += renderTable(tableRows); tableRows = []; inTable = false; }
        inCode = true;
      }
      continue;
    }
    if (inCode) { codeLines.push(line); continue; }
    // Table rows
    if (line.trim().match(/^\\|.+\\|$/)) {
      if (line.trim().match(/^\\|[-\\s:|]+\\|$/)) continue; // separator row
      if (inList) { html += '</ul>'; inList = false; }
      tableRows.push(line.trim().split('|').filter(function(c) { return c.trim() !== ''; }).map(function(c) { return c.trim(); }));
      inTable = true;
      continue;
    }
    if (inTable) { html += renderTable(tableRows); tableRows = []; inTable = false; }
    // Headers
    if (line.startsWith('### ')) { if (inList) { html += '</ul>'; inList = false; } html += '<h3>' + esc(line.slice(4)) + '</h3>'; continue; }
    if (line.startsWith('## ')) { if (inList) { html += '</ul>'; inList = false; } html += '<h2>' + esc(line.slice(3)) + '</h2>'; continue; }
    if (line.startsWith('# ')) { if (inList) { html += '</ul>'; inList = false; } html += '<h1>' + esc(line.slice(2)) + '</h1>'; continue; }
    // List items
    if (line.match(/^\\s*[-*] /)) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += '<li>' + inlineFormat(line.replace(/^\\s*[-*] /, '')) + '</li>';
      continue;
    }
    if (inList) { html += '</ul>'; inList = false; }
    // Blank line
    if (line.trim() === '') { html += '<br>'; continue; }
    // Regular text
    html += '<p>' + inlineFormat(line) + '</p>';
  }
  if (inCode) html += '<pre class="code-block">' + esc(codeLines.join('\\n')) + '</pre>';
  if (inList) html += '</ul>';
  if (inTable) html += renderTable(tableRows);
  return html;
}

function renderTable(rows) {
  if (rows.length === 0) return '';
  var html = '<table class="md-table"><thead><tr>';
  rows[0].forEach(function(c) { html += '<th>' + esc(c) + '</th>'; });
  html += '</tr></thead><tbody>';
  for (var i = 1; i < rows.length; i++) {
    html += '<tr>';
    rows[i].forEach(function(c) { html += '<td>' + esc(c) + '</td>'; });
    html += '</tr>';
  }
  html += '</tbody></table>';
  return html;
}

function inlineFormat(text) {
  var s = esc(text);
  s = s.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
  s = s.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
  s = s.replace(/\\*(.+?)\\*/g, '<em>$1</em>');
  return s;
}

// ── Copy to Clipboard ──

function copyText(text) {
  navigator.clipboard.writeText(text).then(function() {
    showToast('Copied', 'info');
  }).catch(function() {});
}

// ── Desktop Notification ──

function notifyDesktop(title, body) {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') {
    new Notification(title, { body: body, icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="%230d1117"/><text x="50" y="68" font-size="52" font-weight="bold" text-anchor="middle" fill="%2358a6ff">U</text></svg>' });
  } else if (Notification.permission !== 'denied') {
    Notification.requestPermission();
  }
}

// ── Page Title Update ──

function updatePageTitle() {
  var reviewCount = tasks.filter(function(t) { return t.state === 'review'; }).length;
  var apActive = autopilotSessions.filter(function(s) { return s.status !== 'stopped'; }).length;
  var prefix = reviewCount > 0 ? '(' + reviewCount + ') ' : '';
  document.title = prefix + (apActive > 0 ? '[AP] ' : '') + 'UCM Dashboard';
}

// ── File Browser ──

function openBrowser() {
  var input = document.getElementById('taskProject').value.trim();
  var startPath = input || '';
  fetch('/api/browse?path=' + encodeURIComponent(startPath))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.error) { showToast(data.error, 'error'); return; }
      renderBrowser(data);
      document.getElementById('dirBrowser').style.display = 'flex';
    })
    .catch(function(err) { showToast('Browse failed: ' + err.message, 'error'); });
}

function renderBrowser(data) {
  browserCurrentPath = data.current;
  document.getElementById('dirCurrent').textContent = data.current;
  var list = document.getElementById('dirList');
  list.innerHTML = '';
  data.directories.forEach(function(d) {
    var item = document.createElement('div');
    item.className = 'dir-item';
    item.innerHTML = '<span class="icon">\ud83d\udcc1</span>' + escapeHtml(d.name);
    item.onclick = function() { browseDir(d.path); };
    list.appendChild(item);
  });
  if (data.directories.length === 0) {
    list.innerHTML = '<div style="padding:12px;color:var(--text-muted);font-size:13px">No subdirectories</div>';
  }
}

function browseDir(dirPath) {
  fetch('/api/browse?path=' + encodeURIComponent(dirPath))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.error) { showToast(data.error, 'error'); return; }
      renderBrowser(data);
    });
}

function browseUp() {
  var current = browserCurrentPath;
  fetch('/api/browse?path=' + encodeURIComponent(current))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.parent && data.parent !== data.current) {
        browseDir(data.parent);
      }
    });
}

function selectCurrentDir() {
  document.getElementById('taskProject').value = browserCurrentPath;
  closeBrowser();
}

function closeBrowser() {
  document.getElementById('dirBrowser').style.display = 'none';
}

function createNewFolder(parentPath, refreshCallback) {
  var name = prompt('New folder name:');
  if (!name || !name.trim()) return;
  name = name.trim();
  if (/[\\/\\\\]/.test(name)) { showToast('Invalid folder name', 'error'); return; }
  var newPath = parentPath + '/' + name;
  fetch('/api/mkdir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: newPath }) })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.error) { showToast(data.error, 'error'); return; }
      refreshCallback(data.created);
    })
    .catch(function(err) { showToast('Failed: ' + err.message, 'error'); });
}

// ── Connection State ──

function setConnState(state) {
  var dot = document.getElementById('connDot');
  var text = document.getElementById('connText');
  if (dot) dot.className = 'conn-dot ' + state;
  if (state === 'connected') { wsConnected = true; if (text) text.textContent = ''; }
  else if (state === 'connecting') { wsConnected = false; if (text) text.textContent = 'connecting...'; }
  else { wsConnected = false; if (text) text.textContent = 'disconnected'; }
}

// ── WebSocket ──

function connect() {
  setConnState('connecting');
  ws = new WebSocket('ws://' + location.host);
  ws.binaryType = 'arraybuffer';
  ws.onopen = function() {
    setConnState('connected');
    loadInitial();
    if (window._pollTimer) clearInterval(window._pollTimer);
    window._pollTimer = setInterval(loadInitial, 30000);
  };
  ws.onmessage = function(e) {
    if (e.data instanceof ArrayBuffer) {
      if (term) term.write(new Uint8Array(e.data));
      return;
    }
    try {
      var msg = JSON.parse(e.data);
      if (msg.event && msg.event.startsWith('pty:')) {
        handlePtyMessage(msg.event, msg.data);
        return;
      }
      handleEvent(msg.event, msg.data);
    } catch (err) { console.error('ws message parse error:', err); }
  };
  ws.onerror = function(e) { console.error('ws error:', e); };
  ws.onclose = function(e) {
    console.log('ws close: code=' + e.code + ' reason=' + e.reason + ' wasClean=' + e.wasClean);
    setConnState('disconnected');
    document.getElementById('statusText').textContent = 'disconnected';
    document.getElementById('statusDot').className = 'dot';
    setTerminalStatus('disconnected');
    setTimeout(connect, 3000);
  };
}

async function loadInitial() {
  try {
    var jsonOr = function(fallback) { return function(r) { return r.ok ? r.json() : fallback; }; };
    var results = await Promise.all([
      fetch('/api/list').then(jsonOr([])),
      fetch('/api/stats').then(jsonOr({})),
      fetch('/api/proposals').then(jsonOr([])),
      fetch('/api/autopilot/status').then(jsonOr([])),
    ]);
    tasks = Array.isArray(results[0]) ? results[0] : [];
    stats = results[1] && typeof results[1] === 'object' && !results[1].error ? results[1] : {};
    proposals = Array.isArray(results[2]) ? results[2] : [];
    autopilotSessions = Array.isArray(results[3]) ? results[3] : [];
    daemonStatus = stats.daemonStatus || (tasks.length === 0 && !stats.pid ? 'offline' : 'running');
    renderAll();
    if (stats.pipelines && stats.pipelines.length > 0) {
      var sel = document.getElementById('taskPipeline');
      if (sel) {
        sel.innerHTML = '';
        var autoOpt = document.createElement('option');
        autoOpt.value = 'auto';
        autoOpt.textContent = 'auto (LLM \\uC790\\uB3D9 \\uD310\\uB2E8)';
        autoOpt.selected = true;
        sel.appendChild(autoOpt);
        stats.pipelines.forEach(function(p) {
          var opt = document.createElement('option');
          opt.value = p;
          opt.textContent = p;
          sel.appendChild(opt);
        });
      }
    }
    // Only re-render detail if task state changed (avoid destroying scroll position)
    if (selectedTaskId) {
      var currentTask = tasks.find(function(t) { return t.id === selectedTaskId; });
      var currentState = currentTask ? (currentTask.state || currentTask.status) : null;
      if (currentState !== lastSelectedTaskState) {
        lastSelectedTaskState = currentState;
        loadDetail(selectedTaskId);
      }
    }
    if (refinementSession) {
      renderRefinementPanel();
    } else {
      switchPanel(currentPanel);
    }
  } catch (err) {
    console.error('loadInitial error:', err);
    daemonStatus = 'offline';
    tasks = [];
    proposals = [];
    renderAll();
  }
}

function handleEvent(event, data) {
  if (event === 'task:created') {
    var existing = tasks.find(function(t) { return t.id === data.id; });
    if (!existing) tasks.unshift(data);
    renderTasks();
    updatePageTitle();
    showToast('Task created: ' + (data.title || data.id), 'success');
  } else if (event === 'task:updated') {
    var task = tasks.find(function(t) { return t.id === data.taskId; });
    var prevState = task ? task.state : null;
    if (task) {
      if (data.state) task.state = data.state;
      if (data.stage) task.currentStage = data.stage;
      if (data.status) task.stageStatus = data.status;
      if (data.state && data.state !== prevState) {
        var toastType = data.state === 'done' ? 'success' : data.state === 'failed' ? 'error' : data.state === 'review' ? 'warning' : 'info';
        showToast((task.title || data.taskId) + ' \u2192 ' + data.state, toastType);
        if (data.state === 'review') {
          notifyDesktop('Review needed', task.title || data.taskId);
        }
      }
    }
    renderTasks();
    updatePageTitle();
    // Only refresh detail on state change (avoid destroying scroll on stage updates)
    if (data.taskId === selectedTaskId && data.state && data.state !== prevState) {
      lastSelectedTaskState = data.state;
      loadDetail(selectedTaskId);
    }
  } else if (event === 'task:deleted') {
    var deleted = tasks.find(function(t) { return t.id === data.taskId; });
    tasks = tasks.filter(function(t) { return t.id !== data.taskId; });
    taskLogs.delete(data.taskId);
    tabState.delete(data.taskId);
    if (selectedTaskId === data.taskId) { clearDetail(); document.getElementById('detailView').innerHTML = '<div class="empty-state"><div class="empty-icon">\u2190</div><div class="empty-title">Select a task</div><div class="empty-desc">Choose a task from the list to view details</div></div>'; document.getElementById('detailView').className = 'empty'; }
    renderTasks();
    updatePageTitle();
    if (deleted) showToast('Task deleted: ' + (deleted.title || data.taskId), 'info');
  } else if (event === 'daemon:status') {
    var wasOffline = daemonStatus === 'offline';
    daemonStatus = data.status;
    renderStatus();
    if (wasOffline && data.status !== 'offline') loadInitial();
  } else if (event === 'stats:updated') {
    stats = data;
    daemonStatus = stats.daemonStatus || daemonStatus;
    renderFooter();
    renderStatus();
  } else if (event === 'project:ask') {
    showProjectAskPanel(data.taskId);
  } else if (event === 'gather:question' && data.taskId === selectedTaskId) {
    showGatherQuestions(data.taskId, data.round, data.questions);
  } else if (event === 'gather:done' && data.taskId === selectedTaskId) {
    hideGatherPanel();
  } else if (event === 'task:log') {
    // Always buffer logs regardless of which task is selected
    var logLines = taskLogs.get(data.taskId);
    if (!logLines) { logLines = []; taskLogs.set(data.taskId, logLines); }
    logLines.push(data.line);
    // If currently viewing this task's logs, append live
    if (data.taskId === selectedTaskId) {
      var logEl = document.getElementById('logContent');
      if (logEl) {
        logEl.textContent += data.line + '\\n';
        if (logAutoScroll) logEl.scrollTop = logEl.scrollHeight;
      }
    }
  } else if (event === 'refinement:started' && refinementSession) {
    if (data.sessionId) refinementSession.sessionId = data.sessionId;
    refinementSession.mode = data.mode;
    renderRefinementPanel();
  } else if (event === 'refinement:question' && refinementSession && data.sessionId === refinementSession.sessionId) {
    currentRefinementQuestion = data;
    refinementSession.coverage = data.coverage;
    renderRefinementPanel();
  } else if (event === 'refinement:progress' && refinementSession && data.sessionId === refinementSession.sessionId) {
    refinementSession.decisions.push(data.decision);
    refinementSession.coverage = data.coverage;
    renderRefinementPanel();
  } else if (event === 'refinement:complete' && refinementSession && data.sessionId === refinementSession.sessionId) {
    refinementSession.coverage = data.coverage;
    refinementSession.decisions = data.decisions || refinementSession.decisions;
    refinementSession.complete = true;
    if (data.pipeline) refinementSession.pipeline = data.pipeline;
    currentRefinementQuestion = null;
    renderRefinementPanel();
  } else if (event === 'refinement:finalized' && refinementSession && data.sessionId === refinementSession.sessionId) {
    refinementSession = null;
    currentRefinementQuestion = null;
    loadInitial();
    if (data.taskId) selectTask(data.taskId);
  } else if (event === 'refinement:mode_changed' && refinementSession && data.sessionId === refinementSession.sessionId) {
    refinementSession.mode = data.mode;
    renderRefinementPanel();
  } else if (event === 'refinement:error' && refinementSession && data.sessionId === refinementSession.sessionId) {
    refinementSession.statusText = 'Error: ' + (data.error || 'unknown');
    var statusEl = document.getElementById('refStatus');
    if (statusEl) statusEl.textContent = refinementSession.statusText;
  } else if (event === 'refinement:status' && refinementSession && data.sessionId === refinementSession.sessionId) {
    refinementSession.statusText = data.status;
    var statusEl2 = document.getElementById('refStatus');
    if (statusEl2) statusEl2.textContent = data.status;
  } else if (event === 'refinement:cancelled' && refinementSession && data.sessionId === refinementSession.sessionId) {
    refinementSession = null;
    currentRefinementQuestion = null;
    var view = document.getElementById('detailView');
    view.className = 'empty';
    view.innerHTML = '<div class="empty-state"><div class="empty-icon">\u2190</div><div class="empty-title">Select a task</div><div class="empty-desc">Choose a task from the list to view details</div></div>';
  } else if (event === 'proposal:created') {
    var existingP = proposals.find(function(p) { return p.id === data.id; });
    if (!existingP) proposals.unshift(data);
    renderProposals();
  } else if (event === 'proposal:updated') {
    var idx = proposals.findIndex(function(p) { return p.id === data.id; });
    if (idx >= 0) {
      proposals[idx] = Object.assign({}, proposals[idx], data);
    }
    renderProposals();
    if (data.id === selectedProposalId) loadProposalDetail(data.id);
  } else if (event === 'proposal:evaluated') {
    var idx2 = proposals.findIndex(function(p) { return p.id === data.id; });
    if (idx2 >= 0) {
      proposals[idx2] = Object.assign({}, proposals[idx2], data);
    }
    renderProposals();
    if (data.id === selectedProposalId) loadProposalDetail(data.id);
  } else if (event === 'observer:started') {
    showToast('Observer cycle started', 'info');
  } else if (event === 'observer:completed') {
    fetch('/api/proposals').then(function(r) { return r.json(); }).then(function(list) { proposals = list; renderProposals(); }).catch(function() {});
    showToast('Observer completed: ' + (data.proposalCount || 0) + ' proposals', 'success');
    loadObserverStatus();
  } else if (event === 'proposal:promoted') {
    showToast('Proposal promoted to task: ' + (data.taskId || ''), 'success');
    loadInitial();
  } else if (event && event.startsWith('autopilot:')) {
    handleAutopilotEvent(event, data);
  }
}

// ── Render ──

function renderAll() {
  renderStatus();
  renderTasks();
  renderProposals();
  renderFooter();
  renderStatsBar();
  updatePageTitle();
  updateReviewBadge();
  updateApBadge();
  // Hide right panel when no tasks and none selected (empty state)
  var rightEl = document.querySelector('.right');
  if (rightEl) {
    if (currentPanel === 'chat') {
      // chat handles its own layout
    } else if (currentPanel === 'tasks' && !selectedTaskId && tasks.length === 0 && !refinementSession) {
      rightEl.style.display = 'none';
    } else if (currentPanel === 'proposals' && !selectedProposalId) {
      rightEl.style.display = 'none';
    } else if (currentPanel === 'autopilot' && !selectedApSessionId) {
      rightEl.style.display = 'none';
    } else {
      rightEl.style.display = '';
    }
  }
}

function renderStatus() {
  var dot = document.getElementById('statusDot');
  var text = document.getElementById('statusText');
  var btn = document.getElementById('pauseBtn');
  var stopBtn = document.getElementById('stopDaemonBtn');
  if (daemonStatus === 'offline') {
    dot.className = 'dot offline';
    text.textContent = 'offline';
    btn.textContent = 'Start';
    btn.setAttribute('aria-label', 'Start UCM engine');
    btn.onclick = startDaemon;
    if (stopBtn) stopBtn.style.display = 'none';
  } else {
    dot.className = 'dot ' + daemonStatus;
    text.textContent = daemonStatus;
    var label = daemonStatus === 'paused' ? 'Resume' : 'Pause';
    btn.textContent = label;
    btn.setAttribute('aria-label', label + ' daemon');
    btn.onclick = togglePause;
    if (stopBtn) stopBtn.style.display = '';
  }
}

function renderTasks() {
  var order = { running: 0, review: 1, suspended: 2, pending: 3, done: 4, failed: 5 };
  var filtered = tasks.filter(function(t) {
    var state = t.state || t.status || 'pending';
    if (currentFilter !== 'all' && state !== currentFilter) return false;
    if (currentSearch) {
      var q = currentSearch.toLowerCase();
      var title = (t.title || '').toLowerCase();
      var id = (t.id || '').toLowerCase();
      if (title.indexOf(q) === -1 && id.indexOf(q) === -1) return false;
    }
    return true;
  });
  // Sort
  var sorted;
  if (currentSort === 'newest') {
    sorted = filtered.slice().sort(function(a, b) { return (b.created || '').localeCompare(a.created || ''); });
  } else if (currentSort === 'oldest') {
    sorted = filtered.slice().sort(function(a, b) { return (a.created || '').localeCompare(b.created || ''); });
  } else if (currentSort === 'priority') {
    sorted = filtered.slice().sort(function(a, b) { return (b.priority || 0) - (a.priority || 0); });
  } else {
    sorted = filtered.slice().sort(function(a, b) { return (order[a.state] || 5) - (order[b.state] || 5); });
  }
  var el = document.getElementById('taskList');
  // Hide filter bar and admin when no tasks exist
  var hasAnyTasks = tasks.length > 0;
  if (currentPanel === 'tasks') {
    document.getElementById('filterBar').style.display = hasAnyTasks ? 'flex' : 'none';
    document.getElementById('adminSection').style.display = hasAnyTasks ? '' : 'none';
  }
  if (sorted.length === 0) {
    var emptyTitle = currentFilter !== 'all' || currentSearch ? 'No matching tasks' : 'No tasks yet';
    var emptyDesc = currentFilter !== 'all' || currentSearch ? 'Try changing filters' :
      (daemonStatus === 'offline' ? 'Click "Start" above to begin' : 'Click "+ New" to create one');
    el.innerHTML = '<div class="empty-state"><div class="empty-icon">\ud83d\udcdd</div><div class="empty-title">' + emptyTitle + '</div><div class="empty-desc">' + emptyDesc + '</div></div>';
    return;
  }
  var savedScroll = el.scrollTop;
  el.innerHTML = sorted.map(function(t) {
    var state = t.state || t.status || 'pending';
    var stageInfo = (state === 'running' && t.currentStage) ? ' <span class="current-stage">' + esc(t.currentStage) + '</span>' : '';
    var ago = t.created ? '<span>' + timeAgo(t.created) + '</span>' : '';
    var prioHtml = (t.priority && t.priority > 0) ? '<span style="color:var(--yellow)">\u2605' + t.priority + '</span>' : '';
    var apIcon = t.autopilotSession ? '<span class="ap-task-icon">\ud83e\udd16</span>' : '';
    var reviewHint = state === 'review' ? ' <span class="review-hint">review needed</span>' : '';
    return '<div class="task-item' + (t.id === selectedTaskId ? ' selected' : '') + (state === 'review' ? ' needs-review' : '') + '" data-id="' + esc(t.id) + '" onclick="selectTask(\\'' + esc(t.id) + '\\')">' +
      '<div class="title">' + apIcon + '<span class="badge ' + esc(state) + '">' + esc(state) + '</span>' + stageInfo + ' ' + esc(t.title) + reviewHint + '</div>' +
      '<div class="meta"><span>' + esc((t.id || '').slice(0,8)) + '</span><span>' + esc(t.project ? t.project.split('/').pop() : '') + '</span>' + ago + prioHtml + '</div>' +
      '</div>';
  }).join('');
  el.scrollTop = savedScroll;
  updateReviewBadge();
}

function updateReviewBadge() {
  var reviewCount = tasks.filter(function(t) { return t.state === 'review'; }).length;
  var btn = document.getElementById('tasksToggle');
  if (btn) btn.innerHTML = reviewCount > 0 ? 'Tasks <span class="count-badge">' + reviewCount + '</span>' : 'Tasks';
}

function renderStatsBar() {
  var el = document.getElementById('statsBar');
  if (!el) return;
  if (daemonStatus === 'offline') { el.style.display = 'none'; return; }
  el.style.display = '';
  var completed = stats.tasksCompleted || 0;
  var failed = stats.tasksFailed || 0;
  var total = completed + failed;
  var successRate = total > 0 ? Math.round(completed / total * 100) : 0;
  var spawns = stats.totalSpawns || 0;
  var active = stats.activeTasks ? stats.activeTasks.length : 0;
  var suspended = stats.suspendedTasks ? stats.suspendedTasks.length : 0;
  var uptime = stats.uptime ? formatUptime(stats.uptime) : '-';

  el.innerHTML =
    '<div class="stat-item">Completed: <span class="stat-value green">' + completed + '</span></div>' +
    '<div class="stat-item">Failed: <span class="stat-value red">' + failed + '</span></div>' +
    '<div class="stat-item">Success: <span class="stat-value ' + (successRate >= 80 ? 'green' : successRate >= 50 ? 'yellow' : 'red') + '">' + successRate + '%</span></div>' +
    '<div class="stat-item">Processes: <span class="stat-value">' + spawns + '</span></div>' +
    '<div class="stat-item">Active: <span class="stat-value">' + active + '</span></div>' +
    (suspended > 0 ? '<div class="stat-item">Suspended: <span class="stat-value yellow">' + suspended + '</span></div>' : '') +
    '<div class="stat-item">Uptime: <span class="stat-value">' + uptime + '</span></div>';
}

function renderFooter() {
  var counts = { pending: 0, running: 0, review: 0, done: 0, failed: 0, suspended: 0 };
  tasks.forEach(function(t) { var s = t.state || t.status; if (counts[s] !== undefined) counts[s]++; });
  // Show only active work summary (not duplicating stats bar)
  var activeParts = [];
  if (counts.running > 0) activeParts.push(counts.running + ' running');
  if (counts.review > 0) activeParts.push(counts.review + ' review');
  if (counts.pending > 0) activeParts.push(counts.pending + ' pending');
  if (counts.suspended > 0) activeParts.push(counts.suspended + ' suspended');
  document.getElementById('footerStats').textContent =
    activeParts.length > 0 ? activeParts.join(' · ') : (tasks.length > 0 ? tasks.length + ' tasks — all done' : 'No tasks');

  var parts = [];
  var r = stats.resources;
  if (r) {
    parts.push('CPU: ' + (r.cpuLoad * 100).toFixed(0) + '%');
    parts.push('Mem: ' + Math.round(r.memoryFreeMb) + 'MB free');
    parts.push('Disk: ' + (r.diskFreeGb !== null ? r.diskFreeGb.toFixed(1) + 'GB' : 'n/a'));
  }

  // Resource pressure
  var pressure = stats.resourcePressure || 'normal';
  var pressureHtml = daemonStatus === 'offline' ? '' : '<span class="resource-badge ' + esc(pressure) + '">Load: ' + esc(pressure) + '</span>';

  // Pause reason
  var pauseHtml = '';
  if (daemonStatus === 'paused' && stats.pauseReason) {
    pauseHtml = ' <span class="pause-reason">paused: ' + esc(stats.pauseReason) + '</span>';
  }

  // Suspended tasks count
  var suspCount = counts.suspended || 0;
  var suspHtml = suspCount > 0 ? ' | suspended: ' + suspCount : '';

  // Daemon uptime
  var uptimeHtml = '';
  if (stats.startedAt) {
    uptimeHtml = ' | uptime: ' + formatElapsed(stats.startedAt);
  }

  var el = document.getElementById('footerResources');
  el.innerHTML = (parts.length > 0 ? parts.join(' | ') + ' | ' : '') + pressureHtml + pauseHtml + suspHtml + uptimeHtml;
}

// ── Filter ──

function applyFilter() {
  currentFilter = document.getElementById('filterState').value;
  currentSearch = document.getElementById('filterSearch').value.trim();
  var sortEl = document.getElementById('sortOrder');
  currentSort = sortEl ? sortEl.value : 'state';
  renderTasks();
}

// ── Task Detail ──

async function selectTask(id) {
  selectedTaskId = id;
  var currentTask = tasks.find(function(t) { return t.id === id; });
  lastSelectedTaskState = currentTask ? (currentTask.state || currentTask.status) : null;
  renderTasks();
  var rightEl = document.querySelector('.right');
  if (rightEl) rightEl.classList.add('has-detail');
  await loadDetail(id);
}

async function loadDetail(id) {
  if (detailAbort) detailAbort.abort();
  detailAbort = new AbortController();
  var signal = detailAbort.signal;
  var view = document.getElementById('detailView');
  view.className = '';
  view.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;flex:1"><span class="spinner spinner-lg"></span></div>';
  try {
    var results = await Promise.all([
      fetch('/api/status/' + id, { signal }).then(function(r) { return r.ok ? r.json() : null; }),
      fetch('/api/artifacts/' + id, { signal }).then(function(r) { return r.ok ? r.json() : {}; }).catch(function() { return {}; }),
    ]);
    var task = results[0];
    var artifacts = results[1];
    if (!task) { view.className = 'empty'; view.innerHTML = '<div class="empty-state"><div class="empty-icon">\u2190</div><div class="empty-title">Task not found</div><div class="empty-desc">The task may have been deleted</div></div>'; clearDetail(); return; }
    var state = task.state || task.status || 'pending';
    var safeId = esc(id);

    // Actions
    var actions = '';
    if (state === 'review') {
      actions = '<div class="actions">' +
        '<button class="primary" onclick="approveTask(\\'' + safeId + '\\')">Approve</button>' +
        '<button class="warning" onclick="requestChanges(\\'' + safeId + '\\')">Request Changes</button>' +
        '<button class="danger" onclick="rejectTask(\\'' + safeId + '\\')">Reject</button>' +
        '</div>';
    }
    if (state === 'pending' || state === 'running') {
      actions = '<div class="actions"><button class="danger" onclick="cancelTask(\\'' + safeId + '\\')">Cancel</button></div>';
    }
    if (state === 'suspended') {
      actions = '<div class="actions">' +
        '<button class="primary" onclick="approveTask(\\'' + safeId + '\\')">Resume</button>' +
        '<button class="danger" onclick="cancelTask(\\'' + safeId + '\\')">Cancel</button>' +
        '</div>';
    }
    if (state === 'failed') {
      actions = '<div class="actions">' +
        '<button class="primary" onclick="retryTask(\\'' + safeId + '\\')">Retry</button>' +
        '<span style="flex:1"></span>' +
        '<button class="btn-muted" onclick="deleteTask(\\'' + safeId + '\\')">Delete</button>' +
        '</div>';
    }
    if (state === 'done') {
      actions = '<div class="actions">' +
        '<span style="flex:1"></span>' +
        '<button class="btn-muted" onclick="deleteTask(\\'' + safeId + '\\')">Delete</button>' +
        '</div>';
    }

    // Metadata grid
    var metaRows = '';
    if (task.pipeline) {
      metaRows += '<span class="label">Pipeline</span><span class="value"><span class="badge-sm ' + esc(state) + '">' + esc(task.pipeline) + '</span></span>';
    }
    if (task.project) {
      metaRows += '<span class="label">Project</span><span class="value">' + esc(task.project) + '</span>';
    }
    // Multi-project support
    if (task.projects && task.projects.length > 1) {
      metaRows += '<span class="label">Projects</span><span class="value">' +
        task.projects.map(function(p) {
          return esc(p.name || p.path.split('/').pop()) + (p.role ? ' <small style="color:var(--text-muted)">(' + esc(p.role) + ')</small>' : '');
        }).join(', ') + '</span>';
    }
    if (task.startedAt) {
      metaRows += '<span class="label">Started</span><span class="value">' + timeAgo(task.startedAt) + ' <small style="color:var(--text-muted)">(' + esc(task.startedAt) + ')</small></span>';
    }
    if (task.completedAt) {
      metaRows += '<span class="label">Completed</span><span class="value">' + timeAgo(task.completedAt) + ' <small style="color:var(--text-muted)">(' + esc(task.completedAt) + ')</small></span>';
    }
    if (task.startedAt) {
      metaRows += '<span class="label">Elapsed</span><span class="value">' + formatElapsed(task.startedAt, task.completedAt) + '</span>';
    }
    if (state === 'running' && task.currentStage) {
      metaRows += '<span class="label">Current Stage</span><span class="value" style="color:var(--accent)">' + esc(task.currentStage) + '</span>';
    }
    if (state === 'suspended') {
      if (task.suspendedStage) {
        metaRows += '<span class="label">Suspended At</span><span class="value" style="color:var(--yellow)">' + esc(task.suspendedStage) + '</span>';
      }
      if (task.suspendReason) {
        metaRows += '<span class="label">Reason</span><span class="value" style="color:var(--yellow)">' + esc(task.suspendReason) + '</span>';
      }
    }
    if (task.feedback) {
      metaRows += '<span class="label">Feedback</span><span class="value" style="color:var(--red)">' + esc(task.feedback) + '</span>';
    }
    if ((state === 'running' || state === 'review') && task.project) {
      var projName = task.project.split('/').pop();
      var wtPath = '~/.ucm/worktrees/' + safeId + '/' + projName;
      metaRows += '<span class="label">Worktree</span><span class="value"><code style="font-size:11px;background:var(--bg);padding:2px 6px;border-radius:4px">' + esc(wtPath) + '</code> ' +
        '<button class="copy-btn" onclick="copyText(\\'cd ' + esc(wtPath) + '\\')" title="Copy cd command" style="font-size:11px;padding:1px 6px">cd \\ud83d\\udccb</button></span>';
    }

    var metaGridHtml = metaRows ? '<div class="meta-grid">' + metaRows + '</div>' : '';

    // Pipeline bar from memory.json timeline
    var pipelineBarHtml = '';
    var memory = artifacts.memory;
    if (memory && memory.timeline && memory.timeline.length > 0) {
      var stageMap = {};
      memory.timeline.forEach(function(entry) {
        stageMap[entry.stage] = entry.status || 'pending';
      });
      // Also use pipeline stages if available
      var stageNames = memory.pipelineStages || Object.keys(stageMap);
      pipelineBarHtml = '<div class="pipeline-bar">';
      stageNames.forEach(function(name, i) {
        var st = stageMap[name] || 'pending';
        var icon = st === 'done' ? ' \u2713' : st === 'running' ? ' \u25cf' : st === 'failed' ? ' \u2717' : '';
        pipelineBarHtml += (i > 0 ? '<span style="color:var(--text-muted);align-self:center">\u2192</span>' : '') +
          '<span class="stage ' + esc(st) + '">' + esc(name) + icon + '</span>';
      });
      pipelineBarHtml += '</div>';
    }

    // Restore last tab — default to logs for running, diff for review
    var lastTab = tabState.get(id) || (state === 'running' ? 'logs' : state === 'review' ? 'diff' : 'summary');

    view.innerHTML =
      '<button class="mobile-back" onclick="clearDetail();switchPanel(currentPanel)">\u2190 Back</button>' +
      '<div class="detail-header">' +
        '<h2>' + esc(task.title) + '</h2>' +
        '<div class="meta"><span class="badge ' + esc(state) + '">' + esc(state) + '</span> ' +
        '<button class="copy-btn" onclick="copyText(\\'' + safeId + '\\')" title="Copy ID">' + safeId + ' \ud83d\udccb</button>' +
        ' | ' + timeAgo(task.created) + '</div>' +
        metaGridHtml +
        pipelineBarHtml +
        (task.body ? '<details class="spec-details"><summary class="spec-toggle">Spec</summary><div class="summary-content" style="font-size:13px">' + renderMarkdown(task.body) + '</div></details>' : '') +
        actions +
      '</div>' +
      '<div class="tabs">' +
        '<button class="' + (lastTab === 'summary' ? 'active' : '') + '" onclick="showTab(this,\\'summary\\')">Summary</button>' +
        '<button class="' + (lastTab === 'diff' ? 'active' : '') + '" onclick="showTab(this,\\'diff\\')">Diff</button>' +
        '<button class="' + (lastTab === 'logs' ? 'active' : '') + '" onclick="showTab(this,\\'logs\\')">Logs</button>' +
      '</div>' +
      '<div class="tab-content" id="tabContent"></div>';
    showTabContent(lastTab, id, signal, lastTab === 'summary' ? artifacts : undefined);
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('loadDetail error:', err); view.className = 'empty'; view.innerHTML = 'Error loading task';
  }
}

async function showTabContent(tab, id, signal, cachedArtifacts) {
  var el = document.getElementById('tabContent');
  if (!el) return;
  // Save tab state
  tabState.set(id, tab);
  showContentSpinner(el);
  var opts = signal ? { signal: signal } : {};
  try {
    if (tab === 'summary') {
      var art = cachedArtifacts || await fetch('/api/artifacts/' + id, opts).then(function(r) { return r.json(); });

      var html = '';

      // Timeline table from memory.json
      if (art.memory && art.memory.timeline && art.memory.timeline.length > 0) {
        var hasDuration = art.memory.timeline.some(function(e) { return e.duration || e.startedAt; });
        var hasIter = art.memory.timeline.some(function(e) { return e.iteration && e.iteration > 0; });
        html += '<table class="timeline-table"><thead><tr><th>Stage</th><th>Status</th>' + (hasDuration ? '<th>Duration</th>' : '') + (hasIter ? '<th>Iter</th>' : '') + '</tr></thead><tbody>';
        art.memory.timeline.forEach(function(entry) {
          var statusClass = 'status-' + (entry.status || 'pending');
          var duration = entry.duration ? formatDuration(entry.duration) : (entry.startedAt ? formatElapsed(entry.startedAt, entry.completedAt) : '-');
          html += '<tr>' +
            '<td>' + esc(entry.stage) + '</td>' +
            '<td class="' + statusClass + '">' + esc(entry.status || 'pending') + '</td>' +
            (hasDuration ? '<td>' + duration + '</td>' : '') +
            (hasIter ? '<td>' + (entry.iteration || '-') + '</td>' : '') +
            '</tr>';
        });
        html += '</tbody></table>';
      }

      if (art.summary) {
        html += '<div class="summary-content">' + renderMarkdown(art.summary) + '</div>';
      } else {
        var r = await fetch('/api/status/' + id, opts).then(function(r2) { return r2.json(); });
        html += '<pre>' + esc(r.body || '(no summary yet)') + '</pre>';
      }
      el.innerHTML = html;
    } else if (tab === 'diff') {
      var diffs = await fetch('/api/diff/' + id, opts).then(function(r) { return r.json(); });
      if (diffs.length === 0) {
        el.innerHTML = '<div class="empty-state"><div class="empty-icon">\ud83d\udcc4</div><div class="empty-title">No diffs yet</div><div class="empty-desc">Changes will appear here once the task modifies files</div></div>';
      } else {
        el.innerHTML = diffs.map(function(d) {
          return '<h4 style="color:var(--accent);margin-bottom:4px">' + esc(d.project) + '</h4><pre class="diff-view">' + renderDiffHtml(d.diff) + '</pre>';
        }).join('');
      }
    } else if (tab === 'logs') {
      // Use buffered logs first, then fetch from API
      var buffered = taskLogs.get(id);
      var logText = '';
      if (buffered && buffered.length > 0) {
        logText = buffered.join('\\n');
      } else {
        var logs = await fetch('/api/logs/' + id, opts).then(function(r) { return r.json(); });
        logText = typeof logs === 'string' ? logs : JSON.stringify(logs);
        if (logText) {
          taskLogs.set(id, logText.split('\\n'));
        }
      }
      el.innerHTML =
        '<div class="log-toolbar"><label><input type="checkbox" id="logAutoScrollCheck" ' + (logAutoScroll ? 'checked' : '') + ' onchange="logAutoScroll=this.checked"> Auto-scroll</label>' +
        '<button class="copy-btn" onclick="copyLogContent()">Copy logs</button></div>' +
        '<pre id="logContent">' + (logText ? esc(logText) : '(no logs yet)') + '</pre>';
      var logEl = document.getElementById('logContent');
      if (logEl && logAutoScroll) logEl.scrollTop = logEl.scrollHeight;
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('showTabContent error:', err); el.innerHTML = '<pre>Error loading</pre>';
  }
}

function copyLogContent() {
  var el = document.getElementById('logContent');
  if (el) copyText(el.textContent);
}

function showTab(btn, tab) {
  btn.parentElement.querySelectorAll('button').forEach(function(b) { b.classList.remove('active'); });
  btn.classList.add('active');
  if (selectedTaskId) showTabContent(tab, selectedTaskId);
}

// ── Task Actions ──

function disableActionButtons() {
  document.querySelectorAll('.detail-header .actions button').forEach(function(b) { b.disabled = true; });
}
async function approveTask(id) { disableActionButtons(); await postAction('/api/approve/' + id, null, 'Approved'); loadInitial(); }
async function rejectTask(id) { disableActionButtons(); await postAction('/api/reject/' + id, null, 'Rejected'); loadInitial(); }
async function cancelTask(id) { disableActionButtons(); await postAction('/api/cancel/' + id, null, 'Cancelled'); loadInitial(); }
async function retryTask(id) { disableActionButtons(); await postAction('/api/retry/' + id, null, 'Retrying'); loadInitial(); }
async function deleteTask(id) {
  if (!confirm('Delete this task?')) return;
  disableActionButtons(); await postAction('/api/delete/' + id, null, 'Deleted'); clearDetail(); loadInitial();
}
var feedbackTargetId = null;
function requestChanges(id) {
  feedbackTargetId = id;
  var overlay = document.getElementById('feedbackOverlay');
  var textarea = document.getElementById('feedbackText');
  textarea.value = '';
  overlay.classList.add('show');
  setTimeout(function() { textarea.focus(); }, 100);
}
function hideFeedbackModal() {
  feedbackTargetId = null;
  document.getElementById('feedbackOverlay').classList.remove('show');
}
async function submitFeedback() {
  var feedback = document.getElementById('feedbackText').value.trim();
  if (!feedback || !feedbackTargetId) return;
  var btn = document.getElementById('feedbackSubmitBtn');
  btn.disabled = true;
  btn.textContent = 'Submitting...';
  disableActionButtons();
  await postAction('/api/reject/' + feedbackTargetId, { feedback: feedback }, 'Changes requested');
  hideFeedbackModal();
  loadInitial();
}
async function startDaemon() {
  await postAction('/api/daemon/start', null, 'Daemon started');
}
async function stopDaemon() {
  if (!confirm('Stop daemon?')) return;
  await postAction('/api/daemon/stop', null, 'Daemon stopped');
}
async function togglePause() {
  var url = daemonStatus === 'paused' ? '/api/resume' : '/api/pause';
  await postAction(url, null, daemonStatus === 'paused' ? 'Resumed' : 'Paused');
  loadInitial();
}

async function postAction(url, body, successMessage) {
  try {
    var res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (res.ok) {
      if (successMessage) showToast(successMessage, 'success');
    } else {
      var data = {};
      try { data = await res.json(); } catch(e) {}
      showToast('Error: ' + (data.error || res.statusText), 'error');
    }
  } catch (err) {
    console.error('postAction error:', err);
    showToast('Network error: ' + err.message, 'error');
  }
}

// ── Modal ──

function showModal() {
  if (daemonStatus === 'offline') { showToast('Start the daemon first', 'error'); return; }
  document.getElementById('modalOverlay').classList.add('show'); document.getElementById('taskTitle').focus();
}
function hideModal() { document.getElementById('modalOverlay').classList.remove('show'); }

async function submitTask() {
  var title = document.getElementById('taskTitle').value.trim();
  var project = document.getElementById('taskProject').value.trim();
  var body = document.getElementById('taskDesc').value.trim();
  var pipeline = document.getElementById('taskPipeline').value;
  if (!title) return;
  var btn = document.getElementById('submitBtn');
  setButtonLoading(btn, true);
  try {
    var res = await fetch('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title, body: body, project: project || undefined, pipeline: pipeline || undefined }),
    });
    var data = await res.json();
    if (!res.ok) { showToast('Error: ' + (data.error || res.statusText), 'error'); return; }
    showToast('Task submitted', 'success');
    hideModal();
    document.getElementById('taskTitle').value = '';
    document.getElementById('taskProject').value = '';
    document.getElementById('taskDesc').value = '';
    loadInitial();
  } catch (err) {
    showToast('Network error: ' + err.message, 'error');
  } finally {
    setButtonLoading(btn, false);
  }
}

// ── Gather Panel ──

function showGatherQuestions(taskId, round, questions) {
  hideGatherPanel();
  var view = document.getElementById('detailView');
  if (!view) return;
  var panel = document.createElement('div');
  panel.className = 'gather-panel';
  panel.id = 'gatherPanel';
  panel.innerHTML =
    '<h4>Gathering Requirements (Round ' + round + ')</h4>' +
    questions.map(function(q, i) {
      return '<div class="question"><label>' + esc(q) + '</label><input id="gatherAnswer' + i + '" placeholder="Your answer..."></div>';
    }).join('') +
    '<div class="gather-actions">' +
    '<button class="primary" onclick="submitGatherAnswers(\\'' + esc(taskId) + '\\',' + questions.length + ')">Submit Answers</button>' +
    '<button onclick="submitGatherDone(\\'' + esc(taskId) + '\\')">Done (skip remaining)</button>' +
    '</div>';
  view.appendChild(panel);
}
function hideGatherPanel() {
  var panel = document.getElementById('gatherPanel');
  if (panel) panel.remove();
}
function submitGatherAnswers(taskId, count) {
  var answers = [];
  for (var i = 0; i < count; i++) {
    var el = document.getElementById('gatherAnswer' + i);
    answers.push(el ? el.value : '');
  }
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ action: 'gather_answer', params: { taskId: taskId, answers: answers } }));
  }
  hideGatherPanel();
}
function submitGatherDone(taskId) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ action: 'gather_answer', params: { taskId: taskId, answers: [] } }));
  }
  hideGatherPanel();
}

// ── Project Ask Panel ──

function showProjectAskPanel(taskId) {
  hideProjectAskPanel();
  var view = document.getElementById('detailView');
  if (!view) return;
  var panel = document.createElement('div');
  panel.className = 'project-ask-panel';
  panel.id = 'projectAskPanel';
  panel.innerHTML =
    '<h4>Project Path Required</h4>' +
    '<p style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">Task <strong>' + esc(taskId) + '</strong> has no project. Enter a git repository path or use a temp directory.</p>' +
    '<input id="projectPathInput" placeholder="~/my-project (git repository path)" />' +
    '<div class="project-ask-actions">' +
    '<button class="primary" onclick="submitProjectPath(\\'' + esc(taskId) + '\\')">Set Project</button>' +
    '<button onclick="skipProjectPath(\\'' + esc(taskId) + '\\')">Use Temp Directory</button>' +
    '</div>';
  view.appendChild(panel);
}
function hideProjectAskPanel() {
  var panel = document.getElementById('projectAskPanel');
  if (panel) panel.remove();
}
function submitProjectPath(taskId) {
  var el = document.getElementById('projectPathInput');
  var projectPath = el ? el.value.trim() : '';
  if (!projectPath) return;
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ action: 'project_answer', params: { taskId: taskId, projectPath: projectPath } }));
  }
  hideProjectAskPanel();
}
function skipProjectPath(taskId) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ action: 'project_answer', params: { taskId: taskId, projectPath: '' } }));
  }
  hideProjectAskPanel();
}

function esc(s) { var d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

function clearDetail() {
  selectedTaskId = null;
  lastSelectedTaskState = null;
  var rightEl = document.querySelector('.right');
  if (rightEl) rightEl.classList.remove('has-detail');
}

// ── Panel Switching ──

function switchPanel(panel) {
  currentPanel = panel;
  var toggles = document.querySelectorAll('.tab-toggle .toggle');
  toggles.forEach(function(b) { b.classList.remove('active'); b.removeAttribute('aria-current'); });
  document.getElementById('taskList').style.display = 'none';
  document.getElementById('proposalList').style.display = 'none';
  document.getElementById('proposalToolbar').style.display = 'none';
  document.getElementById('filterBar').style.display = 'none';
  document.getElementById('adminSection').style.display = 'none';
  document.getElementById('apToolbar').style.display = 'none';
  document.getElementById('apSessionList').style.display = 'none';
  var detailView = document.getElementById('detailView');
  detailView.style.display = '';
  if (!refinementSession && !selectedTaskId && !selectedProposalId && !selectedApSessionId) {
    detailView.className = 'empty';
    detailView.innerHTML = '<div class="empty-state"><div class="empty-icon">\u2190</div><div class="empty-title">Select a task</div><div class="empty-desc">Choose a task from the list to view details</div></div>';
    clearDetail();
  }
  document.getElementById('chatView').style.display = 'none';
  document.getElementById('leftPanel').style.display = '';
  document.getElementById('taskToolbar').style.display = '';
  if (panel === 'chat') {
    toggles[0].classList.add('active');
    toggles[0].setAttribute('aria-current', 'page');
    document.getElementById('leftPanel').style.display = 'none';
    document.querySelector('.right').style.display = '';
    document.getElementById('detailView').style.display = 'none';
    document.getElementById('chatView').style.display = 'flex';
    initTerminal();
  } else if (panel === 'tasks') {
    toggles[1].classList.add('active');
    toggles[1].setAttribute('aria-current', 'page');
    document.getElementById('taskList').style.display = '';
    document.getElementById('filterBar').style.display = tasks.length > 0 ? 'flex' : 'none';
    document.getElementById('adminSection').style.display = tasks.length > 0 ? '' : 'none';
    if (!selectedTaskId && tasks.length === 0 && !refinementSession) document.querySelector('.right').style.display = 'none';
  } else if (panel === 'proposals') {
    toggles[2].classList.add('active');
    toggles[2].setAttribute('aria-current', 'page');
    document.getElementById('proposalList').style.display = '';
    document.getElementById('proposalToolbar').style.display = 'flex';
    document.getElementById('taskToolbar').style.display = 'none';
    if (!selectedProposalId) document.querySelector('.right').style.display = 'none';
    loadObserverStatus();
  } else if (panel === 'autopilot') {
    toggles[3].classList.add('active');
    toggles[3].setAttribute('aria-current', 'page');
    document.getElementById('apToolbar').style.display = 'flex';
    document.getElementById('apSessionList').style.display = '';
    document.getElementById('taskToolbar').style.display = 'none';
    if (!selectedApSessionId) document.querySelector('.right').style.display = 'none';
    loadAutopilotStatus();
  }
}

// ── Proposals ──

function renderProposals() {
  var statusOrder = { proposed: 0, approved: 1, implemented: 2, rejected: 3 };
  var sorted = proposals.slice().sort(function(a, b) {
    var so = (statusOrder[a.status] || 9) - (statusOrder[b.status] || 9);
    if (so !== 0) return so;
    return (b.priority || 0) - (a.priority || 0);
  });
  var el = document.getElementById('proposalList');
  if (!el) return;
  if (sorted.length === 0) {
    el.innerHTML = '<div class="empty-state"><div class="empty-icon">\ud83d\udca1</div><div class="empty-title">No proposals yet</div><div class="empty-desc">Run the Observer to generate improvement proposals</div></div>';
    return;
  }
  var savedScroll = el.scrollTop;
  el.innerHTML = sorted.map(function(p) {
    var status = p.status || 'proposed';
    return '<div class="proposal-item' + (p.id === selectedProposalId ? ' selected' : '') + '" onclick="selectProposal(\\'' + esc(p.id) + '\\')">' +
      '<div class="title"><span class="badge ' + esc(status) + '">' + esc(status) + '</span> ' +
      (p.category ? '<small>' + esc(p.category) + '</small> ' : '') +
      (p.risk ? '<small style="color:' + (p.risk === 'high' ? 'var(--red)' : p.risk === 'medium' ? 'var(--yellow)' : 'var(--text-muted)') + '">' + esc(p.risk) + '</small> ' : '') +
      esc(p.title) + '</div>' +
      '<div class="meta">' +
      '<span>' + esc((p.id || '').slice(0,8)) + '</span>' +
      (p.project ? '<span>' + esc(p.project.split('/').pop()) + '</span>' : '') +
      '</div>' +
      '</div>';
  }).join('');
  el.scrollTop = savedScroll;
}

async function selectProposal(id) {
  selectedProposalId = id;
  clearDetail();
  renderTasks();
  renderProposals();
  await loadProposalDetail(id);
}

async function loadProposalDetail(id) {
  var view = document.getElementById('detailView');
  view.className = '';
  view.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;flex:1"><span class="spinner spinner-lg"></span></div>';
  try {
    var data = await fetch('/api/proposal/' + id).then(function(r) { return r.json(); });
    var proposal = proposals.find(function(p) { return p.id === id; }) || data;
    var status = proposal.status || data.status || 'proposed';
    var safeId = esc(id);

    var actions = '';
    if (status === 'proposed') {
      actions = '<div class="actions">' +
        '<button class="primary" onclick="approveProposal(\\'' + safeId + '\\')">Approve</button>' +
        '<button class="danger" onclick="rejectProposal(\\'' + safeId + '\\')">Reject</button>' +
        '<button class="up" onclick="priorityProposal(\\'' + safeId + '\\', 1)">Up</button>' +
        '<button class="down" onclick="priorityProposal(\\'' + safeId + '\\', -1)">Down</button>' +
        '</div>';
    }

    var evalHtml = '';
    if (data.evaluation) {
      var ev = data.evaluation;
      var verdictClass = ev.verdict === 'positive' ? 'positive' : ev.verdict === 'negative' ? 'negative' : 'neutral';
      evalHtml = '<div class="eval-card">' +
        '<h4>Evaluation</h4>' +
        '<div class="verdict ' + verdictClass + '">' + esc(ev.verdict || 'pending') +
        (ev.score !== undefined ? ' (score: ' + ev.score + ')' : '') + '</div>' +
        (ev.deltas ? '<div class="deltas">' +
          Object.entries(ev.deltas).map(function(kv) { return '<span>' + esc(kv[0]) + ': ' + (kv[1] > 0 ? '+' : '') + kv[1] + '</span>'; }).join('') +
          '</div>' : '') +
        '</div>';
    }

    // Related tasks / implementedBy links
    var linksHtml = '';
    if (data.implementedBy) {
      linksHtml += '<div class="section"><h4>Implemented By</h4><p><a href="#" onclick="selectTask(\\'' + esc(data.implementedBy) + '\\');return false">' + esc(data.implementedBy) + '</a></p></div>';
    }
    if (data.relatedTasks && data.relatedTasks.length > 0) {
      linksHtml += '<div class="section"><h4>Related Tasks</h4><p>' +
        data.relatedTasks.map(function(tid) {
          return '<a href="#" onclick="selectTask(\\'' + esc(tid) + '\\');switchPanel(\\'tasks\\');return false">' + esc(tid.slice(0,8)) + '</a>';
        }).join(', ') + '</p></div>';
    }

    view.innerHTML =
      '<div class="proposal-detail" style="overflow-y:auto;flex:1">' +
        '<h2>' + esc(proposal.title) + '</h2>' +
        '<div class="meta">' +
          '<span class="badge ' + esc(status) + '">' + esc(status) + '</span> ' +
          safeId +
          (proposal.category ? ' | ' + esc(proposal.category) : '') +
          (proposal.risk ? ' | risk: ' + esc(proposal.risk) : '') +
          (proposal.project ? ' | ' + esc(proposal.project) : '') +
          (proposal.created ? ' | ' + esc(proposal.created) : '') +
        '</div>' +
        actions +
        '<div class="section"><h4>Problem</h4><p>' + esc(proposal.problem || '(none)') + '</p></div>' +
        '<div class="section"><h4>Proposed Change</h4><p>' + esc(proposal.change || '(none)') + '</p></div>' +
        '<div class="section"><h4>Expected Impact</h4><p>' + esc(proposal.expectedImpact || '(none)') + '</p></div>' +
        linksHtml +
        evalHtml +
      '</div>';
  } catch (err) {
    console.error('loadProposalDetail error:', err);
    view.className = 'empty';
    view.innerHTML = 'Error loading proposal';
  }
}

function disableProposalButtons() {
  document.querySelectorAll('.proposal-detail .actions button').forEach(function(b) { b.disabled = true; });
}
async function approveProposal(id) {
  disableProposalButtons();
  await postAction('/api/proposal/approve/' + id, null, 'Proposal approved');
  var idx = proposals.findIndex(function(p) { return p.id === id; });
  if (idx >= 0) proposals[idx].status = 'approved';
  renderProposals();
  loadProposalDetail(id);
}

async function rejectProposal(id) {
  disableProposalButtons();
  await postAction('/api/proposal/reject/' + id, null, 'Proposal rejected');
  var idx = proposals.findIndex(function(p) { return p.id === id; });
  if (idx >= 0) proposals[idx].status = 'rejected';
  renderProposals();
  loadProposalDetail(id);
}

async function priorityProposal(id, delta) {
  await postAction('/api/proposal/priority/' + id, { delta: delta }, 'Priority ' + (delta > 0 ? 'increased' : 'decreased'));
  var idx = proposals.findIndex(function(p) { return p.id === id; });
  if (idx >= 0) proposals[idx].priority = (proposals[idx].priority || 0) + delta;
  renderProposals();
}

// ── Observer ──

async function runObserver() {
  if (daemonStatus === 'offline') { showToast('Start the engine first', 'error'); return; }
  await postAction('/api/observe', null, 'Observer started');
}

async function loadObserverStatus() {
  try {
    var data = await fetch('/api/observe/status').then(function(r) { return r.ok ? r.json() : {}; });
    var el = document.getElementById('observerStatus');
    if (el && data.lastRun) {
      el.textContent = 'Last run: ' + data.lastRun;
    } else if (el) {
      el.textContent = 'Observer: never run';
    }
  } catch (e) {
    // ignore
  }
}

// ── Analyze / Research ──

function showAnalyzeForm() { showProjectActionForm('analyze'); }
function showResearchForm() { showProjectActionForm('research'); }

var pendingActionType = '';
function showProjectActionForm(actionType) {
  if (daemonStatus === 'offline') { showToast('Start the engine first', 'error'); return; }
  pendingActionType = actionType;
  var label = actionType === 'analyze' ? 'Analyze Project' : 'Research Project';
  var view = document.getElementById('detailView');
  view.className = '';
  document.querySelector('.right').style.display = '';
  view.innerHTML =
    '<div class="ap-start-form">' +
      '<h3 style="color:var(--text-bright);margin-bottom:16px">' + esc(label) + '</h3>' +
      '<label>Project Path</label>' +
      '<div class="project-row"><input id="analysisProjectPath" placeholder="~/my-project"><button type="button" onclick="openAnalysisBrowser()">Browse</button></div>' +
      '<div class="dir-browser" id="analysisDirBrowser" style="display:none;position:relative">' +
        '<div class="dir-header"><button type="button" onclick="analysisBrowseUp()">\u2191</button><span id="analysisDirCurrent"></span><button type="button" onclick="closeAnalysisBrowser()">\u00d7</button></div>' +
        '<div class="dir-list" id="analysisDirList" style="max-height:200px;overflow-y:auto"></div>' +
        '<div class="dir-actions"><button type="button" onclick="createNewFolder(analysisBrowserPath, analysisBrowseDir)" style="margin-right:auto">New Folder</button><button type="button" class="primary" onclick="selectAnalysisDir()">Select this folder</button></div>' +
      '</div>' +
      '<div class="form-actions">' +
        '<button onclick="cancelAnalysisForm()">Cancel</button>' +
        '<button class="primary" id="analysisSubmitBtn" onclick="runProjectAction(pendingActionType)">' + esc(label) + '</button>' +
      '</div>' +
    '</div>';
}

var analysisBrowserPath = '';
function openAnalysisBrowser() {
  var input = document.getElementById('analysisProjectPath').value.trim();
  fetch('/api/browse?path=' + encodeURIComponent(input || ''))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.error) { showToast(data.error, 'error'); return; }
      analysisBrowserPath = data.current;
      document.getElementById('analysisDirCurrent').textContent = data.current;
      var list = document.getElementById('analysisDirList');
      list.innerHTML = data.directories.map(function(d) {
        return '<div class="dir-item" onclick="analysisBrowseDir(' + escapeHtml(JSON.stringify(d.path)) + ')">' +
          '<span class="icon">\ud83d\udcc1</span>' + escapeHtml(d.name) + '</div>';
      }).join('') || '<div style="padding:12px;color:var(--text-muted);font-size:13px">No subdirectories</div>';
      document.getElementById('analysisDirBrowser').style.display = 'flex';
    });
}
function analysisBrowseDir(dirPath) {
  fetch('/api/browse?path=' + encodeURIComponent(dirPath))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.error) return;
      analysisBrowserPath = data.current;
      document.getElementById('analysisDirCurrent').textContent = data.current;
      var list = document.getElementById('analysisDirList');
      list.innerHTML = data.directories.map(function(d) {
        return '<div class="dir-item" onclick="analysisBrowseDir(' + escapeHtml(JSON.stringify(d.path)) + ')">' +
          '<span class="icon">\ud83d\udcc1</span>' + escapeHtml(d.name) + '</div>';
      }).join('') || '<div style="padding:12px;color:var(--text-muted);font-size:13px">No subdirectories</div>';
    });
}
function analysisBrowseUp() {
  fetch('/api/browse?path=' + encodeURIComponent(analysisBrowserPath))
    .then(function(r) { return r.json(); })
    .then(function(data) { if (data.parent && data.parent !== data.current) analysisBrowseDir(data.parent); });
}
function selectAnalysisDir() { document.getElementById('analysisProjectPath').value = analysisBrowserPath; closeAnalysisBrowser(); }
function closeAnalysisBrowser() { document.getElementById('analysisDirBrowser').style.display = 'none'; }
function cancelAnalysisForm() {
  var view = document.getElementById('detailView');
  view.className = 'empty';
  view.innerHTML = '<div class="empty-state"><div class="empty-icon">\u2190</div><div class="empty-title">Select a proposal</div><div class="empty-desc">Choose a proposal from the list to view details</div></div>';
  document.querySelector('.right').style.display = 'none';
}

async function runProjectAction(actionType) {
  var project = document.getElementById('analysisProjectPath').value.trim();
  if (!project) { showToast('Project path is required', 'error'); return; }
  var btn = document.getElementById('analysisSubmitBtn');
  var label = actionType === 'analyze' ? 'Analyzing' : 'Researching';
  setButtonLoading(btn, true);
  btn.textContent = label + '...';
  try {
    var res = await fetch('/api/' + actionType, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: project }),
    });
    var data = await res.json();
    if (res.ok) {
      showToast((actionType === 'analyze' ? 'Analysis' : 'Research') + ' complete: ' + (data.proposalCount || 0) + ' proposals', 'success');
      fetch('/api/proposals').then(function(r) { return r.json(); }).then(function(list) { proposals = list; renderProposals(); }).catch(function() {});
      cancelAnalysisForm();
    } else {
      showToast('Error: ' + (data.error || 'unknown'), 'error');
    }
  } catch (err) {
    showToast('Network error: ' + err.message, 'error');
  } finally {
    setButtonLoading(btn, false);
    if (btn) btn.textContent = actionType === 'analyze' ? 'Analyze Project' : 'Research Project';
  }
}

// ── Cleanup ──

async function cleanupTasks() {
  var days = parseInt(document.getElementById('cleanupDays').value) || 30;
  if (!confirm('Delete tasks older than ' + days + ' days?')) return;
  await postAction('/api/cleanup', { days: days }, 'Cleanup complete');
  loadInitial();
}

// ── Refinement ──

async function startRefinement(mode) {
  var titleEl = document.getElementById('taskTitle');
  var title = titleEl.value.trim();
  var project = document.getElementById('taskProject').value.trim();
  var description = document.getElementById('taskDesc').value.trim();
  var pipeline = document.getElementById('taskPipeline').value;
  if (!title) {
    titleEl.style.borderColor = 'var(--red)';
    titleEl.focus();
    setTimeout(function() { titleEl.style.borderColor = ''; }, 2000);
    return;
  }

  try {
    var res = await fetch('/api/refinement/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title, description: description, project: project || undefined, pipeline: pipeline || undefined, mode: mode }),
    });
    var data = await res.json();
    if (data.error) throw new Error(data.error);

    refinementSession = {
      sessionId: data.sessionId,
      mode: mode,
      decisions: [],
      coverage: {},
      complete: false,
      title: title,
      statusText: '',
    };
    currentRefinementQuestion = null;
    hideModal();

    if (currentPanel !== 'tasks') switchPanel('tasks');
    document.querySelector('.right').style.display = '';
    clearDetail();
    renderTasks();
    renderRefinementPanel();
  } catch (err) {
    console.error('startRefinement error:', err);
    showToast('Refinement failed: ' + err.message, 'error');
  }
}

function renderRefinementPanel() {
  var view = document.getElementById('detailView');
  if (!view || !refinementSession) return;
  view.className = '';

  var html = '<div class="refinement-panel">';
  html += '<h3>Refining: ' + esc(refinementSession.title) + '</h3>';
  var isWorking = !refinementSession.complete && (refinementSession.mode === 'autopilot' || (refinementSession.mode === 'interactive' && !currentRefinementQuestion));
  var statusLabel = refinementSession.statusText || (refinementSession.mode === 'autopilot' ? 'Auto-pilot starting...' : refinementSession.mode === 'interactive' ? 'Generating question...' : refinementSession.mode);
  if (isWorking) {
    html += '<div class="ref-autopilot-status" id="refStatus"><span class="ref-spinner"></span> ' + esc(statusLabel) + '</div>';
  } else {
    html += '<div class="ref-status" id="refStatus">' + esc(statusLabel) + '</div>';
  }

  // coverage bars
  var coverage = refinementSession.coverage || {};
  if (Object.keys(coverage).length > 0) {
    html += '<div class="coverage-bar">';
    for (var area in coverage) {
      if (!coverage.hasOwnProperty(area)) continue;
      var value = coverage[area];
      var pct = Math.round(value * 100);
      var full = value >= 1.0 ? ' full' : '';
      html += '<div class="area"><span style="width:80px;flex-shrink:0">' + esc(area) + '</span>' +
        '<div class="bar-track"><div class="bar-fill' + full + '" style="width:' + pct + '%"></div></div>' +
        '<span style="width:35px;text-align:right">' + pct + '%</span></div>';
    }
    html += '</div>';
  }

  // complete state
  if (refinementSession.complete) {
    html += '<div class="ref-complete"><h4>All areas covered</h4>';
    if (refinementSession.pipeline) {
      html += '<div style="color:var(--text-muted);font-size:12px;margin-bottom:8px">Pipeline: <strong style="color:var(--accent)">' + esc(refinementSession.pipeline) + '</strong> (LLM recommended)</div>';
    }
    html += '<div class="ref-actions">' +
      '<button class="primary" onclick="finalizeRefinementNow()">Create Task</button>' +
      '<button class="danger" onclick="cancelRefinementNow()">Cancel</button>' +
      '</div></div>';
  } else if (refinementSession.mode === 'interactive' && currentRefinementQuestion) {
    // question card
    var q = currentRefinementQuestion;
    html += '<div class="ref-question">';
    html += '<div class="q-text">' + esc(q.question) + '</div>';
    if (q.options && q.options.length > 0) {
      q.options.forEach(function(opt, i) {
        html += '<button class="ref-option" onclick="selectRefinementOption(' + i + ')">' +
          esc(opt.label) + '<span class="opt-reason">' + esc(opt.reason || '') + '</span></button>';
      });
    }
    html += '<input class="ref-custom" id="refCustomAnswer" placeholder="Or type your answer...">';
    html += '</div>';
    html += '<div class="ref-actions">' +
      '<button class="primary" onclick="submitRefinementAnswer()">Answer</button>' +
      '<button class="refine" onclick="switchRefinementToAutopilot()">Auto-complete rest</button>' +
      '<button onclick="finalizeRefinementNow()">Finalize now</button>' +
      '<button class="danger" onclick="cancelRefinementNow()">Cancel</button>' +
      '</div>';
  } else if (refinementSession.mode === 'autopilot' && !refinementSession.complete) {
    if (refinementSession.decisions.length > 0) {
      html += '<div style="color:var(--text-muted);font-size:12px;margin-top:4px">' + refinementSession.decisions.length + ' decisions so far</div>';
    }
    html += '<div class="ref-actions">' +
      '<button onclick="finalizeRefinementNow()">Finalize now</button>' +
      '<button class="danger" onclick="cancelRefinementNow()">Cancel</button>' +
      '</div>';
  } else if (refinementSession.mode === 'interactive' && !currentRefinementQuestion) {
    html += '<div class="ref-actions">' +
      '<button class="danger" onclick="cancelRefinementNow()">Cancel</button>' +
      '</div>';
  }

  // decisions history
  if (refinementSession.decisions.length > 0) {
    html += '<div class="decisions-list"><h4 style="color:var(--text-muted);font-size:12px;margin-bottom:6px">Decisions (' + refinementSession.decisions.length + ')</h4>';
    refinementSession.decisions.forEach(function(d) {
      html += '<div class="decision-item">' +
        '<span class="d-area">[' + esc(d.area) + ']</span> ' +
        '<span class="d-q">' + esc(d.question) + '</span> \u2192 ' +
        '<span class="d-a">' + esc(d.answer) + '</span>' +
        '</div>';
    });
    html += '</div>';
  }

  html += '</div>';
  view.innerHTML = html;
}

function selectRefinementOption(index) {
  if (!currentRefinementQuestion || !currentRefinementQuestion.options) return;
  var opt = currentRefinementQuestion.options[index];
  if (opt) {
    var input = document.getElementById('refCustomAnswer');
    if (input) input.value = opt.label;
  }
}

function submitRefinementAnswer() {
  if (!refinementSession || !currentRefinementQuestion) return;
  var input = document.getElementById('refCustomAnswer');
  var value = input ? input.value.trim() : '';
  if (!value) return;

  var answer = {
    value: value,
    reason: '',
    questionText: currentRefinementQuestion.question,
    area: currentRefinementQuestion.area,
  };

  refinementSession.decisions.push({
    area: currentRefinementQuestion.area,
    question: currentRefinementQuestion.question,
    answer: value,
    reason: '',
  });

  currentRefinementQuestion = null;

  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ action: 'refinement_answer', params: { sessionId: refinementSession.sessionId, answer: answer } }));
  }
  renderRefinementPanel();
}

function switchRefinementToAutopilot() {
  if (!refinementSession) return;
  refinementSession.mode = 'autopilot';
  currentRefinementQuestion = null;
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ action: 'refinement_autopilot', params: { sessionId: refinementSession.sessionId } }));
  }
  renderRefinementPanel();
}

async function finalizeRefinementNow() {
  if (!refinementSession) return;
  try {
    var res = await fetch('/api/refinement/finalize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: refinementSession.sessionId }),
    });
    var data = await res.json();
    refinementSession = null;
    currentRefinementQuestion = null;
    loadInitial();
    if (data.taskId) selectTask(data.taskId);
  } catch (err) {
    console.error('finalizeRefinement error:', err);
    showToast('Finalize failed: ' + err.message, 'error');
  }
}

async function cancelRefinementNow() {
  if (!refinementSession) return;
  try {
    await fetch('/api/refinement/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: refinementSession.sessionId }),
    });
  } catch (err) { console.error('cancelRefinement error:', err); }
  refinementSession = null;
  currentRefinementQuestion = null;
  var view = document.getElementById('detailView');
  view.className = 'empty';
  view.innerHTML = '<div class="empty-state"><div class="empty-icon">\u2190</div><div class="empty-title">Select a task</div><div class="empty-desc">Choose a task from the list to view details</div></div>';
}

// ── Terminal (xterm.js + PTY) ──

var term = null;
var fitAddon = null;
var terminalInitialized = false;
var resizeTimer = null;

function initTerminal() {
  if (daemonStatus === 'offline') {
    var ph = document.getElementById('terminalPlaceholder');
    if (ph) { ph.style.display = ''; ph.querySelector('.empty-desc').textContent = 'Start the engine to use the terminal'; }
    var tb = document.querySelector('.terminal-toolbar');
    if (tb) tb.style.display = 'none';
    return;
  }
  var tb2 = document.querySelector('.terminal-toolbar');
  if (tb2) tb2.style.display = '';
  if (terminalInitialized) {
    if (fitAddon) fitAddon.fit();
    return;
  }
  terminalInitialized = true;

  term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
    theme: {
      background: '#0d1117',
      foreground: '#c9d1d9',
      cursor: '#58a6ff',
      selectionBackground: '#264f78',
      black: '#0d1117', red: '#f85149', green: '#3fb950', yellow: '#d29922',
      blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#c9d1d9',
      brightBlack: '#484f58', brightRed: '#f85149', brightGreen: '#3fb950', brightYellow: '#d29922',
      brightBlue: '#58a6ff', brightMagenta: '#bc8cff', brightCyan: '#39c5cf', brightWhite: '#f0f6fc',
    },
    allowProposedApi: true,
  });

  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon.WebLinksAddon());

  var placeholder = document.getElementById('terminalPlaceholder');
  if (placeholder) placeholder.style.display = 'none';
  var container = document.getElementById('terminal');
  term.open(container);

  requestAnimationFrame(function() {
    fitAddon.fit();
    spawnPty();
  });

  term.onData(function(data) {
    if (ws && ws.readyState === 1) {
      ws.send(new TextEncoder().encode(data));
    }
  });

  term.onResize(function(size) {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function() {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ action: 'pty:resize', params: { cols: size.cols, rows: size.rows } }));
      }
    }, 100);
  });

  window.addEventListener('resize', function() {
    if (fitAddon && document.getElementById('chatView').style.display !== 'none') {
      fitAddon.fit();
    }
  });
}

function spawnPty(opts) {
  opts = opts || {};
  if (!ws || ws.readyState !== 1) return;
  var dims = term ? { cols: term.cols, rows: term.rows } : {};
  ws.send(JSON.stringify({ action: 'pty:spawn', params: Object.assign({}, dims, opts) }));
  setTerminalStatus('connecting...');
}

function setTerminalStatus(text) {
  var el = document.getElementById('terminalStatus');
  if (el) el.textContent = text;
}

function terminalNew() {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ action: 'pty:kill' }));
  }
  if (term) term.clear();
  setTimeout(function() { spawnPty({ newSession: true }); }, 300);
}

function handlePtyMessage(event, data) {
  if (event === 'pty:spawned') {
    setTerminalStatus('connected');
    if (term) term.focus();
  } else if (event === 'pty:exit') {
    setTerminalStatus('exited (code: ' + (data.exitCode != null ? data.exitCode : '?') + ')');
    if (term) {
      term.writeln('');
      term.writeln('\\x1b[90m--- session ended ---\\x1b[0m');
      term.writeln('\\x1b[90mClick "New Session" to start a new session.\\x1b[0m');
    }
  } else if (event === 'pty:error') {
    setTerminalStatus('connection failed');
    if (term) {
      term.writeln('\\x1b[31mError: ' + (data.message || 'unknown') + '\\x1b[0m');
      term.writeln('\\x1b[90mClick "New Session" to retry.\\x1b[0m');
    }
  }
}

// ── Keyboard Shortcuts ──

function showKbd() { document.getElementById('kbdOverlay').classList.add('show'); }
function hideKbd() { document.getElementById('kbdOverlay').classList.remove('show'); }

document.addEventListener('keydown', function(e) {
  // Don't handle shortcuts when typing in input/textarea/select
  var tag = e.target.tagName;
  var isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable;
  // Terminal is also considered an input context
  var isTerminal = currentPanel === 'chat' && terminalInitialized;

  // Escape always works
  if (e.key === 'Escape') {
    if (document.getElementById('kbdOverlay').classList.contains('show')) { hideKbd(); return; }
    if (document.getElementById('feedbackOverlay').classList.contains('show')) { hideFeedbackModal(); return; }
    if (document.getElementById('modalOverlay').classList.contains('show')) { hideModal(); return; }
    return;
  }

  // Don't intercept shortcuts when user is typing or in terminal
  if (isInput || isTerminal) return;

  if (e.key === '1') { switchPanel('chat'); e.preventDefault(); }
  else if (e.key === '2') { switchPanel('tasks'); e.preventDefault(); }
  else if (e.key === '3') { switchPanel('proposals'); e.preventDefault(); }
  else if (e.key === '4') { switchPanel('autopilot'); e.preventDefault(); }
  else if (e.key === 'n') { switchPanel('tasks'); showModal(); e.preventDefault(); }
  else if (e.key === '?') { showKbd(); e.preventDefault(); }
  else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    if (currentPanel === 'tasks') {
      navigateTaskList(e.key === 'ArrowUp' ? -1 : 1);
      e.preventDefault();
    }
  } else if (e.key === 'Enter') {
    if (currentPanel === 'tasks' && selectedTaskId) {
      loadDetail(selectedTaskId);
      e.preventDefault();
    }
  }
});

function navigateTaskList(direction) {
  var items = document.querySelectorAll('.task-item');
  if (items.length === 0) return;
  var currentIndex = -1;
  items.forEach(function(item, i) {
    if (item.dataset.id === selectedTaskId) currentIndex = i;
  });
  var nextIndex = currentIndex + direction;
  if (nextIndex < 0) nextIndex = 0;
  if (nextIndex >= items.length) nextIndex = items.length - 1;
  var nextItem = items[nextIndex];
  if (nextItem && nextItem.dataset.id) {
    selectTask(nextItem.dataset.id);
  }
}

// ── Autopilot ──

async function loadAutopilotStatus() {
  try {
    var data = await fetch('/api/autopilot/status').then(function(r) { return r.ok ? r.json() : []; });
    autopilotSessions = Array.isArray(data) ? data : [];
    renderApSessions();
    updateApBadge();
  } catch (err) {
    console.error('loadAutopilotStatus error:', err);
  }
}

function updateApBadge() {
  var badge = document.getElementById('apBadge');
  if (!badge) return;
  var active = autopilotSessions.filter(function(s) { return s.status !== 'stopped'; });
  if (active.length > 0) {
    badge.style.display = '';
    badge.textContent = active.length > 1 ? 'AUTOPILOT (' + active.length + ')' : 'AUTOPILOT';
  } else {
    badge.style.display = 'none';
  }
}

function updateApPageTitle() {
  updatePageTitle();
}

function renderApSessions() {
  var el = document.getElementById('apSessionList');
  if (!el) return;
  if (autopilotSessions.length === 0) {
    el.innerHTML = '<div class="empty-state"><div class="empty-icon">\ud83e\udd16</div><div class="empty-title">No autopilot sessions</div><div class="empty-desc">Click "+ New Autopilot" to start one</div></div>';
    return;
  }
  el.innerHTML = autopilotSessions.map(function(s) {
    var pct = s.stats && s.stats.totalItems > 0 ? Math.round((s.stats.completedItems + s.stats.failedItems + s.stats.skippedItems) / s.stats.totalItems * 100) : 0;
    return '<div class="ap-session-card' + (s.id === selectedApSessionId ? ' selected' : '') + '" onclick="selectApSession(\\'' + esc(s.id) + '\\')">' +
      '<div class="ap-name"><span class="badge ' + esc(s.status) + '">' + esc(s.status) + '</span> ' + esc(s.projectName) + '</div>' +
      '<div class="ap-meta"><span>iter ' + (s.iteration || 0) + '</span><span>' + (s.stats ? s.stats.completedItems : 0) + '/' + (s.stats ? s.stats.totalItems : 0) + ' items</span><span>' + (s.releasesCount || 0) + ' releases</span>' + (s.pendingDirectives ? '<span style="color:var(--yellow)">' + s.pendingDirectives + ' directives</span>' : '') + '<span>' + timeAgo(s.startedAt) + '</span></div>' +
      '<div class="ap-progress"><div class="ap-progress-fill" style="width:' + pct + '%"></div></div>' +
      '</div>';
  }).join('');
}

async function selectApSession(id) {
  selectedApSessionId = id;
  renderApSessions();
  await loadApSessionDetail(id);
}

async function loadApSessionDetail(id) {
  var view = document.getElementById('detailView');
  view.className = '';
  view.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;flex:1"><span class="spinner spinner-lg"></span></div>';
  try {
    var s = await fetch('/api/autopilot/session/' + id).then(function(r) { return r.ok ? r.json() : null; });
    if (!s) { selectedApSessionId = null; view.innerHTML = '<div class="empty-state"><div class="empty-icon">\u26a0\ufe0f</div><div class="empty-title">Session not found</div></div>'; return; }

    var actions = '';
    if (s.status === 'awaiting_review') {
      actions = '<button class="primary" onclick="apApproveItem(\\'' + esc(s.id) + '\\')">Approve</button>' +
        '<button class="danger" onclick="apRejectItem(\\'' + esc(s.id) + '\\')">Reject</button>' +
        '<button onclick="apFeedbackItem(\\'' + esc(s.id) + '\\')">Feedback</button>' +
        '<button class="danger" onclick="apStop(\\'' + esc(s.id) + '\\')">Stop</button>';
    } else if (s.status === 'paused') {
      actions = '<button class="primary" onclick="apResume(\\'' + esc(s.id) + '\\')">Resume</button>' +
        '<button class="danger" onclick="apStop(\\'' + esc(s.id) + '\\')">Stop</button>';
    } else if (s.status !== 'stopped') {
      actions = '<button class="warning" onclick="apPause(\\'' + esc(s.id) + '\\')">Pause</button>' +
        '<button class="danger" onclick="apStop(\\'' + esc(s.id) + '\\')">Stop</button>';
    }

    var roadmapHtml = '';
    if (s.roadmap && s.roadmap.length > 0) {
      roadmapHtml = s.roadmap.map(function(item, i) {
        var icon = item.status === 'done' ? '\u2713' : item.status === 'running' ? '\u25cf' : item.status === 'failed' ? '\u2717' : item.status === 'skipped' ? '\u2212' : '\u25cb';
        var statusColor = item.status === 'done' ? 'var(--green)' : item.status === 'running' ? 'var(--accent)' : item.status === 'failed' ? 'var(--red)' : 'var(--text-muted)';
        return '<div class="ap-roadmap-item"><span style="color:' + statusColor + '">' + icon + '</span><span class="ap-type ' + esc(item.type) + '">' + esc(item.type) + '</span><span>' + esc(item.title) + '</span>' +
          (item.taskId ? '<small style="color:var(--text-muted)">' + esc(item.taskId.slice(0,8)) + '</small>' : '') +
          '</div>';
      }).join('');
    } else {
      roadmapHtml = '<div style="color:var(--text-muted);font-size:12px;padding:8px">(no roadmap yet)</div>';
    }

    var releasesHtml = '';
    if (s.releases && s.releases.length > 0) {
      releasesHtml = s.releases.map(function(r) {
        return '<div class="ap-release-item"><span class="version">' + esc(r.version) + '</span> <span class="timestamp">' + timeAgo(r.timestamp) + '</span>' +
          '<div style="font-size:11px;color:var(--text-muted);margin-top:2px">' + esc((r.changelog || '').split('\\n').slice(0, 3).join(', ')) + '</div></div>';
      }).join('');
    } else {
      releasesHtml = '<div style="color:var(--text-muted);font-size:12px;padding:8px">(no releases yet)</div>';
    }

    var logHtml = '';
    if (s.log && s.log.length > 0) {
      logHtml = s.log.slice(-50).map(function(entry) {
        var cls = entry.type === 'error' ? ' error' : entry.type === 'warn' ? ' warn' : '';
        var ts = entry.timestamp ? entry.timestamp.split('T')[1].split('.')[0] : '';
        return '<div class="ap-log-entry' + cls + '"><span class="ts">' + esc(ts) + '</span> ' + esc(entry.message) + '</div>';
      }).join('');
    } else {
      logHtml = '<div style="color:var(--text-muted);font-size:12px">(no log entries)</div>';
    }

    // Branch & test info section (all git-enabled sessions)
    var branchInfoHtml = '';
    if (s.gitAvailable) {
      branchInfoHtml = '<div class="ap-section"><h4>Build Status</h4>' +
        '<div class="meta-grid">' +
          (s.stableTag ? '<span class="label">Stable Tag</span><span class="value">' + esc(s.stableTag) + '</span>' : '') +
          (s.currentBranch ? '<span class="label">Branch</span><span class="value" style="color:var(--accent)">' + esc(s.currentBranch) + '</span>' : '') +
          (s.currentItemIteration ? '<span class="label">Item Iteration</span><span class="value">' + s.currentItemIteration + '</span>' : '') +
          '<span class="label">Git</span><span class="value" style="color:var(--green)">enabled</span>' +
          '<span class="label">Tests</span><span class="value" style="color:' + (s.hasTests ? 'var(--green)' : 'var(--text-muted)') + '">' + (s.hasTests ? 'enabled' : 'none') + '</span>' +
        '</div>';

      // Test results
      if (s.currentTestResults && s.currentTestResults.length > 0) {
        branchInfoHtml += '<div style="margin-top:8px">';
        s.currentTestResults.forEach(function(r) {
          var icon = r.passed ? '\\u2705' : '\\u274C';
          branchInfoHtml += '<div style="font-size:12px;margin:2px 0">' + icon + ' ' + esc(r.name) + ' (' + (r.passing || 0) + '/' + (r.total || 0) + ')</div>';
        });
        branchInfoHtml += '</div>';
      }

      // Iteration log
      if (s.currentItemLog && s.currentItemLog.length > 0) {
        branchInfoHtml += '<div style="margin-top:8px;font-size:11px;color:var(--text-muted)">';
        s.currentItemLog.forEach(function(il) {
          var results = (il.results || []).map(function(r) {
            return r.name + (r.passed ? ' \\u2705' : ' \\u274C');
          }).join(' ');
          branchInfoHtml += '<div>#' + il.iteration + ': ' + results + '</div>';
        });
        branchInfoHtml += '</div>';
      }

      // Feedback input
      if (s.status !== 'stopped' && s.status !== 'completed') {
        branchInfoHtml += '<div style="margin-top:8px"><input id="apFeedbackInput" placeholder="Type feedback..." style="width:100%;padding:6px 10px;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:6px;font-size:12px" onkeydown="if(event.key===\\'Enter\\')apFeedbackItem(\\'' + esc(s.id) + '\\')"></div>';
      }

      branchInfoHtml += '</div>';
    }

    var pct = s.stats && s.stats.totalItems > 0 ? Math.round((s.stats.completedItems + s.stats.failedItems + s.stats.skippedItems) / s.stats.totalItems * 100) : 0;
    view.innerHTML =
      '<div class="ap-detail">' +
        '<h2>\\ud83e\\udd16 ' + esc(s.projectName) + ' <span class="badge ' + esc(s.status) + '">' + esc(s.status) + '</span></h2>' +
        '<div class="meta-grid" style="margin-bottom:12px">' +
          '<span class="label">Project</span><span class="value">' + esc(s.project) + '</span>' +
          '<span class="label">Pipeline</span><span class="value">' + esc(s.pipeline) + '</span>' +
          '<span class="label">Iteration</span><span class="value">' + (s.iteration || 0) + '</span>' +
          '<span class="label">Progress</span><span class="value">' + (s.stats ? s.stats.completedItems : 0) + ' done, ' + (s.stats ? s.stats.failedItems : 0) + ' failed / ' + (s.stats ? s.stats.totalItems : 0) + ' items (' + pct + '%)</span>' +
          '<span class="label">Total Processed</span><span class="value">' + (s.totalItemsProcessed || 0) + ' / ' + (s.maxItems || 50) + '</span>' +
          '<span class="label">Releases</span><span class="value">' + (s.releases ? s.releases.length : 0) + '</span>' +
          '<span class="label">Started</span><span class="value">' + timeAgo(s.startedAt) + '</span>' +
          (s.pausedPhase ? '<span class="label">Paused Phase</span><span class="value" style="color:var(--yellow)">' + esc(s.pausedPhase) + '</span>' : '') +
        '</div>' +
        '<div class="ap-progress" style="margin-bottom:12px;height:6px"><div class="ap-progress-fill" style="width:' + pct + '%"></div></div>' +
        (actions ? '<div class="ap-actions">' + actions + '</div>' : '') +
        buildDirectivesHtml(s) +
        branchInfoHtml +
        '<div class="ap-section"><h4>Roadmap (Iteration ' + (s.iteration || 0) + ')</h4>' + roadmapHtml + '</div>' +
        '<div class="ap-section"><h4>Releases</h4>' + releasesHtml + '</div>' +
        '<div class="ap-section"><h4>Activity Log</h4><div style="max-height:200px;overflow-y:auto;background:var(--bg);border-radius:6px;padding:8px">' + logHtml + '</div></div>' +
      '</div>';
  } catch (err) {
    console.error('loadApSessionDetail error:', err);
    view.innerHTML = '<div class="empty-state">Error loading session</div>';
  }
}

function showApStartForm() {
  if (daemonStatus === 'offline') { showToast('Start the engine first', 'error'); return; }
  var view = document.getElementById('detailView');
  view.className = '';
  view.innerHTML =
    '<div class="ap-start-form">' +
      '<h3 style="color:var(--text-bright);margin-bottom:16px">\ud83e\udd16 Start Autopilot</h3>' +
      '<label>Project Path</label>' +
      '<div class="project-row"><input id="apProjectPath" placeholder="~/my-project"><button type="button" onclick="openApBrowser()">Browse</button></div>' +
      '<div class="dir-browser" id="apDirBrowser" style="display:none;position:relative">' +
        '<div class="dir-header"><button type="button" onclick="apBrowseUp()">\u2191</button><span id="apDirCurrent"></span><button type="button" onclick="closeApBrowser()">\u00d7</button></div>' +
        '<div class="dir-list" id="apDirList" style="max-height:200px;overflow-y:auto"></div>' +
        '<div class="dir-actions"><button type="button" onclick="createNewFolder(apBrowserPath, apBrowseDir)" style="margin-right:auto">New Folder</button><button type="button" class="primary" onclick="selectApCurrentDir()">Select this folder</button></div>' +
      '</div>' +
      '<label>Pipeline</label>' +
      '<select id="apPipeline">' + (stats.pipelines || ['implement']).map(function(p) { return '<option value="' + esc(p) + '">' + esc(p) + '</option>'; }).join('') + '</select>' +
      '<label>Max Items</label>' +
      '<input id="apMaxItems" type="number" value="50" min="5" max="200">' +
      '<div class="form-actions">' +
        '<button onclick="cancelApStart()">Cancel</button>' +
        '<button class="primary" onclick="startAutopilot()">Start Autopilot</button>' +
      '</div>' +
    '</div>';
}

var apBrowserPath = '';
function openApBrowser() {
  var input = document.getElementById('apProjectPath').value.trim();
  fetch('/api/browse?path=' + encodeURIComponent(input || ''))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.error) { showToast(data.error, 'error'); return; }
      apBrowserPath = data.current;
      document.getElementById('apDirCurrent').textContent = data.current;
      var list = document.getElementById('apDirList');
      list.innerHTML = data.directories.map(function(d) {
        return '<div class="dir-item" onclick="apBrowseDir(' + escapeHtml(JSON.stringify(d.path)) + ')">' +
          '<span class="icon">\ud83d\udcc1</span>' + escapeHtml(d.name) + '</div>';
      }).join('') || '<div style="padding:12px;color:var(--text-muted);font-size:13px">No subdirectories</div>';
      document.getElementById('apDirBrowser').style.display = 'flex';
    });
}
function apBrowseDir(dirPath) {
  fetch('/api/browse?path=' + encodeURIComponent(dirPath))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.error) return;
      apBrowserPath = data.current;
      document.getElementById('apDirCurrent').textContent = data.current;
      var list = document.getElementById('apDirList');
      list.innerHTML = data.directories.map(function(d) {
        return '<div class="dir-item" onclick="apBrowseDir(' + escapeHtml(JSON.stringify(d.path)) + ')">' +
          '<span class="icon">\ud83d\udcc1</span>' + escapeHtml(d.name) + '</div>';
      }).join('') || '<div style="padding:12px;color:var(--text-muted);font-size:13px">No subdirectories</div>';
    });
}
function apBrowseUp() {
  fetch('/api/browse?path=' + encodeURIComponent(apBrowserPath))
    .then(function(r) { return r.json(); })
    .then(function(data) { if (data.parent && data.parent !== data.current) apBrowseDir(data.parent); });
}
function selectApCurrentDir() { document.getElementById('apProjectPath').value = apBrowserPath; closeApBrowser(); }
function closeApBrowser() { document.getElementById('apDirBrowser').style.display = 'none'; }
function cancelApStart() {
  var view = document.getElementById('detailView');
  view.className = 'empty';
  view.innerHTML = '<div class="empty-state"><div class="empty-icon">\ud83e\udd16</div><div class="empty-title">Select a session</div><div class="empty-desc">Choose a session or start a new autopilot</div></div>';
}

async function startAutopilot() {
  var project = document.getElementById('apProjectPath').value.trim();
  if (!project) { showToast('Project path is required', 'error'); return; }
  var pipeline = document.getElementById('apPipeline').value;
  var maxItems = parseInt(document.getElementById('apMaxItems').value) || 50;
  try {
    var res = await fetch('/api/autopilot/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: project, pipeline: pipeline, maxItems: maxItems }),
    });
    var data = await res.json();
    if (data.error) { showToast('Error: ' + data.error, 'error'); return; }
    showToast('Autopilot started: ' + (data.projectName || project), 'success');
    loadAutopilotStatus();
    if (data.sessionId) selectApSession(data.sessionId);
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

async function apPause(sessionId) {
  await postAction('/api/autopilot/pause', { sessionId: sessionId }, 'Autopilot paused');
  loadAutopilotStatus();
  if (selectedApSessionId === sessionId) loadApSessionDetail(sessionId);
}
async function apResume(sessionId) {
  await postAction('/api/autopilot/resume', { sessionId: sessionId }, 'Autopilot resumed');
  loadAutopilotStatus();
  if (selectedApSessionId === sessionId) loadApSessionDetail(sessionId);
}
async function apStop(sessionId) {
  if (!confirm('Stop this autopilot session?')) return;
  await postAction('/api/autopilot/stop', { sessionId: sessionId }, 'Autopilot stopped');
  loadAutopilotStatus();
  if (selectedApSessionId === sessionId) loadApSessionDetail(sessionId);
}

async function apApproveItem(sessionId) {
  await postAction('/api/autopilot/approve-item', { sessionId: sessionId }, 'Item approved');
  loadAutopilotStatus();
  if (selectedApSessionId === sessionId) loadApSessionDetail(sessionId);
}

async function apRejectItem(sessionId) {
  await postAction('/api/autopilot/reject-item', { sessionId: sessionId }, 'Item rejected');
  loadAutopilotStatus();
  if (selectedApSessionId === sessionId) loadApSessionDetail(sessionId);
}

async function apFeedbackItem(sessionId) {
  var input = document.getElementById('apFeedbackInput');
  var text = input ? input.value.trim() : '';
  if (!text) { text = prompt('Feedback:'); if (!text) return; }
  await postAction('/api/autopilot/feedback-item', { sessionId: sessionId, feedback: text }, 'Feedback sent');
  if (input) input.value = '';
  loadAutopilotStatus();
  if (selectedApSessionId === sessionId) loadApSessionDetail(sessionId);
}

function buildDirectivesHtml(s) {
  var directives = s.directives || [];
  var pending = directives.filter(function(d) { return d.status === 'pending'; });
  var consumed = directives.filter(function(d) { return d.status === 'consumed'; });
  var html = '<div class="ap-section"><h4>Directives</h4>';

  if (s.status !== 'stopped') {
    html += '<div class="ap-directive-input">' +
      '<input id="apDirectiveInput" placeholder="Add a directive (feature request, bug fix, direction...)" onkeydown="if(event.key===\\'Enter\\')apAddDirective(\\'' + esc(s.id) + '\\')">' +
      '<button onclick="apAddDirective(\\'' + esc(s.id) + '\\')">Add</button>' +
      '</div>';
  }

  if (pending.length > 0) {
    pending.forEach(function(d) {
      html += '<div class="ap-directive-item pending">' +
        '<span style="flex:1">' + esc(d.text) + '</span>' +
        '<span style="display:flex;gap:4px">' +
          '<button style="font-size:11px;padding:2px 6px" onclick="apEditDirective(\\'' + esc(s.id) + '\\',\\'' + esc(d.id) + '\\',\\'' + esc(d.text).replace(/'/g, "\\\\'") + '\\')">Edit</button>' +
          '<button style="font-size:11px;padding:2px 6px" onclick="apDeleteDirective(\\'' + esc(s.id) + '\\',\\'' + esc(d.id) + '\\')">Del</button>' +
        '</span></div>';
    });
  } else {
    html += '<div style="color:var(--text-muted);font-size:12px;padding:4px 8px">(no pending directives)</div>';
  }

  if (consumed.length > 0) {
    html += '<details style="margin-top:6px"><summary style="font-size:11px;color:var(--text-muted);cursor:pointer">Consumed (' + consumed.length + ')</summary>';
    consumed.forEach(function(d) {
      html += '<div class="ap-directive-item consumed"><span style="flex:1">' + esc(d.text) + '</span>' +
        '<span style="font-size:10px;color:var(--text-muted)">iter ' + (d.consumedInIteration || '?') + '</span></div>';
    });
    html += '</details>';
  }

  html += '</div>';
  return html;
}

async function apAddDirective(sessionId) {
  var input = document.getElementById('apDirectiveInput');
  var text = input ? input.value.trim() : '';
  if (!text) return;
  await postAction('/api/autopilot/directive/add', { sessionId: sessionId, text: text }, 'Directive added');
  if (input) input.value = '';
  if (selectedApSessionId === sessionId) loadApSessionDetail(sessionId);
}

async function apEditDirective(sessionId, directiveId, currentText) {
  var newText = prompt('Edit directive:', currentText);
  if (newText === null || !newText.trim()) return;
  await postAction('/api/autopilot/directive/edit', { sessionId: sessionId, directiveId: directiveId, text: newText.trim() }, 'Directive updated');
  if (selectedApSessionId === sessionId) loadApSessionDetail(sessionId);
}

async function apDeleteDirective(sessionId, directiveId) {
  if (!confirm('Delete this directive?')) return;
  await postAction('/api/autopilot/directive/delete', { sessionId: sessionId, directiveId: directiveId }, 'Directive deleted');
  if (selectedApSessionId === sessionId) loadApSessionDetail(sessionId);
}

function handleAutopilotEvent(event, data) {
  if (event === 'autopilot:started') {
    showToast('Autopilot started: ' + (data.projectName || ''), 'info');
    loadAutopilotStatus();
  } else if (event === 'autopilot:planning') {
    updateApSessionStatus(data.sessionId, 'planning');
  } else if (event === 'autopilot:planned') {
    showToast('Autopilot planned ' + (data.roadmap ? data.roadmap.length : 0) + ' items (iter ' + data.iteration + ')', 'info');
    loadAutopilotStatus();
    if (data.sessionId === selectedApSessionId) loadApSessionDetail(data.sessionId);
  } else if (event === 'autopilot:executing') {
    updateApSessionStatus(data.sessionId, 'running');
  } else if (event === 'autopilot:reviewing') {
    updateApSessionStatus(data.sessionId, 'reviewing');
  } else if (event === 'autopilot:reviewed') {
    var decisionType = data.decision === 'approve' ? 'success' : 'warning';
    showToast('Review: ' + data.decision + (data.feedback ? ' - ' + data.feedback.slice(0, 60) : ''), decisionType);
  } else if (event === 'autopilot:releasing') {
    updateApSessionStatus(data.sessionId, 'releasing');
    showToast('Releasing ' + (data.version || ''), 'info');
  } else if (event === 'autopilot:released') {
    showToast('Released ' + (data.version || ''), 'success');
    notifyDesktop('Autopilot Release', data.version + ': ' + (data.changelog || '').slice(0, 100));
    loadAutopilotStatus();
    if (data.sessionId === selectedApSessionId) loadApSessionDetail(data.sessionId);
  } else if (event === 'autopilot:paused') {
    showToast('Autopilot paused: ' + (data.reason || ''), 'warning');
    loadAutopilotStatus();
    if (data.sessionId === selectedApSessionId) loadApSessionDetail(data.sessionId);
  } else if (event === 'autopilot:resumed') {
    showToast('Autopilot resumed', 'info');
    loadAutopilotStatus();
    if (data.sessionId === selectedApSessionId) loadApSessionDetail(data.sessionId);
  } else if (event === 'autopilot:stopped') {
    showToast('Autopilot stopped', 'info');
    loadAutopilotStatus();
    if (data.sessionId === selectedApSessionId) loadApSessionDetail(data.sessionId);
  } else if (event === 'autopilot:error') {
    showToast('Autopilot error: ' + (data.error || ''), 'error');
  } else if (event === 'autopilot:replan') {
    showToast('Autopilot re-planning (iter ' + data.iteration + ')', 'info');
  } else if (event === 'autopilot:progress') {
    loadAutopilotStatus();
    if (data.sessionId === selectedApSessionId) loadApSessionDetail(data.sessionId);
  } else if (event === 'autopilot:forging' || event === 'autopilot:testing') {
    if (data.sessionId === selectedApSessionId) loadApSessionDetail(data.sessionId);
  } else if (event === 'autopilot:test_result') {
    if (data.sessionId === selectedApSessionId) loadApSessionDetail(data.sessionId);
  } else if (event === 'autopilot:awaiting_review') {
    showToast('Awaiting review: ' + (data.item ? data.item.title : ''), 'warning');
    loadAutopilotStatus();
    if (data.sessionId === selectedApSessionId) loadApSessionDetail(data.sessionId);
  } else if (event === 'autopilot:directive_added' || event === 'autopilot:directive_updated' || event === 'autopilot:directive_deleted') {
    if (data.sessionId === selectedApSessionId) loadApSessionDetail(data.sessionId);
  } else if (event === 'autopilot:directives_consumed') {
    showToast(data.count + ' directive(s) consumed in iteration ' + data.iteration, 'info');
    loadAutopilotStatus();
    if (data.sessionId === selectedApSessionId) loadApSessionDetail(data.sessionId);
  }
  updateApBadge();
  updateApPageTitle();
}

function updateApSessionStatus(sessionId, status) {
  var s = autopilotSessions.find(function(s) { return s.id === sessionId; });
  if (s) s.status = status;
  renderApSessions();
}

// ── Init ──

// Request notification permission on user interaction
document.addEventListener('click', function requestNotifPerm() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
  document.removeEventListener('click', requestNotifPerm);
}, { once: true });

connect();
</script>
</body>
</html>`;
}

module.exports = { buildHtml };

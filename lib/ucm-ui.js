function buildHtml(port) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>UCM Dashboard</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
:root {
  --bg: #0d1117; --surface: #161b22; --border: #30363d;
  --text: #c9d1d9; --text-muted: #8b949e; --text-bright: #f0f6fc;
  --accent: #58a6ff; --green: #3fb950; --red: #f85149; --yellow: #d29922; --purple: #bc8cff;
}
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; background: var(--bg); color: var(--text); height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
a { color: var(--accent); text-decoration: none; }
button { cursor: pointer; border: 1px solid var(--border); background: var(--surface); color: var(--text); padding: 6px 12px; border-radius: 6px; font-size: 13px; }
button:hover { background: #1f2937; }
button.primary { background: #238636; border-color: #2ea043; color: #fff; }
button.primary:hover { background: #2ea043; }
button.danger { background: #da3633; border-color: #f85149; color: #fff; }
button.danger:hover { background: #f85149; }
button.warning { background: #9e6a03; border-color: #d29922; color: #fff; }

/* Header */
.header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--border); background: var(--surface); flex-shrink: 0; }
.header h1 { font-size: 16px; color: var(--text-bright); }
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
.modal h3 { margin-bottom: 16px; color: var(--text-bright); }
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
.pipeline-bar { display: flex; gap: 4px; margin-top: 8px; }
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
button.refine { background: #1a1e3e; border-color: var(--purple); color: var(--purple); }
button.refine:hover { background: #252a50; }

/* Tab Toggle */
.tab-toggle { display: flex; gap: 0; }
.tab-toggle .toggle { border-radius: 0; border: 1px solid var(--border); background: var(--bg); color: var(--text-muted); font-size: 12px; padding: 5px 0; width: 80px; text-align: center; }
.tab-toggle .toggle:first-child { border-radius: 6px 0 0 6px; }
.tab-toggle .toggle + .toggle { border-left: none; }
.tab-toggle .toggle:last-child { border-radius: 0 6px 6px 0; }
.tab-toggle .toggle.active { background: var(--accent); color: #fff; border-color: var(--accent); }

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
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
</style>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5/css/xterm.min.css">
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0/lib/addon-fit.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-web-links@0/lib/addon-web-links.min.js"></script>
</head>
<body>
<div class="header">
  <h1>UCM Dashboard</h1>
  <div class="tab-toggle">
    <button class="toggle active" onclick="switchPanel('chat')">Chat</button>
    <button class="toggle" onclick="switchPanel('tasks')">Tasks</button>
    <button class="toggle" onclick="switchPanel('proposals')">Proposals</button>
  </div>
  <div class="status">
    <span class="dot running" id="statusDot"></span>
    <span id="statusText">connecting...</span>
    <button id="pauseBtn" onclick="togglePause()">Pause</button>
    <button id="stopDaemonBtn" class="danger" onclick="stopDaemon()" style="display:none">Stop Daemon</button>
  </div>
</div>

<div class="main">
  <div class="left" id="leftPanel">
    <div class="toolbar">
      <button class="primary" onclick="showModal()">+ New</button>
    </div>
    <div class="task-list" id="taskList"></div>
    <div class="proposal-list" id="proposalList" style="display:none"></div>
  </div>
  <div class="right">
    <div id="detailView" class="empty">Select a task</div>
    <div id="chatView" style="display:none" class="terminal-container">
      <div class="terminal-toolbar">
        <span id="terminalStatus">disconnected</span>
        <div class="actions">
          <button onclick="terminalNew()">New Session</button>
        </div>
      </div>
      <div id="terminal"></div>
    </div>
  </div>
</div>

<div class="footer">
  <span id="footerStats">-</span>
  <span id="footerResources">-</span>
</div>

<div class="modal-overlay" id="modalOverlay" onclick="if(event.target===this)hideModal()">
  <form class="modal" onsubmit="event.preventDefault();submitTask()">
    <h3>New Task</h3>
    <label>Title</label>
    <input id="taskTitle" placeholder="Task title" required>
    <label>Project path</label>
    <div class="project-row">
      <input id="taskProject" placeholder="/path/to/project">
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
        <button type="button" class="primary" onclick="selectCurrentDir()">Select this folder</button>
      </div>
    </div>
    <label>Description</label>
    <textarea id="taskDesc" placeholder="What needs to be done..."></textarea>
    <label>Pipeline</label>
    <select id="taskPipeline"></select>
    <div class="modal-actions">
      <button type="button" onclick="hideModal()">Cancel</button>
      <button type="button" class="refine" onclick="startRefinement('interactive')">Q&amp;A Refine</button>
      <button type="button" class="refine" onclick="startRefinement('autopilot')">Auto Refine</button>
      <button type="submit" class="primary">Submit</button>
    </div>
  </form>
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
let currentPanel = 'chat';
let browserCurrentPath = '';

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function openBrowser() {
  const input = document.getElementById('taskProject').value.trim();
  const startPath = input || '';
  fetch('/api/browse?path=' + encodeURIComponent(startPath))
    .then(r => r.json())
    .then(data => {
      if (data.error) { alert(data.error); return; }
      renderBrowser(data);
      document.getElementById('dirBrowser').style.display = 'flex';
    })
    .catch(err => alert('Browse failed: ' + err.message));
}

function renderBrowser(data) {
  browserCurrentPath = data.current;
  document.getElementById('dirCurrent').textContent = data.current;
  const list = document.getElementById('dirList');
  list.innerHTML = '';
  data.directories.forEach(d => {
    const item = document.createElement('div');
    item.className = 'dir-item';
    item.innerHTML = '<span class="icon">\ud83d\udcc1</span>' + escapeHtml(d.name);
    item.onclick = () => browseDir(d.path);
    list.appendChild(item);
  });
  if (data.directories.length === 0) {
    list.innerHTML = '<div style="padding:12px;color:var(--text-muted);font-size:13px">No subdirectories</div>';
  }
}

function browseDir(dirPath) {
  fetch('/api/browse?path=' + encodeURIComponent(dirPath))
    .then(r => r.json())
    .then(data => {
      if (data.error) { alert(data.error); return; }
      renderBrowser(data);
    });
}

function browseUp() {
  const current = browserCurrentPath;
  fetch('/api/browse?path=' + encodeURIComponent(current))
    .then(r => r.json())
    .then(data => {
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

function connect() {
  ws = new WebSocket('ws://' + location.host);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    loadInitial();
    if (window._pollTimer) clearInterval(window._pollTimer);
    window._pollTimer = setInterval(loadInitial, 30000);
  };
  ws.onmessage = (e) => {
    // binary frame → terminal output
    if (e.data instanceof ArrayBuffer) {
      if (term) term.write(new Uint8Array(e.data));
      return;
    }
    try {
      const msg = JSON.parse(e.data);
      if (msg.event && msg.event.startsWith('pty:')) {
        handlePtyMessage(msg.event, msg.data);
        return;
      }
      handleEvent(msg.event, msg.data);
    } catch (err) { console.error('ws message parse error:', err); }
  };
  ws.onerror = (e) => { console.error('ws error:', e); };
  ws.onclose = (e) => {
    console.log('ws close: code=' + e.code + ' reason=' + e.reason + ' wasClean=' + e.wasClean);
    document.getElementById('statusText').textContent = 'disconnected';
    document.getElementById('statusDot').className = 'dot';
    setTerminalStatus('disconnected');
    setTimeout(connect, 3000);
  };
}

async function loadInitial() {
  try {
    const [listRes, statsRes, proposalsRes] = await Promise.all([
      fetch('/api/list').then(r => r.json()),
      fetch('/api/stats').then(r => r.json()),
      fetch('/api/proposals').then(r => r.json()),
    ]);
    tasks = listRes;
    stats = statsRes;
    proposals = proposalsRes;
    daemonStatus = stats.daemonStatus || 'running';
    renderAll();
    if (stats.pipelines) {
      const sel = document.getElementById('taskPipeline');
      if (sel && sel.options.length === 0) {
        stats.pipelines.forEach(p => {
          const opt = document.createElement('option');
          opt.value = p;
          opt.textContent = p;
          if (p === stats.defaultPipeline) opt.selected = true;
          sel.appendChild(opt);
        });
      }
    }
    if (selectedTaskId) loadDetail(selectedTaskId);
    switchPanel(currentPanel);
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
    const existing = tasks.find(t => t.id === data.id);
    if (!existing) tasks.unshift(data);
    renderTasks();
  } else if (event === 'task:updated') {
    const task = tasks.find(t => t.id === data.taskId);
    if (task) {
      if (data.state) task.state = data.state;
      if (data.stage) task.currentStage = data.stage;
      if (data.status) task.stageStatus = data.status;
    }
    renderTasks();
    if (data.taskId === selectedTaskId) loadDetail(selectedTaskId);
  } else if (event === 'task:deleted') {
    tasks = tasks.filter(t => t.id !== data.taskId);
    if (selectedTaskId === data.taskId) { selectedTaskId = null; document.getElementById('detailView').innerHTML = 'Select a task'; document.getElementById('detailView').className = 'empty'; }
    renderTasks();
  } else if (event === 'daemon:status') {
    const wasOffline = daemonStatus === 'offline';
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
  } else if (event === 'task:log' && data.taskId === selectedTaskId) {
    const logEl = document.getElementById('logContent');
    if (logEl) {
      logEl.textContent += data.line + '\\n';
      logEl.scrollTop = logEl.scrollHeight;
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
    const statusEl = document.getElementById('refStatus');
    if (statusEl) statusEl.textContent = 'Error: ' + (data.error || 'unknown');
  } else if (event === 'refinement:status' && refinementSession && data.sessionId === refinementSession.sessionId) {
    const statusEl = document.getElementById('refStatus');
    if (statusEl) statusEl.textContent = data.status;
  } else if (event === 'refinement:cancelled' && refinementSession && data.sessionId === refinementSession.sessionId) {
    refinementSession = null;
    currentRefinementQuestion = null;
    const view = document.getElementById('detailView');
    view.className = 'empty';
    view.innerHTML = 'Select a task';
  } else if (event === 'proposal:created') {
    const existing = proposals.find(p => p.id === data.id);
    if (!existing) proposals.unshift(data);
    renderProposals();
  } else if (event === 'proposal:updated') {
    const idx = proposals.findIndex(p => p.id === data.id);
    if (idx >= 0) {
      proposals[idx] = { ...proposals[idx], ...data };
    }
    renderProposals();
    if (data.id === selectedProposalId) loadProposalDetail(data.id);
  } else if (event === 'proposal:evaluated') {
    const idx = proposals.findIndex(p => p.id === data.id);
    if (idx >= 0) {
      proposals[idx] = { ...proposals[idx], ...data };
    }
    renderProposals();
    if (data.id === selectedProposalId) loadProposalDetail(data.id);
  } else if (event === 'observer:completed') {
    fetch('/api/proposals').then(r => r.json()).then(list => { proposals = list; renderProposals(); }).catch(() => {});
  }
}

function renderAll() {
  renderStatus();
  renderTasks();
  renderProposals();
  renderFooter();
}

function renderStatus() {
  const dot = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  const btn = document.getElementById('pauseBtn');
  const stopBtn = document.getElementById('stopDaemonBtn');
  if (daemonStatus === 'offline') {
    dot.className = 'dot offline';
    text.textContent = 'daemon offline';
    btn.textContent = 'Start Daemon';
    btn.onclick = startDaemon;
    if (stopBtn) stopBtn.style.display = 'none';
  } else {
    dot.className = 'dot ' + daemonStatus;
    text.textContent = daemonStatus;
    btn.textContent = daemonStatus === 'paused' ? 'Resume' : 'Pause';
    btn.onclick = togglePause;
    if (stopBtn) stopBtn.style.display = '';
  }
}

function renderTasks() {
  const order = { running: 0, review: 1, suspended: 2, pending: 3, done: 4, failed: 5 };
  const sorted = [...tasks].sort((a, b) => (order[a.state] ?? 5) - (order[b.state] ?? 5));
  const el = document.getElementById('taskList');
  el.innerHTML = sorted.map(t => {
    const state = t.state || t.status || 'pending';
    const stageInfo = t.currentStage ? ' <small>(' + esc(t.currentStage) + ')</small>' : '';
    return '<div class="task-item' + (t.id === selectedTaskId ? ' selected' : '') + '" onclick="selectTask(\\'' + esc(t.id) + '\\')">' +
      '<div class="title"><span class="badge ' + esc(state) + '">' + esc(state) + '</span>' + stageInfo + ' ' + esc(t.title) + '</div>' +
      '<div class="meta"><span>' + esc((t.id || '').slice(0,8)) + '</span><span>' + esc(t.project ? t.project.split('/').pop() : '') + '</span></div>' +
      '</div>';
  }).join('');
}

function renderFooter() {
  const counts = { pending: 0, running: 0, review: 0, done: 0, failed: 0 };
  tasks.forEach(t => { const s = t.state || t.status; if (counts[s] !== undefined) counts[s]++; });
  document.getElementById('footerStats').textContent =
    'Tasks: ' + tasks.length + ' | running: ' + counts.running + ' | review: ' + counts.review + ' | pending: ' + counts.pending + ' | done: ' + counts.done + ' | failed: ' + counts.failed;
  const r = stats.resources;
  if (r) {
    document.getElementById('footerResources').textContent =
      'CPU: ' + (r.cpuLoad * 100).toFixed(0) + '% | Mem: ' + Math.round(r.memoryFreeMb) + 'MB free | Disk: ' + (r.diskFreeGb !== null ? r.diskFreeGb.toFixed(1) + 'GB' : 'n/a');
  }
}

async function selectTask(id) {
  selectedTaskId = id;
  renderTasks();
  await loadDetail(id);
}

async function loadDetail(id) {
  if (detailAbort) detailAbort.abort();
  detailAbort = new AbortController();
  const signal = detailAbort.signal;
  const view = document.getElementById('detailView');
  view.className = '';
  try {
    const task = await fetch('/api/status/' + id, { signal }).then(r => r.json());
    const state = task.state || task.status || 'pending';
    const safeId = esc(id);
    let actions = '';
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
        '<button class="danger" onclick="deleteTask(\\'' + safeId + '\\')">Delete</button>' +
        '</div>';
    }
    if (state === 'done') {
      actions = '<div class="actions">' +
        '<button class="danger" onclick="deleteTask(\\'' + safeId + '\\')">Delete</button>' +
        '</div>';
    }
    view.innerHTML =
      '<div class="detail-header">' +
        '<h2>' + esc(task.title) + '</h2>' +
        '<div class="meta"><span class="badge ' + esc(state) + '">' + esc(state) + '</span> ' + safeId + ' | created: ' + esc(task.created || '') + '</div>' +
        (task.body ? '<p>' + esc(task.body) + '</p>' : '') +
        actions +
      '</div>' +
      '<div class="tabs">' +
        '<button class="active" onclick="showTab(this,\\'summary\\')">Summary</button>' +
        '<button onclick="showTab(this,\\'diff\\')">Diff</button>' +
        '<button onclick="showTab(this,\\'logs\\')">Logs</button>' +
      '</div>' +
      '<div class="tab-content" id="tabContent"><pre>Loading...</pre></div>';
    showTabContent('summary', id, signal);
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('loadDetail error:', err); view.className = 'empty'; view.innerHTML = 'Error loading task';
  }
}

async function showTabContent(tab, id, signal) {
  const el = document.getElementById('tabContent');
  if (!el) return;
  const opts = signal ? { signal } : {};
  try {
    if (tab === 'summary') {
      const art = await fetch('/api/artifacts/' + id, opts).then(r => r.json());
      if (art.summary) {
        el.innerHTML = '<pre>' + esc(art.summary) + '</pre>';
      } else {
        const r = await fetch('/api/status/' + id, opts).then(r => r.json());
        el.innerHTML = '<pre>' + esc(r.body || '(no summary yet)') + '</pre>';
      }
    } else if (tab === 'diff') {
      const diffs = await fetch('/api/diff/' + id, opts).then(r => r.json());
      el.innerHTML = diffs.length === 0 ? '<pre>(no diffs yet)</pre>' :
        diffs.map(d => '<h4>' + esc(d.project) + '</h4><pre>' + esc(d.diff) + '</pre>').join('');
    } else if (tab === 'logs') {
      const logs = await fetch('/api/logs/' + id, opts).then(r => r.json());
      const logText = typeof logs === 'string' ? logs : JSON.stringify(logs);
      el.innerHTML = '<pre id="logContent">' + (logText ? esc(logText) : '(no logs yet)') + '</pre>';
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('showTabContent error:', err); el.innerHTML = '<pre>Error loading</pre>';
  }
}

function showTab(btn, tab) {
  btn.parentElement.querySelectorAll('button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  if (selectedTaskId) showTabContent(tab, selectedTaskId);
}

async function approveTask(id) { await postAction('/api/approve/' + id); loadInitial(); }
async function rejectTask(id) { await postAction('/api/reject/' + id); loadInitial(); }
async function cancelTask(id) { await postAction('/api/cancel/' + id); loadInitial(); }
async function retryTask(id) { await postAction('/api/retry/' + id); loadInitial(); }
async function deleteTask(id) {
  if (!confirm('Delete this task?')) return;
  await postAction('/api/delete/' + id); selectedTaskId = null; loadInitial();
}
async function requestChanges(id) {
  const feedback = prompt('Feedback:');
  if (feedback !== null) await postAction('/api/reject/' + id, { feedback });
  loadInitial();
}
async function startDaemon() {
  await postAction('/api/daemon/start');
}
async function stopDaemon() {
  if (!confirm('Stop daemon?')) return;
  await postAction('/api/daemon/stop');
}
async function togglePause() {
  await postAction(daemonStatus === 'paused' ? '/api/resume' : '/api/pause');
  loadInitial();
}
async function postAction(url, body) {
  try { await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); } catch (err) { console.error('postAction error:', err); }
}

function showModal() { document.getElementById('modalOverlay').classList.add('show'); document.getElementById('taskTitle').focus(); }
function hideModal() { document.getElementById('modalOverlay').classList.remove('show'); }
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('modalOverlay').classList.contains('show')) hideModal();
});
async function submitTask() {
  const title = document.getElementById('taskTitle').value.trim();
  const project = document.getElementById('taskProject').value.trim();
  const body = document.getElementById('taskDesc').value.trim();
  const pipeline = document.getElementById('taskPipeline').value;
  if (!title) return;
  await postAction('/api/submit', { title, body, project: project || undefined, pipeline: pipeline || undefined });
  hideModal();
  document.getElementById('taskTitle').value = '';
  document.getElementById('taskProject').value = '';
  document.getElementById('taskDesc').value = '';
  loadInitial();
}

function showGatherQuestions(taskId, round, questions) {
  hideGatherPanel();
  const view = document.getElementById('detailView');
  if (!view) return;
  const panel = document.createElement('div');
  panel.className = 'gather-panel';
  panel.id = 'gatherPanel';
  panel.innerHTML =
    '<h4>Gathering Requirements (Round ' + round + ')</h4>' +
    questions.map((q, i) =>
      '<div class="question"><label>' + esc(q) + '</label><input id="gatherAnswer' + i + '" placeholder="Your answer..."></div>'
    ).join('') +
    '<div class="gather-actions">' +
    '<button class="primary" onclick="submitGatherAnswers(\\'' + esc(taskId) + '\\',' + questions.length + ')">Submit Answers</button>' +
    '<button onclick="submitGatherDone(\\'' + esc(taskId) + '\\')">Done (skip remaining)</button>' +
    '</div>';
  view.appendChild(panel);
}
function hideGatherPanel() {
  const panel = document.getElementById('gatherPanel');
  if (panel) panel.remove();
}
function submitGatherAnswers(taskId, count) {
  const answers = [];
  for (let i = 0; i < count; i++) {
    const el = document.getElementById('gatherAnswer' + i);
    answers.push(el ? el.value : '');
  }
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ action: 'gather_answer', params: { taskId, answers } }));
  }
  hideGatherPanel();
}
function submitGatherDone(taskId) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ action: 'gather_answer', params: { taskId, answers: [] } }));
  }
  hideGatherPanel();
}

function showProjectAskPanel(taskId) {
  hideProjectAskPanel();
  const view = document.getElementById('detailView');
  if (!view) return;
  const panel = document.createElement('div');
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
  const panel = document.getElementById('projectAskPanel');
  if (panel) panel.remove();
}
function submitProjectPath(taskId) {
  const el = document.getElementById('projectPathInput');
  const projectPath = el ? el.value.trim() : '';
  if (!projectPath) return;
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ action: 'project_answer', params: { taskId, projectPath } }));
  }
  hideProjectAskPanel();
}
function skipProjectPath(taskId) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ action: 'project_answer', params: { taskId, projectPath: '' } }));
  }
  hideProjectAskPanel();
}

function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

// ── Panel Switching ──

function switchPanel(panel) {
  currentPanel = panel;
  const toggles = document.querySelectorAll('.tab-toggle .toggle');
  toggles.forEach(b => b.classList.remove('active'));
  document.getElementById('taskList').style.display = 'none';
  document.getElementById('proposalList').style.display = 'none';
  document.getElementById('detailView').style.display = '';
  document.getElementById('chatView').style.display = 'none';
  document.getElementById('leftPanel').style.display = '';
  if (panel === 'chat') {
    toggles[0].classList.add('active');
    document.getElementById('leftPanel').style.display = 'none';
    document.getElementById('detailView').style.display = 'none';
    document.getElementById('chatView').style.display = 'flex';
    initTerminal();
  } else if (panel === 'tasks') {
    toggles[1].classList.add('active');
    document.getElementById('taskList').style.display = '';
  } else if (panel === 'proposals') {
    toggles[2].classList.add('active');
    document.getElementById('proposalList').style.display = '';
  }
}

// ── Proposals ──

function renderProposals() {
  const statusOrder = { proposed: 0, approved: 1, implemented: 2, rejected: 3 };
  const sorted = [...proposals].sort((a, b) => {
    const so = (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9);
    if (so !== 0) return so;
    return (b.priority || 0) - (a.priority || 0);
  });
  const el = document.getElementById('proposalList');
  if (!el) return;
  if (sorted.length === 0) {
    el.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:13px">No proposals yet</div>';
    return;
  }
  el.innerHTML = sorted.map(p => {
    const status = p.status || 'proposed';
    return '<div class="proposal-item' + (p.id === selectedProposalId ? ' selected' : '') + '" onclick="selectProposal(\\'' + esc(p.id) + '\\')">' +
      '<div class="title"><span class="badge ' + esc(status) + '">' + esc(status) + '</span> ' +
      (p.category ? '<small>' + esc(p.category) + '</small> ' : '') +
      (p.risk ? '<small style=\\"color:' + (p.risk === 'high' ? 'var(--red)' : p.risk === 'medium' ? 'var(--yellow)' : 'var(--text-muted)') + '\\">' + esc(p.risk) + '</small> ' : '') +
      esc(p.title) + '</div>' +
      '<div class="meta">' +
      '<span>' + esc((p.id || '').slice(0,8)) + '</span>' +
      (p.project ? '<span>' + esc(p.project.split('/').pop()) + '</span>' : '') +
      '</div>' +
      '</div>';
  }).join('');
}

async function selectProposal(id) {
  selectedProposalId = id;
  selectedTaskId = null;
  renderTasks();
  renderProposals();
  await loadProposalDetail(id);
}

async function loadProposalDetail(id) {
  const view = document.getElementById('detailView');
  view.className = '';
  try {
    const data = await fetch('/api/proposal/' + id).then(r => r.json());
    const proposal = proposals.find(p => p.id === id) || data;
    const status = proposal.status || data.status || 'proposed';
    const safeId = esc(id);

    let actions = '';
    if (status === 'proposed') {
      actions = '<div class="actions">' +
        '<button class="primary" onclick="approveProposal(\\'' + safeId + '\\')">Approve</button>' +
        '<button class="danger" onclick="rejectProposal(\\'' + safeId + '\\')">Reject</button>' +
        '<button class="up" onclick="priorityProposal(\\'' + safeId + '\\', 1)">Up</button>' +
        '<button class="down" onclick="priorityProposal(\\'' + safeId + '\\', -1)">Down</button>' +
        '</div>';
    }

    let evalHtml = '';
    if (data.evaluation) {
      const ev = data.evaluation;
      const verdictClass = ev.verdict === 'positive' ? 'positive' : ev.verdict === 'negative' ? 'negative' : 'neutral';
      evalHtml = '<div class="eval-card">' +
        '<h4>Evaluation</h4>' +
        '<div class="verdict ' + verdictClass + '">' + esc(ev.verdict || 'pending') +
        (ev.score !== undefined ? ' (score: ' + ev.score + ')' : '') + '</div>' +
        (ev.deltas ? '<div class="deltas">' +
          Object.entries(ev.deltas).map(([k,v]) => '<span>' + esc(k) + ': ' + (v > 0 ? '+' : '') + v + '</span>').join('') +
          '</div>' : '') +
        '</div>';
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
        evalHtml +
      '</div>';
  } catch (err) {
    console.error('loadProposalDetail error:', err);
    view.className = 'empty';
    view.innerHTML = 'Error loading proposal';
  }
}

async function approveProposal(id) {
  await postAction('/api/proposal/approve/' + id);
  const idx = proposals.findIndex(p => p.id === id);
  if (idx >= 0) proposals[idx].status = 'approved';
  renderProposals();
  loadProposalDetail(id);
}

async function rejectProposal(id) {
  await postAction('/api/proposal/reject/' + id);
  const idx = proposals.findIndex(p => p.id === id);
  if (idx >= 0) proposals[idx].status = 'rejected';
  renderProposals();
  loadProposalDetail(id);
}

async function priorityProposal(id, delta) {
  await postAction('/api/proposal/priority/' + id, { delta });
  const idx = proposals.findIndex(p => p.id === id);
  if (idx >= 0) proposals[idx].priority = (proposals[idx].priority || 0) + delta;
  renderProposals();
}

// ── Refinement ──

async function startRefinement(mode) {
  const titleEl = document.getElementById('taskTitle');
  const title = titleEl.value.trim();
  const project = document.getElementById('taskProject').value.trim();
  const description = document.getElementById('taskDesc').value.trim();
  const pipeline = document.getElementById('taskPipeline').value;
  if (!title) {
    titleEl.style.borderColor = 'var(--red)';
    titleEl.focus();
    setTimeout(() => { titleEl.style.borderColor = ''; }, 2000);
    return;
  }

  refinementSession = {
    sessionId: null,
    mode: mode,
    decisions: [],
    coverage: {},
    complete: false,
    title: title,
  };
  currentRefinementQuestion = null;
  hideModal();

  const view = document.getElementById('detailView');
  view.className = '';
  view.innerHTML = '<div class="refinement-panel"><h3>Refining: ' + esc(title) + '</h3><div class="ref-status" id="refStatus">준비 중...</div></div>';

  try {
    const res = await fetch('/api/refinement/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, description, project: project || undefined, pipeline: pipeline || undefined, mode }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    refinementSession.sessionId = data.sessionId;
    selectedTaskId = null;
    renderTasks();
    renderRefinementPanel();
  } catch (err) {
    console.error('startRefinement error:', err);
    refinementSession = null;
    view.innerHTML = '<div class="refinement-panel"><h3>Refinement Error</h3><div class="ref-status" style="color:var(--red)">' + esc(err.message) + '</div></div>';
  }
}

function renderRefinementPanel() {
  const view = document.getElementById('detailView');
  if (!view || !refinementSession) return;
  view.className = '';

  let html = '<div class="refinement-panel">';
  html += '<h3>Refining: ' + esc(refinementSession.title) + '</h3>';
  html += '<div class="ref-status" id="refStatus">mode: ' + esc(refinementSession.mode) + '</div>';

  // coverage bars
  const coverage = refinementSession.coverage || {};
  if (Object.keys(coverage).length > 0) {
    html += '<div class="coverage-bar">';
    for (const [area, value] of Object.entries(coverage)) {
      const pct = Math.round(value * 100);
      const full = value >= 1.0 ? ' full' : '';
      html += '<div class="area"><span style="width:80px;flex-shrink:0">' + esc(area) + '</span>' +
        '<div class="bar-track"><div class="bar-fill' + full + '" style="width:' + pct + '%"></div></div>' +
        '<span style="width:35px;text-align:right">' + pct + '%</span></div>';
    }
    html += '</div>';
  }

  // complete state
  if (refinementSession.complete) {
    html += '<div class="ref-complete"><h4>All areas covered</h4>';
    html += '<div class="ref-actions">' +
      '<button class="primary" onclick="finalizeRefinementNow()">Create Task</button>' +
      '<button class="danger" onclick="cancelRefinementNow()">Cancel</button>' +
      '</div></div>';
  } else if (refinementSession.mode === 'interactive' && currentRefinementQuestion) {
    // question card
    const q = currentRefinementQuestion;
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
    html += '<div class="ref-status">Auto-pilot in progress...</div>';
    html += '<div class="ref-actions">' +
      '<button onclick="finalizeRefinementNow()">Finalize now</button>' +
      '<button class="danger" onclick="cancelRefinementNow()">Cancel</button>' +
      '</div>';
  } else if (refinementSession.mode === 'interactive' && !currentRefinementQuestion) {
    html += '<div class="ref-status">Generating question...</div>';
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
        '<span class="d-q">' + esc(d.question) + '</span> → ' +
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
  const opt = currentRefinementQuestion.options[index];
  if (opt) {
    const input = document.getElementById('refCustomAnswer');
    if (input) input.value = opt.label;
  }
}

function submitRefinementAnswer() {
  if (!refinementSession || !currentRefinementQuestion) return;
  const input = document.getElementById('refCustomAnswer');
  const value = input ? input.value.trim() : '';
  if (!value) return;

  const answer = {
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
    const res = await fetch('/api/refinement/finalize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: refinementSession.sessionId }),
    });
    const data = await res.json();
    refinementSession = null;
    currentRefinementQuestion = null;
    loadInitial();
    if (data.taskId) selectTask(data.taskId);
  } catch (err) {
    console.error('finalizeRefinement error:', err);
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
  const view = document.getElementById('detailView');
  view.className = 'empty';
  view.innerHTML = 'Select a task';
}

// ── Terminal (xterm.js + PTY) ──

let term = null;
let fitAddon = null;
let terminalInitialized = false;
let resizeTimer = null;

function initTerminal() {
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

  const container = document.getElementById('terminal');
  term.open(container);

  // wait for layout to settle, then fit
  requestAnimationFrame(() => {
    fitAddon.fit();
    spawnPty();
  });

  // terminal input → WS binary
  term.onData((data) => {
    if (ws && ws.readyState === 1) {
      ws.send(new TextEncoder().encode(data));
    }
  });

  // terminal resize → debounced pty:resize
  term.onResize(({ cols, rows }) => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ action: 'pty:resize', params: { cols, rows } }));
      }
    }, 100);
  });

  // window resize → fit
  window.addEventListener('resize', () => {
    if (fitAddon && document.getElementById('chatView').style.display !== 'none') {
      fitAddon.fit();
    }
  });
}

function spawnPty(opts = {}) {
  if (!ws || ws.readyState !== 1) return;
  const dims = term ? { cols: term.cols, rows: term.rows } : {};
  ws.send(JSON.stringify({ action: 'pty:spawn', params: { ...dims, ...opts } }));
  setTerminalStatus('connecting...');
}

function setTerminalStatus(text) {
  const el = document.getElementById('terminalStatus');
  if (el) el.textContent = text;
}

function terminalNew() {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ action: 'pty:kill' }));
  }
  if (term) term.clear();
  setTimeout(() => spawnPty({ newSession: true }), 300);
}

function handlePtyMessage(event, data) {
  if (event === 'pty:spawned') {
    setTerminalStatus('connected');
    if (term) term.focus();
  } else if (event === 'pty:exit') {
    setTerminalStatus('exited (code: ' + (data.exitCode ?? '?') + ')');
    if (term) {
      term.writeln('');
      term.writeln('\\x1b[90m--- session ended ---\\x1b[0m');
      term.writeln('\\x1b[90mClick "New Session" to start a new session.\\x1b[0m');
    }
  } else if (event === 'pty:error') {
    setTerminalStatus('error');
    if (term) {
      term.writeln('\\x1b[31mError: ' + (data.message || 'unknown') + '\\x1b[0m');
    }
  }
}

// Override the WS message handler to handle binary frames for terminal
const _origOnWsMessage = null; // patched in connect()

connect();
</script>
</body>
</html>`;
}

module.exports = { buildHtml };

'use strict';

const vscode = require('vscode');
const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SF_METADATA_DIRS = new Set([
  'classes', 'triggers', 'lwc', 'aura', 'flows', 'objects',
  'pages', 'permissionsets', 'layouts', 'staticresources',
  'components', 'email', 'reports', 'dashboards', 'tabs',
  'profiles', 'roles', 'queues', 'groups', 'customMetadata',
]);

const TEST_RE = /Tests?$/i;

function extractMetadata(changes) {
  const itemMap = new Map();
  for (const { file } of changes) {
    const parts = file.split('/');
    const idx = parts.findIndex(p => SF_METADATA_DIRS.has(p));
    if (idx < 0 || !parts[idx + 1]) continue;
    let name = parts[idx + 1].replace(/\.[^.]+$/, '').replace(/-meta$/, '');
    if (!name) continue;
    const key = `${parts[idx]}/${name}`;
    if (!itemMap.has(key)) {
      itemMap.set(key, { name, type: parts[idx], files: [], isTest: TEST_RE.test(name) });
    }
    itemMap.get(key).files.push(file);
  }
  return [...itemMap.values()].filter(m => !m.isTest);
}

function toKebab(str) {
  return str.replace(/([A-Z])/g, (_, c) => '-' + c.toLowerCase()).replace(/^-/, '');
}

function generateBranchName(metadata) {
  if (metadata.length === 0) {
    return `feature/changes-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
  }
  const slugs = [...new Set(metadata.slice(0, 3).map(m => toKebab(m.name)))];
  return `feature/${slugs.join('-')}`;
}

function getGitChanges(cwd) {
  const raw = execSync('git -c core.quotepath=false status --porcelain', { cwd }).toString();
  return raw
    .split('\n')
    .filter(l => l.trim())
    .map(l => {
      const status = l.slice(0, 2).trim();
      let file = l.slice(3).trim();
      if (file.startsWith('"') && file.endsWith('"')) file = file.slice(1, -1);
      return { status, file };
    });
}

class FlosumBranchProvider {
  constructor() {
    this._view = null;
  }

  resolveWebviewView(webviewView) {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = fs.readFileSync(path.join(__dirname, 'webview.html'), 'utf-8');

    webviewView.webview.onDidReceiveMessage(msg => {
      if (msg.command === 'refresh') this._sendData();
      if (msg.command === 'createBranch') this._createBranch(msg.branchName, msg.selectedFiles);
      if (msg.command === 'discardFiles') this._discardFiles(msg.files);
      if (msg.command === 'openDiff') this._openDiff(msg.file);
      if (msg.command === 'loadBranches') this._loadBranches();
      if (msg.command === 'checkoutBranch') this._checkoutBranch(msg.branchName);
      if (msg.command === 'pullBranch') this._pullBranch();
      if (msg.command === 'loadOrgs') this._loadOrgs();
      if (msg.command === 'setOrg') this._setOrg(msg.alias);
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) { this._loadOrgs(); this._sendData(); }
    });

    webviewView.onDidDispose(() => {
      this._view = null;
      this._watcher?.dispose();
    });

    this._setupWatcher(webviewView);
    this._loadOrgs();
    this._sendData();
    this._post({ command: 'setLocale', locale: vscode.env.language });
  }

  _setupWatcher(webviewView) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;
    let debounce;
    const refresh = () => {
      if (!webviewView.visible) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => this._sendData(), 300);
    };
    this._watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, '**/*')
    );
    this._watcher.onDidChange(refresh);
    this._watcher.onDidCreate(refresh);
    this._watcher.onDidDelete(refresh);
    vscode.workspace.onDidSaveTextDocument(doc => {
      if (doc.uri.fsPath.startsWith(folder.uri.fsPath)) refresh();
    });
  }

  refresh() {
    if (this._view?.visible) this._sendData();
  }

  _sendData() {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this._post({ command: 'error', message: 'Nenhum workspace aberto.' });
      return;
    }
    try {
      const changes = getGitChanges(folder.uri.fsPath);
      const metadata = extractMetadata(changes);
      const sfFiles = new Set(metadata.flatMap(m => m.files));
      const otherChanges = changes.filter(c => !sfFiles.has(c.file));
      this._post({
        command: 'update',
        changes,
        metadata,
        otherCount: otherChanges.length,
        otherFiles: otherChanges.map(c => c.file),
        suggestion: generateBranchName(metadata),
      });
    } catch (e) {
      this._post({ command: 'error', message: e.message });
    }
  }

  _openDiff(file) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;
    const uri = vscode.Uri.file(path.join(folder.uri.fsPath, file));
    vscode.commands.executeCommand('vscode.diff',
      uri.with({ scheme: 'git', query: JSON.stringify({ path: uri.fsPath, ref: 'HEAD' }) }),
      uri,
      `${path.basename(file)} (HEAD ↔ local)`
    );
  }

  _discardFiles(files) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || !files?.length) return;
    const cwd = folder.uri.fsPath;
    let discarded = 0;
    for (const file of files) {
      try {
        const st = execFileSync(
          'git', ['-c', 'core.quotepath=false', 'status', '--porcelain', '--', file],
          { cwd }
        ).toString().trim();
        if (st.startsWith('??')) {
          execFileSync('git', ['clean', '-f', '--', file], { cwd });
        } else {
          execFileSync('git', ['restore', '--', file], { cwd });
        }
        discarded++;
      } catch (_) {}
    }
    this._sendData();
    this._post({ command: 'log', message: `🗑 Descartado(s): ${discarded} arquivo(s)`, type: 'info' });
  }

  _getOrg() {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return null;
    try {
      const cfg = execSync('sf config get target-org --json 2>/dev/null', {
        cwd: folder.uri.fsPath, shell: '/bin/zsh',
      }).toString();
      return JSON.parse(cfg)?.result?.[0]?.value ?? null;
    } catch (_) { return null; }
  }

  _getRepo() {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return 'Comerc';
    try {
      const raw = execSync(
        'sf data query --query "SELECT Name FROM Flosum__Repository__c LIMIT 1" --json 2>/dev/null',
        { cwd: folder.uri.fsPath, shell: '/bin/zsh', timeout: 10000 }
      ).toString();
      return JSON.parse(raw)?.result?.records?.[0]?.Name ?? 'Comerc';
    } catch (_) { return 'Comerc'; }
  }

  _terminal(cwd) {
    let t = vscode.window.terminals.find(t => t.name === 'Flosum');
    if (!t) t = vscode.window.createTerminal({ name: 'Flosum', cwd });
    t.show(true);
    return t;
  }

  _createBranch(branchName, selectedFiles) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;
    const org = this._getOrg();
    const repo = this._getRepo();
    const cwd = folder.uri.fsPath;
    const orgFlag = org ? `-u "${org}"` : '';
    const targetpath = `force-app/main/default/${branchName}`;
    const createCmd = `sf flosum branch create -r "${repo}" -b "${branchName}" -p "${targetpath}" ${orgFlag}`;

    if (!selectedFiles?.length) {
      this._post({ command: 'log', message: 'Nenhum arquivo selecionado para push.', type: 'error' });
      return;
    }

    const tmpDirName = `.flosum_push_${Date.now()}`;
    const tmpSrcAbs  = path.join(cwd, tmpDirName, 'main', 'default');
    const tmpSrcRel  = `${tmpDirName}/main/default`;

    try {
      for (const file of selectedFiles) {
        const relPath = file.replace(/^force-app\/main\/default\//, '');
        const dest = path.join(tmpSrcAbs, relPath);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(cwd, file), dest);
      }
    } catch (e) {
      this._post({ command: 'log', message: `Erro preparando arquivos: ${e.message}`, type: 'error' });
      return;
    }

    this._post({ command: 'log', message: `Push: ${selectedFiles.length} arquivo(s)`, type: 'info' });
    const pushCmd = `sf flosum source push -r "${repo}" -b "${branchName}" -s "${tmpSrcRel}" ${orgFlag} && rm -rf "${tmpDirName}"`;
    const quotedFiles = selectedFiles.map(f => `"${f.replace(/"/g, '\\"')}"`).join(' ');
    const commitCmd = `git add -- ${quotedFiles} && git commit --no-verify -m "feat: ${branchName}"`;

    this._post({ command: 'log', message: `Criando branch "${branchName}"...`, type: 'info' });
    this._terminal(cwd).sendText(
      `${createCmd} && echo "✅ Branch criada" && ${pushCmd} && echo "✅ Metadados enviados" && ${commitCmd} && echo "✅ Commit local feito"`
    );
    this._post({ command: 'branchCreated', branchName });
  }

  _loadOrgs() {
    const folder = vscode.workspace.workspaceFolders?.[0];
    try {
      const raw = execSync('sf org list --json 2>/dev/null', {
        cwd: folder?.uri.fsPath, shell: '/bin/zsh', timeout: 10000,
      }).toString();
      const data = JSON.parse(raw);
      const all = [...(data?.result?.nonScratchOrgs ?? []), ...(data?.result?.scratchOrgs ?? [])];
      const orgs = all.map(o => ({
        alias: o.alias || '',
        username: o.username || '',
        status: o.connectedStatus || '',
        isDefault: o.isDefaultUsername || false,
      }));
      let current = '';
      try {
        const cfg = execSync('sf config get target-org --json 2>/dev/null', {
          cwd: folder?.uri.fsPath, shell: '/bin/zsh',
        }).toString();
        current = JSON.parse(cfg)?.result?.[0]?.value ?? '';
      } catch (_) {}
      this._post({ command: 'orgs', orgs, current });
    } catch (e) {
      this._post({ command: 'orgsError', message: e.message });
    }
  }

  _setOrg(alias) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || !alias) return;
    try {
      execSync(`sf config set target-org "${alias}" --json 2>/dev/null`, {
        cwd: folder.uri.fsPath, shell: '/bin/zsh',
      });
      this._post({ command: 'log', message: `Org ativa: ${alias}`, type: 'success' });
      this._sendData();
    } catch (e) {
      this._post({ command: 'log', message: `Erro ao trocar org: ${e.message}`, type: 'error' });
    }
  }

  _loadBranches() {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;
    this._post({ command: 'branchesLoading' });
    const org = this._getOrg();
    const repo = this._getRepo();
    const orgFlag = org ? `-u "${org}"` : '';
    try {
      const raw = execSync(
        `sf flosum branch list -r "${repo}" --all ${orgFlag} 2>/dev/null`,
        { cwd: folder.uri.fsPath, shell: '/bin/zsh', timeout: 30000 }
      ).toString();
      const jsonLine = raw.split('\n').find(l => l.trim().startsWith('{'));
      const records = jsonLine ? (JSON.parse(jsonLine)?.records ?? []) : [];
      const branches = records
        .map(r => ({ name: r.Flosum__Branch_Name__c || r.Name || '' }))
        .filter(b => b.name)
        .sort((a, b) => a.name.localeCompare(b.name));
      this._post({ command: 'branches', branches });
    } catch (e) {
      this._post({ command: 'branchesError', message: e.message });
    }
  }

  _checkoutBranch(branchName) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;
    const org = this._getOrg();
    const repo = this._getRepo();
    const orgFlag = org ? `-u "${org}"` : '';
    const cmd = `sf flosum source pull -r "${repo}" -b "${branchName}" -p "force-app/main/default" ${orgFlag}`;
    this._post({ command: 'log', message: `Retrieve: ${branchName}`, type: 'info' });
    this._terminal(folder.uri.fsPath).sendText(cmd);
  }

  _pullBranch() {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;
    const org = this._getOrg();
    const repo = this._getRepo();
    const orgFlag = org ? `-u "${org}"` : '';
    this._post({ command: 'log', message: 'Retrieve branch atual...', type: 'info' });
    this._terminal(folder.uri.fsPath).sendText(
      `sf flosum source pull -r "${repo}" -b "$(git branch --show-current)" -p "force-app/main/default" ${orgFlag}`
    );
  }

  _post(msg) {
    this._view?.webview.postMessage(msg);
  }
}

function activate(context) {
  const provider = new FlosumBranchProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('flosum.branchView', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('flosum.refreshView', () => provider.refresh())
  );
}

module.exports = { activate, deactivate: () => {} };

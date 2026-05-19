const antigravity = (() => {
    try {
        return require('antigravity-core-api');
    } catch {
        try {
            return require('antigravity');
        } catch {
            return require('vscode');
        }
    }
})();
const path = require('path');
const fs = require('fs');

function activate(context) {
    let visualPanel = antigravity.window.createWebviewPanel(
        'visualArchitectureView',
        'Antigravity Component Canvas',
        antigravity.ViewColumn.Two,
        { enableScripts: true, retainContextWhenHidden: true }
    );


    visualPanel.webview.html = getWebviewContent();

    function resolveImportPath(currentDir, importPath) {
        if (javaPackages.has(importPath)) {
            return javaPackages.get(importPath);
        }

        if (importPath.startsWith('./') || importPath.startsWith('../')) {
            const resolved = path.resolve(currentDir, importPath);
            const extensions = ['', '.js', '.jsx', '.ts', '.tsx', '/index.js', '/index.jsx', '/index.ts', '/index.tsx'];
            for (const ext of extensions) {
                const fullPath = resolved + ext;
                if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
                    return fullPath;
                }
            }
        }
        return null;
    }

    function extractImports(content) {
        const imports = new Set();
        
        // 1. ESM Imports
        const esmRegex = /import\s+(?:[\w*\s{},]*\s+from\s+)?['"]([^'"]+)['"]/g;
        let match;
        while ((match = esmRegex.exec(content)) !== null) {
            imports.add(match[1]);
        }
        
        // 2. CommonJS require() assignment
        const cjsRegex = /(?:const|let|var)?\s*[\w\s{},]*\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
        let cjsMatch;
        while ((cjsMatch = cjsRegex.exec(content)) !== null) {
            imports.add(cjsMatch[1]);
        }

        // 3. Simple require() call
        const simpleCjsRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
        let simpleMatch;
        while ((simpleMatch = simpleCjsRegex.exec(content)) !== null) {
            imports.add(simpleMatch[1]);
        }
        
        // 4. Java/Kotlin package imports
        const javaRegex = /import\s+([\w.]+);?/g;
        let javaMatch;
        while ((javaMatch = javaRegex.exec(content)) !== null) {
            imports.add(javaMatch[1]);
        }
        
        return Array.from(imports);
    }

    const nodesCache = new Map();
    const javaPackages = new Map();
    let renderTimeout;
    const pendingUpdates = new Set();

    function removeFromJavaPackages(filePath) {
        for (const [fqn, p] of javaPackages.entries()) {
            if (p === filePath) {
                javaPackages.delete(fqn);
                break;
            }
        }
    }

    async function processPendingUpdates() {
        if (pendingUpdates.size === 0) return;

        const paths = Array.from(pendingUpdates);
        pendingUpdates.clear();

        await Promise.all(paths.map(async (filePath) => {
            try {
                if (fs.existsSync(filePath)) {
                    const stats = await fs.promises.stat(filePath);
                    if (stats.isFile() && stats.size < 500000) {
                        const content = await fs.promises.readFile(filePath, 'utf8');
                        const fileName = path.basename(filePath);
                        const ext = path.extname(filePath).toLowerCase();
                        
                        removeFromJavaPackages(filePath);
                        if (ext === '.java' || ext === '.kt') {
                            const packageMatch = content.match(/package\s+([\w.]+)/);
                            if (packageMatch) {
                                const baseName = path.basename(filePath, ext);
                                const fqn = packageMatch[1] + '.' + baseName;
                                javaPackages.set(fqn, filePath);
                            }
                        }

                        nodesCache.set(filePath, {
                            id: fileName,
                            label: fileName,
                            rawImports: extractImports(content),
                            filePath: filePath
                        });
                        return;
                    }
                }
                removeFromJavaPackages(filePath);
                nodesCache.delete(filePath);
            } catch (err) {
                removeFromJavaPackages(filePath);
                nodesCache.delete(filePath);
            }
        }));

        const nodeImports = new Map();
        const nodeImportedBy = new Map();
        for (const node of nodesCache.values()) {
            nodeImports.set(node.id, []);
            nodeImportedBy.set(node.id, []);
        }

        const edges = [];
        for (const [filePath, node] of nodesCache.entries()) {
            const currentDir = path.dirname(filePath);
            const importedPaths = node.rawImports || [];
            for (const importPath of importedPaths) {
                const resolved = resolveImportPath(currentDir, importPath);
                if (resolved && nodesCache.has(resolved)) {
                    const targetFileName = path.basename(resolved);
                    nodeImports.get(node.id).push(targetFileName);
                    nodeImportedBy.get(targetFileName).push(node.id);
                    edges.push({
                        id: `edge-${node.id}-${targetFileName}`,
                        source: node.id,
                        target: targetFileName
                    });
                }
            }
        }

        const nodes = Array.from(nodesCache.values()).map(node => ({
            id: node.id,
            label: node.label,
            filePath: node.filePath,
            imports: nodeImports.get(node.id) || [],
            importedBy: nodeImportedBy.get(node.id) || []
        }));
        visualPanel.webview.postMessage({ command: 'renderTree', nodes, edges });
    }

    function triggerIncrementalScan(filePath) {
        pendingUpdates.add(filePath);
        if (renderTimeout) {
            clearTimeout(renderTimeout);
        }
        renderTimeout = setTimeout(processPendingUpdates, 150);
    }

    async function scanProjectWorkspace() {
        const files = await antigravity.workspace.findFiles(
            '**/*.{js,jsx,ts,tsx,java,kt}',
            '{**/node_modules/**,**/dist/**,**/build/**,**/.next/**,**/.git/**,**/out/**,**/.vscode/**,**/.gradle/**,**/.idea/**,**/.expo/**}'
        );
        nodesCache.clear();
        javaPackages.clear();

        const batchSize = 50;
        let processedCount = 0;

        visualPanel.webview.postMessage({
            command: 'scanProgress',
            scanned: 0,
            total: files.length,
            nodeCount: 0
        });

        await antigravity.window.withProgress({
            location: antigravity.ProgressLocation.Notification,
            title: "Scanning workspace files...",
            cancellable: false
        }, async (progress) => {
            for (let i = 0; i < files.length; i += batchSize) {
                const batch = files.slice(i, i + batchSize);
                await Promise.all(batch.map(async (file) => {
                    try {
                        const stats = await fs.promises.stat(file.fsPath);
                        if (stats.size < 500000) {
                            const content = await fs.promises.readFile(file.fsPath, 'utf8');
                            const fileName = path.basename(file.fsPath);
                            const ext = path.extname(file.fsPath).toLowerCase();
                            
                            if (ext === '.java' || ext === '.kt') {
                                const packageMatch = content.match(/package\s+([\w.]+)/);
                                if (packageMatch) {
                                    const baseName = path.basename(file.fsPath, ext);
                                    const fqn = packageMatch[1] + '.' + baseName;
                                    javaPackages.set(fqn, file.fsPath);
                                }
                            }

                            nodesCache.set(file.fsPath, {
                                id: fileName,
                                label: fileName,
                                rawImports: extractImports(content),
                                filePath: file.fsPath
                            });
                        }
                    } catch (err) {
                        console.error('Error reading file:', file.fsPath, err);
                    }
                }));
                processedCount += batch.length;
                progress.report({
                    increment: (batch.length / files.length) * 100,
                    message: processedCount + " of " + files.length + " files scanned"
                });
                visualPanel.webview.postMessage({
                    command: 'scanProgress',
                    scanned: processedCount,
                    total: files.length,
                    nodeCount: nodesCache.size
                });
            }
        });

        const nodeImports = new Map();
        const nodeImportedBy = new Map();
        for (const node of nodesCache.values()) {
            nodeImports.set(node.id, []);
            nodeImportedBy.set(node.id, []);
        }

        const edges = [];
        for (const [filePath, node] of nodesCache.entries()) {
            const currentDir = path.dirname(filePath);
            const importedPaths = node.rawImports || [];
            for (const importPath of importedPaths) {
                const resolved = resolveImportPath(currentDir, importPath);
                if (resolved && nodesCache.has(resolved)) {
                    const targetFileName = path.basename(resolved);
                    nodeImports.get(node.id).push(targetFileName);
                    nodeImportedBy.get(targetFileName).push(node.id);
                    edges.push({
                        id: `edge-${node.id}-${targetFileName}`,
                        source: node.id,
                        target: targetFileName
                    });
                }
            }
        }

        const nodes = Array.from(nodesCache.values()).map(node => ({
            id: node.id,
            label: node.label,
            filePath: node.filePath,
            imports: nodeImports.get(node.id) || [],
            importedBy: nodeImportedBy.get(node.id) || []
        }));

        visualPanel.webview.postMessage({
            command: 'scanComplete',
            total: files.length,
            nodeCount: nodesCache.size
        });
        visualPanel.webview.postMessage({ command: 'renderTree', nodes, edges });
    }

    const onSaveDisposable = antigravity.workspace.onDidSaveTextDocument((doc) => {
        const lang = doc.languageId;
        if (lang === 'javascript' || lang === 'typescript' || lang === 'javascriptreact' || lang === 'typescriptreact' || lang === 'java' || lang === 'kotlin') {
            triggerIncrementalScan(doc.uri.fsPath);
        }
    });
    context.subscriptions.push(onSaveDisposable);

    visualPanel.webview.onDidReceiveMessage(async (message) => {
        switch (message.command) {
            case 'ready': {
                scanProjectWorkspace();
                break;
            }
            case 'getFileCode': {
                try {
                    const content = await fs.promises.readFile(message.filePath, 'utf8');
                    visualPanel.webview.postMessage({
                        command: 'fileCodeResponse',
                        filePath: message.filePath,
                        code: content
                    });
                } catch (error) {
                    visualPanel.webview.postMessage({
                        command: 'fileCodeResponse',
                        filePath: message.filePath,
                        code: 'Failed to read file: ' + error.message
                    });
                }
                break;
            }
            case 'openFile': {
                try {
                    const fileUri = antigravity.Uri.file(message.filePath);
                    const doc = await antigravity.workspace.openTextDocument(fileUri);
                    await antigravity.window.showTextDocument(doc, {
                        viewColumn: antigravity.ViewColumn.One,
                        preserveFocus: false
                    });
                } catch (error) {
                    antigravity.window.showErrorMessage('Failed to open file: ' + error.message);
                }
                break;
            }
            case 'referenceInChat': {
                try {
                    // Open the file in the editor to make it active context
                    const fileUri = antigravity.Uri.file(message.filePath);
                    const doc = await antigravity.workspace.openTextDocument(fileUri);
                    await antigravity.window.showTextDocument(doc, {
                        viewColumn: antigravity.ViewColumn.One,
                        preserveFocus: false
                    });

                    // Build context-rich prompt specifying file reference
                    const fileName = path.basename(message.filePath);
                    const promptText = `Referencing file @${fileName} (located at: ${message.filePath})`;
                    
                    // Open the Agent panel and send the prompt to it
                    await antigravity.commands.executeCommand('antigravity.openAgent');
                    await antigravity.commands.executeCommand('antigravity.sendPromptToAgentPanel', promptText);
                } catch (error) {
                    antigravity.window.showErrorMessage('Failed to send file reference: ' + error.message);
                }
                break;
            }
            case 'requestAIEdit': {
                try {
                    // Open the file in the editor to make it active context
                    const fileUri = antigravity.Uri.file(message.filePath);
                    const doc = await antigravity.workspace.openTextDocument(fileUri);
                    await antigravity.window.showTextDocument(doc, {
                        viewColumn: antigravity.ViewColumn.One,
                        preserveFocus: false
                    });

                    // Build context-rich prompt specifying active file
                    const promptText = `In the active file '${message.nodeId}' (located at: ${message.filePath}), please apply the following modification:\n\n${message.prompt}`;
                    
                    // Open the Agent panel and send the prompt to it
                    await antigravity.commands.executeCommand('antigravity.openAgent');
                    await antigravity.commands.executeCommand('antigravity.sendPromptToAgentPanel', promptText);
                } catch (error) {
                    antigravity.window.showErrorMessage('Failed to trigger agent: ' + error.message);
                }
                break;
            }
            case 'createNewNodeConnection': {
                const ext = message.parentPath.split('.').pop() || 'js';
                const newFileName = message.newNodeName.includes('.') ? message.newNodeName : `${message.newNodeName}.${ext}`;
                const newFilePath = path.join(path.dirname(message.parentPath), newFileName);
                const componentName = path.basename(newFileName, path.extname(newFileName));

                let isESM = false;
                try {
                    const parentContent = fs.readFileSync(message.parentPath, 'utf8');
                    isESM = parentContent.includes('import ') || parentContent.includes('export ');
                } catch (e) {
                    console.error(e);
                }

                let initialCode = '';
                const isReact = ext === 'jsx' || ext === 'tsx';
                if (isESM) {
                    if (isReact) {
                        initialCode = `import React from 'react';\n\nexport default function ${componentName}() {\n  return (\n    <div>\n      ${componentName}\n    </div>\n  );\n}\n`;
                    } else {
                        initialCode = `export default function ${componentName}() {\n  // Implement logic\n}\n`;
                    }
                } else {
                    initialCode = `// Component: ${componentName}\n\nmodule.exports = function ${componentName}() {\n  // Implement logic\n};\n`;
                }

                fs.writeFileSync(newFilePath, initialCode, 'utf8');

                try {
                    const parentUri = antigravity.Uri.file(message.parentPath);
                    const parentDoc = await antigravity.workspace.openTextDocument(parentUri);
                    let parentContent = parentDoc.getText();
                    const importLine = isESM 
                        ? `import ${componentName} from './${componentName}';\n`
                        : `const ${componentName} = require('./${componentName}');\n`;
                    if (!parentContent.includes(importLine)) {
                        parentContent = importLine + parentContent;
                        fs.writeFileSync(message.parentPath, parentContent, 'utf8');
                    }
                } catch (err) {
                    console.error('Failed to link new connection to parent file:', err);
                }

                scanProjectWorkspace();
                break;
            }
        }
    });
}

function getWebviewContent() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdn.tailwindcss.com; style-src 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src https://cdn.tailwindcss.com;">
    <title>Antigravity Component Canvas</title>
    <script src="https://cdn.jsdelivr.net/npm/react@18/umd/react.production.min.js"><\/script>
    <script src="https://cdn.jsdelivr.net/npm/react-dom@18/umd/react-dom.production.min.js"><\/script>
    <script src="https://cdn.tailwindcss.com"><\/script>
    <script src="https://cdn.jsdelivr.net/npm/reactflow@11.10.1/dist/umd/index.min.js"><\/script>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reactflow@11.10.1/dist/style.css">
    <style>
        body, html, #root { width: 100%; height: 100%; margin: 0; padding: 0; background: #0b0f19; color: #f3f4f6; overflow: hidden; font-family: monospace; }
        .react-flow__handle { background: #10b981 !important; width: 12px !important; height: 12px !important; border-radius: 50% !important; border: 3px solid #0f172a !important; }
        .react-flow__edge-path { stroke: #10b981 !important; stroke-width: 3.5px !important; }
        .react-flow__background { background: #0b0f19 !important; }
        .react-flow__minimap { background: #0f172a !important; border: 1px solid #1e293b !important; border-radius: 8px !important; }
        .react-flow__minimap-mask { fill: rgba(15, 23, 42, 0.7) !important; }
        
        /* Force hardware GPU acceleration on the canvas viewport, nodes, and edges */
        .react-flow__viewport, .react-flow__node, .react-flow__edge {
            transform: translate3d(0, 0, 0);
            will-change: transform;
            backface-visibility: hidden;
            perspective: 1000px;
        }
    </style>
</head>
<body>
    <div id="root"></div>
    <script>
        const vscode = typeof acquireAntigravityApi !== 'undefined' ? acquireAntigravityApi() : (typeof acquireVsCodeApi !== 'undefined' ? acquireVsCodeApi() : null);

        function waitForReactFlow(cb) {
            if (window.ReactFlow && window.ReactFlow.ReactFlow) {
                cb();
            } else {
                setTimeout(() => waitForReactFlow(cb), 50);
            }
        }

        waitForReactFlow(function() {
            const { useState, useEffect, useCallback, useRef, useMemo } = React;
            const { ReactFlow, Background, Controls, MiniMap, Handle, ReactFlowProvider, useReactFlow } = window.ReactFlow;

            function ComponentNode({ data }) {
                const [prompt, setPrompt] = useState('');
                const { getNode, setCenter } = useReactFlow();
                const [code, setCode] = useState(data.code || 'Click to load preview...');
                const [loading, setLoading] = useState(false);

                useEffect(() => {
                    if (data.code) {
                        setCode(data.code);
                        setLoading(false);
                    } else {
                        setCode('Click to load preview...');
                    }
                }, [data.code]);

                const loadCode = (e) => {
                    e.stopPropagation();
                    if (loading || (data.code && data.code !== 'Click to load preview...')) return;
                    setLoading(true);
                    setCode('Loading...');
                    if (vscode) {
                        vscode.postMessage({
                            command: 'getFileCode',
                            filePath: data.filePath
                        });
                    }
                };

                const focusNode = (id) => {
                    const node = getNode(id);
                    if (node) {
                        setCenter(node.position.x + 160, node.position.y + 100, { zoom: 0.4, duration: 800 });
                    }
                };

                const handleAIEdit = () => {
                    if (!prompt.trim()) return;
                    if (vscode) vscode.postMessage({
                        command: 'requestAIEdit',
                        nodeId: data.label,
                        currentCode: code,
                        filePath: data.filePath,
                        prompt: prompt
                    });
                    setPrompt('');
                };

                const handleCreateChild = () => {
                    const childName = window.prompt('Enter new component name (without extension):');
                    if (!childName) return;
                    if (vscode) vscode.postMessage({
                        command: 'createNewNodeConnection',
                        newNodeName: childName,
                        parentPath: data.filePath
                    });
                };

                const handleReferenceInChat = () => {
                    if (vscode) vscode.postMessage({
                        command: 'referenceInChat',
                        nodeId: data.label,
                        filePath: data.filePath
                    });
                };

                const handleDragStart = (e) => {
                    const fileUri = 'file://' + data.filePath;
                    e.dataTransfer.setData('text/plain', '@' + data.label);
                    e.dataTransfer.setData('text/uri-list', fileUri);
                    e.dataTransfer.effectAllowed = 'copy';
                };

                let borderClass = 'border-slate-800 hover:border-emerald-500/50';
                if (data.activeMatch) {
                     borderClass = 'border-amber-400 ring-4 ring-amber-500/50 shadow-[0_0_30px_rgba(245,158,11,0.5)] scale-[1.03]';
                } else if (data.highlighted) {
                     borderClass = 'border-emerald-400 ring-2 ring-emerald-500/40 shadow-[0_0_25px_rgba(16,185,129,0.35)]';
                }

                return React.createElement('div', {
                    className: \`relative border \${borderClass} bg-slate-900/90 backdrop-blur-md rounded-xl p-4 w-80 text-white shadow-2xl flex flex-col gap-3 transition-all cursor-pointer\`,
                    onDoubleClick: () => {
                        if (vscode) vscode.postMessage({
                            command: 'openFile',
                            filePath: data.filePath
                        });
                    }
                },
                    React.createElement(Handle, {
                        type: 'target',
                        position: 'top'
                    }),
                    React.createElement('div', { className: 'flex justify-between items-center border-b border-slate-800 pb-2' },
                        React.createElement('span', { className: 'font-mono font-bold text-emerald-400 text-sm truncate max-w-[200px]' }, data.label),
                        React.createElement('span', { className: 'text-[9px] text-slate-400 bg-slate-950 px-2 py-0.5 rounded border border-slate-800 font-semibold uppercase tracking-wider' }, 'Component')
                    ),
                    React.createElement('div', {
                        onClick: loadCode,
                        className: 'h-28 overflow-y-auto rounded bg-black/60 text-[10px] p-2 font-mono border border-slate-950 whitespace-pre scrollbar-thin scrollbar-thumb-slate-800 cursor-pointer hover:bg-black/80 transition-colors'
                    }, code),
                    React.createElement('div', { className: 'flex gap-2' },
                        React.createElement('input', {
                            type: 'text',
                            placeholder: 'Ask AI to modify...',
                            value: prompt,
                            onChange: e => setPrompt(e.target.value),
                            onKeyDown: e => e.key === 'Enter' && handleAIEdit(),
                            className: 'flex-1 bg-slate-950 text-xs text-slate-200 border border-slate-800 rounded-lg p-2 focus:outline-none focus:border-emerald-500 font-mono'
                        }),
                        React.createElement('button', {
                            onClick: handleAIEdit,
                            className: 'bg-emerald-500 hover:bg-emerald-400 text-xs text-black font-bold px-3 py-2 rounded-lg transition-colors'
                        }, 'Ask')
                    ),
                    React.createElement('button', {
                        onClick: handleCreateChild,
                        className: 'bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 font-bold px-2 py-2 rounded-lg border border-slate-700 w-full transition-all'
                    }, '+ Add Import Connection'),
                    React.createElement('button', {
                        draggable: true,
                        onDragStart: handleDragStart,
                        onClick: handleReferenceInChat,
                        className: 'bg-indigo-600 hover:bg-indigo-500 text-xs text-white font-bold px-2 py-2 rounded-lg border border-indigo-500 w-full transition-all mt-1 cursor-grab active:cursor-grabbing'
                    }, '💬 Reference (Drag to Chat)'),
                    data.imports && data.imports.length > 0 && React.createElement('div', { className: 'border-t border-slate-800 pt-2 flex flex-col gap-1' },
                        React.createElement('span', { className: 'text-[9px] text-slate-400 font-bold uppercase tracking-wider' }, 'Imports:'),
                        React.createElement('div', { className: 'flex flex-wrap gap-1' },
                            data.imports.map(imp => React.createElement('button', {
                                key: imp,
                                onClick: (e) => {
                                    e.stopPropagation();
                                    focusNode(imp);
                                },
                                className: 'text-[9px] bg-slate-950 hover:bg-emerald-500 hover:text-black text-slate-300 border border-slate-800 px-2 py-0.5 rounded transition-all truncate max-w-[120px] font-mono'
                            }, imp))
                        )
                    ),
                    data.importedBy && data.importedBy.length > 0 && React.createElement('div', { className: 'border-t border-slate-800 pt-2 flex flex-col gap-1' },
                        React.createElement('span', { className: 'text-[9px] text-slate-400 font-bold uppercase tracking-wider' }, 'Imported By:'),
                        React.createElement('div', { className: 'flex flex-wrap gap-1' },
                            data.importedBy.map(imp => React.createElement('button', {
                                key: imp,
                                onClick: (e) => {
                                    e.stopPropagation();
                                    focusNode(imp);
                                },
                                className: 'text-[9px] bg-slate-950 hover:bg-indigo-500 hover:text-white text-slate-300 border border-slate-800 px-2 py-0.5 rounded transition-all truncate max-w-[120px] font-mono'
                            }, imp))
                        )
                    ),
                    React.createElement(Handle, {
                        type: 'source',
                        position: 'bottom'
                    })
                );
            }

            function CanvasApp() {
                const [nodes, setNodes] = useState([]);
                const [edges, setEdges] = useState([]);
                const [searchQuery, setSearchQuery] = useState('');
                const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
                const [scanStats, setScanStats] = useState({ scanned: 0, total: 0, nodeCount: 0, status: 'idle' });
                const { setCenter } = useReactFlow();
                const lastMatchedIdRef = useRef(null);

                useEffect(() => {
                    const handler = event => {
                        const msg = event.data;
                        if (msg.command === 'scanProgress') {
                            setScanStats({
                                scanned: msg.scanned,
                                total: msg.total,
                                nodeCount: msg.nodeCount,
                                status: 'scanning'
                            });
                        } else if (msg.command === 'scanComplete') {
                            setScanStats({
                                scanned: msg.total,
                                total: msg.total,
                                nodeCount: msg.nodeCount,
                                status: 'complete'
                            });
                        } else if (msg.command === 'renderTree') {
                            const rawNodes = msg.nodes;
                            const rawEdges = msg.edges;

                            // Compute levels (longest path for top-to-bottom layout) in O(V + E)
                            const levels = {};
                            const visited = new Set();
                            const visiting = new Set();

                            const inEdges = {};
                            rawNodes.forEach(n => {
                                inEdges[n.id] = [];
                                levels[n.id] = 0;
                            });
                            rawEdges.forEach(edge => {
                                if (inEdges[edge.target]) {
                                    inEdges[edge.target].push(edge.source);
                                }
                            });

                            function computeLevel(nodeId) {
                                if (visited.has(nodeId)) {
                                    return levels[nodeId];
                                }
                                if (visiting.has(nodeId)) {
                                    return 0; // cycle
                                }
                                visiting.add(nodeId);
                                let maxParentLevel = -1;
                                const parents = inEdges[nodeId] || [];
                                for (const parent of parents) {
                                    maxParentLevel = Math.max(maxParentLevel, computeLevel(parent));
                                }
                                visiting.delete(nodeId);
                                visited.add(nodeId);
                                levels[nodeId] = maxParentLevel + 1;
                                return levels[nodeId];
                            }

                            rawNodes.forEach(n => {
                                computeLevel(n.id);
                            });

                            // Group nodes by level
                            const nodesByLevel = {};
                            rawNodes.forEach(n => {
                                const lvl = levels[n.id] || 0;
                                if (!nodesByLevel[lvl]) nodesByLevel[lvl] = [];
                                nodesByLevel[lvl].push(n);
                            });

                            // Calculate positions
                            const flowNodes = [];
                            const levelYGap = 350;
                            const nodeXGap = 360;

                            Object.keys(nodesByLevel).forEach(lvlStr => {
                                const lvl = parseInt(lvlStr);
                                const levelNodes = nodesByLevel[lvl];
                                const totalWidth = (levelNodes.length - 1) * nodeXGap;
                                const startX = -totalWidth / 2;

                                levelNodes.forEach((n, idx) => {
                                    flowNodes.push({
                                        id: n.id,
                                        type: 'componentNode',
                                        position: {
                                            x: startX + idx * nodeXGap + 400,
                                            y: 100 + lvl * levelYGap
                                        },
                                        data: { label: n.label, code: n.code, filePath: n.filePath, imports: n.imports || [], importedBy: n.importedBy || [] }
                                    });
                                });
                            });

                            setNodes(prevNodes => {
                                const codeMap = new Map();
                                prevNodes.forEach(pn => {
                                    if (pn.data && pn.data.code) {
                                        codeMap.set(pn.data.filePath, pn.data.code);
                                    }
                                });

                                return flowNodes.map(fn => {
                                    const cachedCode = codeMap.get(fn.data.filePath);
                                    if (cachedCode) {
                                        fn.data.code = cachedCode;
                                    }
                                    return fn;
                                });
                            });

                            setEdges(rawEdges.map(e => ({
                                id: e.id,
                                source: e.source,
                                target: e.target,
                                animated: true
                            })));
                            setScanStats(prev => ({
                                ...prev,
                                status: 'complete'
                            }));
                        } else if (msg.command === 'fileCodeResponse') {
                            setNodes(prevNodes => prevNodes.map(n => {
                                if (n.data.filePath === msg.filePath) {
                                    return {
                                        ...n,
                                        data: {
                                            ...n.data,
                                            code: msg.code
                                        }
                                    };
                                }
                                return n;
                            }));
                        } else if (msg.command === 'errorNotify') {
                            alert('AI Error: ' + msg.msg);
                        }
                    };
                    window.addEventListener('message', handler);

                    // Notify the extension that webview is mounted and ready for data
                    if (vscode) {
                        vscode.postMessage({ command: 'ready' });
                    }

                    return () => window.removeEventListener('message', handler);
                }, []);

                const matchedNodes = useMemo(() => {
                    const query = searchQuery.trim().toLowerCase();
                    return query
                        ? nodes.filter(n => n.data.label.toLowerCase().includes(query))
                        : [];
                }, [searchQuery, nodes]);

                useEffect(() => {
                    setCurrentMatchIndex(0);
                }, [searchQuery]);

                useEffect(() => {
                    if (matchedNodes.length > 0) {
                        const index = Math.min(Math.max(0, currentMatchIndex), matchedNodes.length - 1);
                        const activeNode = matchedNodes[index];
                        if (activeNode) {
                            setCenter(activeNode.position.x + 160, activeNode.position.y + 100, { zoom: 0.5, duration: 600 });
                        }
                    }
                }, [currentMatchIndex, matchedNodes, setCenter]);

                const filteredNodes = nodes.map(n => {
                    const matches = searchQuery !== '' && n.data.label.toLowerCase().includes(searchQuery.toLowerCase());
                    const isActiveMatch = matchedNodes[currentMatchIndex] && matchedNodes[currentMatchIndex].id === n.id;
                    return {
                        ...n,
                        data: {
                            ...n.data,
                            highlighted: matches,
                            activeMatch: isActiveMatch
                        },
                        style: {
                            ...n.style,
                            opacity: searchQuery === '' || matches ? 1 : 0.3,
                            transition: 'opacity 0.2s ease-in-out'
                        }
                    };
                });

                return React.createElement('div', { style: { width: '100vw', height: '100vh', position: 'relative' } },
                    React.createElement('div', { className: 'absolute top-4 left-4 z-50 flex flex-col gap-2 bg-slate-900/95 backdrop-blur-md border border-slate-800 p-3 rounded-xl shadow-2xl min-w-[320px]' },
                        React.createElement('div', { className: 'flex justify-between items-center text-[10px] font-mono text-slate-400 border-b border-slate-800 pb-2 mb-1' },
                            React.createElement('span', { className: 'flex items-center gap-1 font-semibold' },
                                scanStats.status === 'scanning'
                                    ? React.createElement('span', { className: 'flex items-center gap-1.5 text-sky-400' },
                                        React.createElement('span', { className: 'w-2 h-2 rounded-full bg-sky-400 animate-pulse' }),
                                        'Scanning: ' + scanStats.scanned + '/' + scanStats.total
                                      )
                                    : React.createElement('span', { className: 'text-emerald-400 flex items-center gap-1' },
                                        React.createElement('span', { className: 'w-2 h-2 rounded-full bg-emerald-500' }),
                                        'System Online'
                                      )
                            ),
                            React.createElement('div', { className: 'flex gap-2' },
                                React.createElement('span', {}, 'Files: ' + (scanStats.total || 0)),
                                React.createElement('span', { className: 'text-slate-500' }, '|'),
                                React.createElement('span', {}, 'Nodes: ' + (scanStats.nodeCount || 0))
                            )
                        ),
                        React.createElement('div', { className: 'flex gap-2' },
                            React.createElement('input', {
                                type: 'text',
                                placeholder: 'Search components...',
                                value: searchQuery,
                                onChange: e => setSearchQuery(e.target.value),
                                className: 'flex-1 bg-slate-950 text-xs text-slate-200 border border-slate-800 rounded-lg px-3 py-2 focus:outline-none focus:border-emerald-500 font-mono'
                            }),
                            searchQuery && React.createElement('button', {
                                onClick: () => setSearchQuery(''),
                                className: 'text-xs text-slate-400 hover:text-white px-2 font-mono'
                            }, 'Clear')
                        ),
                        searchQuery && React.createElement('div', { className: 'flex justify-between items-center text-xs mt-1 border-t border-slate-800/60 pt-2 font-mono' },
                            React.createElement('span', { className: 'text-slate-400 text-[11px]' },
                                matchedNodes.length > 0
                                    ? 'Found ' + matchedNodes.length + ' results'
                                    : 'No results found'
                            ),
                            matchedNodes.length > 0 && React.createElement('div', { className: 'flex items-center gap-2' },
                                React.createElement('span', { className: 'text-emerald-400 text-[11px] mr-1' },
                                    (currentMatchIndex + 1) + ' of ' + matchedNodes.length
                                ),
                                React.createElement('button', {
                                    onClick: () => setCurrentMatchIndex(prev => (prev - 1 + matchedNodes.length) % matchedNodes.length),
                                    className: 'bg-slate-800 hover:bg-slate-700 text-[10px] text-slate-300 font-bold px-2 py-1 rounded transition-colors border border-slate-750'
                                }, '◀ Prev'),
                                React.createElement('button', {
                                    onClick: () => setCurrentMatchIndex(prev => (prev + 1) % matchedNodes.length),
                                    className: 'bg-slate-800 hover:bg-slate-700 text-[10px] text-slate-300 font-bold px-2 py-1 rounded transition-colors border border-slate-750'
                                }, 'Next ▶')
                            )
                        )
                    ),
                    React.createElement(ReactFlow, {
                        nodes: filteredNodes,
                        edges,
                        nodeTypes: { componentNode: ComponentNode },
                        fitView: true,
                        fitViewOptions: { padding: 1.5, minZoom: 0.1, maxZoom: 0.5 },
                        panOnScroll: true,
                        zoomOnPinch: true
                    },
                        React.createElement(Background, { color: '#1e293b', gap: 16 }),
                        React.createElement(Controls, { className: 'bg-slate-900 border border-slate-800 text-white rounded shadow-lg' }),
                        React.createElement(MiniMap, { className: 'bg-slate-900 border border-slate-800 rounded shadow-lg' })
                    )
                );
            }

            const root = ReactDOM.createRoot(document.getElementById('root'));
            root.render(
                React.createElement(ReactFlowProvider, null,
                    React.createElement(CanvasApp)
                )
            );
        });
    <\/script>
</body>
</html>`;
}

module.exports = {
    activate
};

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


    const canvasHtmlPath = path.join(context.extensionPath, 'canvas.html');
    visualPanel.webview.html = fs.readFileSync(canvasHtmlPath, 'utf8');

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

module.exports = {
    activate
};

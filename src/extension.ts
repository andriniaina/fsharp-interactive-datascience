import * as path from 'path';
import * as vscode from 'vscode';
import { isNullOrUndefined, TextEncoder } from 'util';

export async function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(
		vscode.commands.registerCommand('notebookPanel.open', () => {
			NotebookPanel.createOrShow(context.extensionPath);
		})
	);

	vscode.commands.registerCommand('notebookPanel.export', async () => {
		if (NotebookPanel.currentPanel) {
			await NotebookPanel.currentPanel.Export();
		}
	});

	vscode.commands.registerCommand('notebookPanel.clear', async () => {
		if (NotebookPanel.currentPanel) {
			await NotebookPanel.currentPanel.Clear();
		}
	});

	if (vscode.window.registerWebviewPanelSerializer) {
		vscode.window.registerWebviewPanelSerializer(NotebookPanel.viewType, {
			async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel, state: any) {
				NotebookPanel.revive(webviewPanel, context.extensionPath);
			}
		});
	}

	if (!isNullOrUndefined(vscode.workspace.rootPath)) {
		const uri = vscode.Uri.file(
			path.join(vscode.workspace.rootPath, "cache/notebook")
		);

		await vscode.workspace.fs.createDirectory(uri).then(async () => {

			let fileSystemWatcher = vscode.workspace.createFileSystemWatcher('**/cache/notebook/*.{svg,html,md,txt}');

			fileSystemWatcher.onDidCreate(async (filePath) => {
				if (NotebookPanel.currentPanel) {
					await NotebookPanel.currentPanel.Watch(filePath);
				}
			});

			context.subscriptions.push(fileSystemWatcher);
		});
	}
}

class NotebookPanel {
	public static currentPanel: NotebookPanel | undefined;

	public static readonly viewType = 'notebookPanel';

	private readonly _panel: vscode.WebviewPanel;
	private readonly _extensionPath: string;
	private _disposables: vscode.Disposable[] = [];

	public static createOrShow(extensionPath: string) {
		const column = vscode.window.activeTextEditor
			? vscode.window.activeTextEditor.viewColumn
			: undefined;

		if (NotebookPanel.currentPanel) {
			NotebookPanel.currentPanel._panel.reveal(column);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			NotebookPanel.viewType,
			'Notebook',
			{ 
				preserveFocus: true, 
				viewColumn: vscode.ViewColumn.Beside
			},
			{
				enableScripts: true,
				localResourceRoots: [
					vscode.Uri.file(path.join(vscode.env.appRoot, 'extensions', 'markdown-language-features')),
					vscode.Uri.file(path.join(extensionPath, 'media'))
				]
			}
		);

		NotebookPanel.currentPanel = new NotebookPanel(panel, extensionPath);
	}

	public static revive(panel: vscode.WebviewPanel, extensionPath: string) {
		NotebookPanel.currentPanel = new NotebookPanel(panel, extensionPath);
	}

	private constructor(panel: vscode.WebviewPanel, extensionPath: string) {
		this._panel = panel;
		this._extensionPath = extensionPath;

		this._panel.webview.html = this._getHtml();

		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

		this._panel.webview.onDidReceiveMessage(
			async message => {
				switch (message.command) {
					case 'remove':

						if (!isNullOrUndefined(vscode.workspace.rootPath)) {
							const uri = vscode.Uri.file(
								path.join(vscode.workspace.rootPath, 'Notebook', message.id)
							);
							
							await vscode.workspace.fs.delete(uri);
						}

						return;

					case 'export':

						if (!isNullOrUndefined(vscode.workspace.rootPath)) {

							const styles : string[] = [];

							const exportStyles = vscode.workspace.getConfiguration('fsharpnotebook').get<string[]>('exportStyles', []);
							if (exportStyles.length > 0) {
								for (const sheet of exportStyles) {
									styles.push((await vscode.workspace.fs.readFile(vscode.Uri.file(sheet))).toString());
								}
							}
							else {
								const sheet = vscode.Uri.file(
									path.join(this._extensionPath, 'media', 'css', 'export.css')
								);

								styles.push((await vscode.workspace.fs.readFile(sheet)).toString());
							}

							const content = (message.content as string).replace('$style', styles.join('\n'));

							const uri = vscode.Uri.file(
								path.join(vscode.workspace.rootPath, message.file)
							);

							await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
						}

						return;
				}
			},
			null,
			this._disposables
		);
	}

	public async Watch(filePath : vscode.Uri) {
		
		await vscode.workspace.fs.readFile(filePath).then(async o => {

			let content = o.toString();
			if (content.length === 0) {
				return;
			}

			let type = "";

			const ext = path.extname(filePath.path);
			switch(ext)
			{
				case '.svg':
					type = 'svg';
					break;

				case '.html':
					type = 'html';
					break;

				case '.md':
					type = 'md';
					await vscode.commands.executeCommand('markdown.api.render', content).then(md => {
						content = md as string;
					});
					break;

				case '.txt':
					type = 'txt';
					break;

				default:
					return;
			}

			await this._panel.webview.postMessage({ 
				command: 'append', 
				id: path.basename(filePath.path),
				type: type,
				content: content 
			});
			if(ext == '.md') {
				await this._panel.webview.postMessage({ 
					command: 'mathjax_typeset'
				});
			}
		});
	}
	
	private _getHtml() {

		const webview = this._panel.webview;

		const previewStyles = vscode.extensions
			.getExtension('vscode.markdown-language-features')
			?.packageJSON['contributes']['markdown.previewStyles'];

		const styles : string[] = [];

		for (const sheet of previewStyles) {

			const uri = this._panel.webview.asWebviewUri(vscode.Uri.file(
				path.join(vscode.env.appRoot, 'extensions', 'markdown-language-features', sheet)
			));

			styles.push(`<link rel="stylesheet" type="text/css" href="${uri}">`);
		}

		const codicon = webview.asWebviewUri(vscode.Uri.file(
			path.join(this._extensionPath, 'media', 'css', 'codicon', 'codicon.css')
		));

		styles.push(`<link rel="stylesheet" type="text/css" href="${codicon}">`);

		const customStyles = vscode.workspace.getConfiguration('fsharpnotebook').get<string[]>('styles', []);
		if (customStyles.length > 0) {
			for (const sheet of customStyles) {
				const uri = webview.asWebviewUri(vscode.Uri.file(sheet));
				styles.push(`<link rel="stylesheet" type="text/css" href="${uri}">`);
			}
		}
		else {
			const main = webview.asWebviewUri(vscode.Uri.file(
				path.join(this._extensionPath, 'media', 'css', 'main.css')
			));

			styles.push(`<link rel="stylesheet" type="text/css" href="${main}">`);
		}

		const script = webview.asWebviewUri(vscode.Uri.file(
			path.join(this._extensionPath, 'media', 'js', 'main.js')
		));

		return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			${styles.join('\n')}
			<title>Notebook</title>
			<script src="https://polyfill.io/v3/polyfill.min.js?features=es6"></script>
			<script src='https://cdn.plot.ly/plotly-latest.min.js'></script>
			<script src="https://code.jquery.com/jquery-3.5.1.min.js"></script>
<script>
MathJax = {
  tex: {
    inlineMath: [['$', '$'], ['\\(', '\\)']]
  },
  svg: {
    fontCache: 'global'
  }
};
</script>
			<script id="MathJax-script" async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js"></script>
			</head>
		<body>
			<div id="cells"></div>
			<script src="${script}"></script>
		</body>
		</html>`;
	}

	public async Export() {
		await vscode.window.showInputBox({ prompt: 'Export Notebook', value: 'notebook.html' }).then(async fn => {
			if (!isNullOrUndefined(fn)) {
				await this._panel.webview.postMessage({ 
					command: 'export', 
					file: fn
				});
			}
		});
	}

	public async Clear() {
		await this._panel.webview.postMessage({ 
			command: 'clear'
		});
	}

	public dispose() {
		NotebookPanel.currentPanel = undefined;

		this._panel.dispose();

		while (this._disposables.length) {
			const x = this._disposables.pop();
			if (x) {
				x.dispose();
			}
		}
	}
}
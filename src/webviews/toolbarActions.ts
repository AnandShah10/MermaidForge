import * as vscode from 'vscode';

/**
 * Buttons in the diagram webviews' toolbar are plain messages; this maps them onto the same commands the Command
 * Palette has, so there is one implementation of each feature. `from` names the panel the click came from, so Export
 * reads that panel's rendering.
 */
export async function runToolbarAction(action: string, format: string | undefined, from: string): Promise<void> {
  switch (action) {
    case 'openViewer':
      await vscode.commands.executeCommand('mermaidForge.openViewer');
      break;
    case 'openPreview':
      await vscode.commands.executeCommand('mermaidForge.openPreview');
      break;
    case 'present':
      await vscode.commands.executeCommand('mermaidForge.presentationMode');
      break;
    case 'studio':
      await vscode.commands.executeCommand('mermaidForge.openStudio');
      break;
    case 'export':
      await vscode.commands.executeCommand('mermaidForge.exportDiagram', { format, from });
      break;
    case 'comment':
      await vscode.commands.executeCommand('mermaidForge.comments.add');
      break;
    case 'returnToCode':
      await vscode.commands.executeCommand('mermaidForge.returnToCode');
      break;
    default:
      break;
  }
}

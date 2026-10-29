import * as vscode from 'vscode';

export class Logger {
  constructor(private readonly channel: vscode.OutputChannel) {}

  info(message: string): void {
    this.channel.appendLine(`[info] ${message}`);
  }

  warn(message: string): void {
    this.channel.appendLine(`[warn] ${message}`);
  }

  error(message: string, err?: unknown): void {
    this.channel.appendLine(`[error] ${message}${err ? `: ${err instanceof Error ? err.message : String(err)}` : ''}`);
  }
}

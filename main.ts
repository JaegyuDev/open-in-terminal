import * as os from 'os';
import * as path from 'path';
import { exec } from 'child_process';
import { App, Plugin, TFolder, Menu, Notice, PluginSettingTab, Setting, FileSystemAdapter } from 'obsidian';
import { Option, some, none, getOrElse, map, fold } from 'fp-ts/lib/Option';
import { pipe } from 'fp-ts/function';
import { Either, left, right, fold as eitherFold } from 'fp-ts/lib/Either';
import { warn } from 'console';
import { option } from 'fp-ts';

interface PluginSettings {
    terminalBin: Option<string>;
    terminalArgs: Option<string>;
}

const DEFAULT_SETTINGS: PluginSettings = {
    terminalBin: none,
    terminalArgs: none
};

type TerminalCommand = {
    binary: string;
    args: string[];
};

function inferTerminalCommand(): Either<string, TerminalCommand> {
    const platform = os.platform();

    switch (platform) {
        case 'win32':
            return right({
                binary: 'powershell.exe',
                args: ['-noexit']
            });
        case 'darwin':
            return right({
                binary: 'Terminal',
                args: []
            });
        case 'linux':
            return right({
                binary: 'gnome-terminal',
                args: ['--working-directory']
            });
        default:
            return left(`Unsupported platform: ${platform}`);
    }
}

function createTerminalCommand(
    settings: PluginSettings,
    folderPath: string
): Either<string, string> {
    return pipe(
        settings.terminalBin,
        fold(
            // If no custom terminal is set, infer from OS
            () => pipe(
                inferTerminalCommand(),
                eitherFold(
                    (error) => left(error),
                    (termCmd) => {
                        const platform = os.platform();
                        const quotedPath = `"${folderPath}"`;

                        switch (platform) {
                            case 'win32':
                                // Fixed: Use start /d properly with quoted path
                                return right(`start /d ${quotedPath} ${termCmd.binary} ${termCmd.args.join(' ')}`);
                            case 'darwin':
                                // Fixed: Use proper macOS command
                                return right(`open -a ${termCmd.binary} ${quotedPath}`);
                            case 'linux':
                                // Fixed: Simpler Linux command
                                return right(`${termCmd.binary} ${termCmd.args.join(' ')}=${quotedPath}`);
                            default:
                                return left('Unsupported platform');
                        }
                    }
                )
            ),
            // If custom terminal is set, use it
            (customTerminal) => {
                console.warn("Using custom terminal:", customTerminal);
                const quotedPath = `"${folderPath}"`;
                const quotedTerminal = `"${customTerminal}"`;

                // Get custom args if provided
                const customArgs = pipe(
                    settings.terminalArgs,
                    getOrElse(() => '')
                );

                // Replace {path} placeholder in custom args with actual path
                const processedArgs = customArgs.replace(/\{path\}/g, quotedPath);

                // If custom args are provided, use them directly (user has full control)
                if (customArgs.trim() !== '') {
                    return right(`${quotedTerminal} ${processedArgs}`);
                }

                // Otherwise, use platform defaults with custom terminal
                const platform = os.platform();
                switch (platform) {
                    case 'win32':
                        return right(`start /d ${quotedPath} ${quotedTerminal}`);
                    case 'darwin':
                        return right(`open -a ${quotedTerminal} ${quotedPath}`);
                    case 'linux':
                        return right(`${quotedTerminal} --working-directory=${quotedPath}`);
                    default:
                        return left('Unsupported platform');
                }
            }
        )
    );
}

export default class OpenInTerminalPlugin extends Plugin {
    settings: PluginSettings;

    async onload() {
        await this.loadSettings();
        console.log('Loading Open in Terminal plugin');

        // Register the context menu event
        this.registerEvent(
            this.app.workspace.on('file-menu', (menu: Menu, file: TFolder) => {
                // Only add menu item for folders
                if (file instanceof TFolder) {
                    menu.addItem((item) => {
                        item
                            .setTitle('Open in Terminal')
                            .setIcon('terminal')
                            .onClick(() => {
                                this.openTerminalInFolder(file);
                            });
                    });
                }
            })
        );

        // Add command for opening terminal in current vault root
        this.addCommand({
            id: 'open-terminal-vault-root',
            name: 'Open Terminal in Vault Root',
            callback: () => {
                const adapter = this.app.vault.adapter;
                if (adapter instanceof FileSystemAdapter) {
                    try {
                        const basePath = adapter.getBasePath();
                        if (basePath) {
                            this.openTerminalInPath(basePath);
                        } else {
                            new Notice('Could not determine vault path.');
                        }
                    } catch (error) {
                        console.error('Error getting vault path:', error);
                        new Notice('Could not determine vault path.');
                    }
                }
            }
        });

        // Add settings tab
        this.addSettingTab(new TerminalSettingTab(this.app, this));
    }

    onunload() {
        console.log('Unloading Open in Terminal plugin');
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    private openTerminalInFolder(folder: TFolder) {
        const adapter = this.app.vault.adapter;
        if (adapter instanceof FileSystemAdapter) {
            try {
                const vaultPath = adapter.getBasePath();
                if (vaultPath) {
                    const folderPath = path.join(vaultPath, folder.path);
                    this.openTerminalInPath(folderPath);
                } else {
                    new Notice('Could not determine vault path.');
                }
            } catch (error) {
                console.error('Error getting folder path:', error);
                new Notice('Could not determine folder path.');
            }
        }
    }

    private openTerminalInPath(folderPath: string) {
        console.log('Opening terminal in path:', folderPath);

        pipe(
            createTerminalCommand(this.settings, folderPath),
            eitherFold(
                (error) => {
                    console.error('Error creating terminal command:', error);
                    new Notice(`Failed to create terminal command: ${error}`);
                },
                (command) => {
                    console.log('Executing command:', command);
                    exec(command, (error, stdout, stderr) => {
                        if (error) {
                            console.error('Error opening terminal:', error);
                            console.error('Command that failed:', command);
                            if (stderr) console.error('stderr:', stderr);
                            new Notice(`Failed to open terminal: ${error.message}`);
                        } else {
                            console.log('Terminal opened successfully');
                            if (stdout) console.log('stdout:', stdout);
                            new Notice('Terminal opened successfully');
                        }
                    });
                }
            )
        );
    }
}

class TerminalSettingTab extends PluginSettingTab {
    plugin: OpenInTerminalPlugin;

    constructor(app: App, plugin: OpenInTerminalPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Terminal Settings' });

        new Setting(containerEl)
            .setName('Custom Terminal Path')
            .setDesc('Specify a custom terminal application. Leave empty to use system default.')
            .addText(text => text
                .setPlaceholder('e.g., /usr/bin/gnome-terminal')
                .setValue(pipe(
                    this.plugin.settings.terminalBin,
                    getOrElse(() => '')
                ))
                .onChange(async (value) => {
                    this.plugin.settings.terminalBin = value.trim() === '' ? none : some(value.trim());
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Custom Terminal Arguments')
            .setDesc('Arguments to pass to your custom terminal. Use {path} as placeholder for the folder path. Leave empty for platform defaults.')
            .addTextArea(text => text
                .setPlaceholder('e.g., --working-directory={path} --title="Obsidian Terminal"')
                .setValue(pipe(
                    this.plugin.settings.terminalArgs,
                    getOrElse(() => '')
                ))
                .onChange(async (value) => {
                    this.plugin.settings.terminalArgs = value.trim() === '' ? none : some(value.trim());
                    await this.plugin.saveSettings();
                }));

        // Show current inferred terminal
        const inferredTerminal = pipe(
            inferTerminalCommand(),
            eitherFold(
                (error) => `Error: ${error}`,
                (termCmd) => `${termCmd.binary} (with args: ${termCmd.args.join(' ')})`
            )
        );

        containerEl.createEl('p', {
            text: `System default terminal: ${inferredTerminal}`,
            attr: { style: 'color: var(--text-muted); font-size: 0.9em; margin-top: 10px;' }
        });
    }
}
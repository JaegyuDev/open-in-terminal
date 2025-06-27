import * as os from 'os';
import * as path from 'path';
import { exec } from 'child_process';
import { App, Plugin, TFolder, Menu, Notice, PluginSettingTab, Setting } from 'obsidian';
import { Option, some, none, getOrElse, map, fold } from 'fp-ts/lib/Option';
import { pipe } from 'fp-ts/function';
import { Either, left, right, fold as eitherFold } from 'fp-ts/lib/Either';

interface PluginSettings {
    terminalBin: Option<string>;
}

const DEFAULT_SETTINGS: PluginSettings = {
    terminalBin: none
};

type TerminalCommand = {
    command: string;
    args: string[];
};

function inferTerminalCommand(): Either<string, TerminalCommand> {
    const platform = os.platform();

    switch (platform) {
        case 'win32':
            return right({
                command: 'start powershell.exe',
                args: []
            });
        case 'darwin':
            return right({
                command: 'open',
                args: ['-a', 'Terminal']
            });
        case 'linux':
            // Try to find available terminal emulators
            const linuxTerminals = [
                'gnome-terminal',
                'konsole',
                'xfce4-terminal',
                'mate-terminal',
                'terminator',
                'alacritty',
                'kitty',
                'xterm'
            ];

            // For now, default to gnome-terminal with fallback
            return right({
                command: 'gnome-terminal',
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
                        switch (platform) {
                            case 'win32':
                                return right(`${termCmd.command} ${termCmd.args.join(' ')} "cd /d \\"${folderPath}\\""`);
                            case 'darwin':
                                return right(`${termCmd.command} ${termCmd.args.join(' ')} "${folderPath}"`);
                            case 'linux':
                                return right(`${termCmd.command} ${termCmd.args.join(' ')}="${folderPath}"`);
                            default:
                                return left('Unsupported platform');
                        }
                    }
                )
            ),
            // If custom terminal is set, use it
            (customTerminal) => {
                const platform = os.platform();
                switch (platform) {
                    case 'win32':
                        return right(`"${customTerminal}"`);
                    case 'darwin':
                        return right(`open -a "${customTerminal}" "${folderPath}"`);
                    case 'linux':
                        return right(`"${customTerminal}" --working-directory="${folderPath}"`);
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
                // @ts-ignore - Obsidian's FileSystemAdapter has a path property
                const vaultPath = this.app.vault.adapter.path || '';
                this.openTerminalInPath(vaultPath);
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
        // @ts-ignore - Obsidian's FileSystemAdapter has a path property
        const vaultPath = this.app.vault.adapter.path || '';
        const folderPath = path.join(vaultPath, folder.path);
        this.openTerminalInPath(folderPath);
    }

    private openTerminalInPath(folderPath: string) {
        pipe(
            createTerminalCommand(this.settings, folderPath),
            eitherFold(
                (error) => {
                    console.error('Error creating terminal command:', error);
                    new Notice(`Failed to create terminal command: ${error}`);
                },
                (command) => {
                    exec(command, (error) => {
                        if (error) {
                            console.error('Error opening terminal:', error);
                            new Notice(`Failed to open terminal: ${error.message}`);
                        } else {
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

        // Show current inferred terminal
        const inferredTerminal = pipe(
            inferTerminalCommand(),
            eitherFold(
                (error) => `Error: ${error}`,
                (termCmd) => `${termCmd.command} (with args: ${termCmd.args.join(' ')})`
            )
        );

        containerEl.createEl('p', {
            text: `System default terminal: ${inferredTerminal}`,
            attr: { style: 'color: var(--text-muted); font-size: 0.9em; margin-top: 10px;' }
        });
    }
}
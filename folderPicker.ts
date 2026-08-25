import { execFile } from 'child_process';

export class FolderPickerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FolderPickerUnavailableError';
  }
}

interface FolderPickerCommand {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

const windowsPickerScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
$dialog = [System.Windows.Forms.FolderBrowserDialog]::new()
$dialog.Description = 'Choose where downloaded books will be saved'
$dialog.ShowNewFolderButton = $true
$initialPath = $env:ANNA_FOLDER_PICKER_INITIAL
if ($initialPath -and (Test-Path -LiteralPath $initialPath -PathType Container)) {
  $dialog.SelectedPath = $initialPath
}
$owner = [System.Windows.Forms.Form]::new()
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.WindowState = [System.Windows.Forms.FormWindowState]::Minimized
try {
  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Out.Write($dialog.SelectedPath)
  }
} finally {
  $dialog.Dispose()
  $owner.Dispose()
}
`;

const macPickerScript = String.raw`
on run argv
  try
    set initialFolder to POSIX file (item 1 of argv)
    return POSIX path of (choose folder with prompt "Choose where downloaded books will be saved" default location initialFolder)
  on error number -128
    return ""
  end try
end run
`;

export function folderPickerSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' || platform === 'darwin' || platform === 'linux';
}

export function createFolderPickerCommand(
  initialPath: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): FolderPickerCommand {
  if (platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(windowsPickerScript, 'utf16le').toString('base64')],
      env: { ...environment, ANNA_FOLDER_PICKER_INITIAL: initialPath },
    };
  }
  if (platform === 'darwin') {
    return { file: 'osascript', args: ['-e', macPickerScript, initialPath], env: environment };
  }
  if (platform === 'linux') {
    const startingDirectory = initialPath.endsWith('/') ? initialPath : `${initialPath}/`;
    return {
      file: 'zenity',
      args: ['--file-selection', '--directory', '--title=Choose download destination', `--filename=${startingDirectory}`],
      env: environment,
    };
  }
  throw new FolderPickerUnavailableError(`Folder browsing is not supported on ${platform}. Enter the path manually instead.`);
}

export function normalizeFolderPickerOutput(output: string): string | null {
  const selectedPath = output.replace(/\0/g, '').replace(/[\r\n]+$/g, '');
  return selectedPath.length ? selectedPath : null;
}

function executePicker(command: FolderPickerCommand): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command.file, command.args, {
      encoding: 'utf8',
      env: command.env,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

export async function chooseFolder(initialPath: string): Promise<string | null> {
  const command = createFolderPickerCommand(initialPath);
  try {
    return normalizeFolderPickerOutput(await executePicker(command));
  } catch (error) {
    const processError = error as NodeJS.ErrnoException;
    const errorCode: unknown = processError.code;
    // Zenity exits with status 1 when its dialog is cancelled.
    if (process.platform === 'linux' && errorCode === 1) return null;
    if (errorCode === 'ENOENT') {
      throw new FolderPickerUnavailableError(
        process.platform === 'linux'
          ? 'The native folder picker requires Zenity. Install it or enter the path manually.'
          : 'The operating system folder picker could not be started. Enter the path manually.',
      );
    }
    throw error;
  }
}

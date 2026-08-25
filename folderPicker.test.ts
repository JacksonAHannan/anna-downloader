import { describe, expect, it } from '@jest/globals';
import { FolderPickerUnavailableError, createFolderPickerCommand, folderPickerSupported, normalizeFolderPickerOutput } from './folderPicker';

describe('native folder picker', () => {
  it('passes the initial Windows folder through the environment instead of interpolating it into code', () => {
    const initialPath = String.raw`D:\Books & Notes\It's complicated`;
    const command = createFolderPickerCommand(initialPath, 'win32', {});
    expect(command.file).toBe('powershell.exe');
    expect(command.args).toContain('-EncodedCommand');
    expect(command.args.join(' ')).not.toContain(initialPath);
    expect(command.env.ANNA_FOLDER_PICKER_INITIAL).toBe(initialPath);
  });

  it('normalizes only process line endings and preserves spaces in folder names', () => {
    expect(normalizeFolderPickerOutput('D:\\Books with spaces\r\n')).toBe('D:\\Books with spaces');
    expect(normalizeFolderPickerOutput('')).toBeNull();
  });

  it('supports the major desktop platforms and rejects unsupported platforms', () => {
    expect(folderPickerSupported('win32')).toBe(true);
    expect(folderPickerSupported('darwin')).toBe(true);
    expect(folderPickerSupported('linux')).toBe(true);
    expect(folderPickerSupported('aix')).toBe(false);
    expect(() => createFolderPickerCommand('/tmp', 'aix')).toThrow(FolderPickerUnavailableError);
  });
});

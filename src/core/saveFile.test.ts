import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  native: { value: false },
  check: { value: { publicStorage: 'granted' } as Record<string, string> },
  request: { value: { publicStorage: 'granted' } as Record<string, string> },
  write: vi.fn(async (_options: { data: string }) => ({ uri: 'file:///documents/PharmaReader/x' })),
  append: vi.fn(async (_options: { data: string }) => undefined),
  deleteFile: vi.fn(async (_options: { path: string }) => undefined),
  checkCalls: { value: 0 },
  requestCalls: { value: 0 },
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => h.native.value },
}));

vi.mock('@capacitor/filesystem', () => ({
  Directory: { Documents: 'DOCUMENTS' },
  Filesystem: {
    checkPermissions: async () => {
      h.checkCalls.value += 1;
      return h.check.value;
    },
    requestPermissions: async () => {
      h.requestCalls.value += 1;
      return h.request.value;
    },
    writeFile: h.write,
    appendFile: h.append,
    deleteFile: h.deleteFile,
  },
}));

const { saveFile, base64Of, CHUNK_BYTES, SAVE_DIR } = await import('./saveFile');

function decode(data: unknown): Buffer {
  return Buffer.from(String(data), 'base64');
}

let click: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  h.native.value = false;
  h.check.value = { publicStorage: 'granted' };
  h.request.value = { publicStorage: 'granted' };
  h.checkCalls.value = 0;
  h.requestCalls.value = 0;
  h.write.mockClear();
  h.append.mockClear();
  h.deleteFile.mockClear();
  click = vi.fn<() => void>();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(click);
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: () => 'blob:test' });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: () => undefined });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('base64Of', () => {
  it('encodes empty, partial and complete groups', () => {
    expect(base64Of(new Uint8Array([]))).toBe('');
    expect(base64Of(new Uint8Array([0x66]))).toBe('Zg==');
    expect(base64Of(new Uint8Array([0x66, 0x6f]))).toBe('Zm8=');
    expect(base64Of(new Uint8Array([0x66, 0x6f, 0x6f]))).toBe('Zm9v');
  });
});

describe('saveFile (web)', () => {
  it('downloads through an anchor and reports the Downloads folder', async () => {
    const result = await saveFile(new Blob(['hello']), 'notes.md');
    expect(result).toEqual({ location: 'your Downloads folder' });
    expect(click).toHaveBeenCalledTimes(1);
    const link = click.mock.contexts[0] as HTMLAnchorElement;
    expect(link.download).toBe('notes.md');
    expect(h.write).not.toHaveBeenCalled();
  });

  it('strips characters a file name cannot hold', async () => {
    await saveFile(new Blob(['x']), '../a:b*c?.zip');
    const link = click.mock.contexts[0] as HTMLAnchorElement;
    expect(link.download).toBe('-a-b-c-.zip');
  });
});

describe('saveFile (native)', () => {
  beforeEach(() => {
    h.native.value = true;
  });

  it('writes the first chunk and appends the rest, byte for byte', async () => {
    // One byte past a chunk boundary: the second piece must decode on its own.
    const bytes = new Uint8Array(CHUNK_BYTES + 1);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 251;

    const result = await saveFile(new Blob([bytes]), 'pharmareader-backup.zip');

    expect(result).toEqual({ location: `Documents/${SAVE_DIR}/pharmareader-backup.zip` });
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(h.append).toHaveBeenCalledTimes(1);
    expect(h.write.mock.calls[0]![0]).toMatchObject({
      path: `${SAVE_DIR}/pharmareader-backup.zip`,
      directory: 'DOCUMENTS',
      recursive: true,
    });
    // No single call carries the whole file as one base64 string.
    const first = decode(h.write.mock.calls[0]![0].data);
    const second = decode(h.append.mock.calls[0]![0].data);
    expect(first.length).toBe(CHUNK_BYTES);
    expect(second.length).toBe(1);
    expect(Buffer.concat([first, second]).equals(Buffer.from(bytes))).toBe(true);
  });

  it('writes an empty file with one call', async () => {
    await saveFile(new Blob([]), 'empty.txt');
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(decode(h.write.mock.calls[0]![0].data).length).toBe(0);
    expect(h.append).not.toHaveBeenCalled();
  });

  it('asks for the storage permission when it is not granted yet', async () => {
    h.check.value = { publicStorage: 'prompt' };
    await saveFile(new Blob(['x']), 'a.txt');
    expect(h.checkCalls.value).toBe(1);
    expect(h.requestCalls.value).toBe(1);
    expect(h.write).toHaveBeenCalledTimes(1);
  });

  it('does not ask when the permission is already granted', async () => {
    await saveFile(new Blob(['x']), 'a.txt');
    expect(h.requestCalls.value).toBe(0);
  });

  it('stops with a plain-English message when the permission is refused', async () => {
    h.check.value = { publicStorage: 'prompt' };
    h.request.value = { publicStorage: 'denied' };
    await expect(saveFile(new Blob(['x']), 'a.txt')).rejects.toThrow(/storage permission/i);
    expect(h.write).not.toHaveBeenCalled();
  });

  it('turns a write failure into a plain-English message', async () => {
    h.write.mockRejectedValueOnce(new Error('disk full'));
    await expect(saveFile(new Blob(['x']), 'a.txt')).rejects.toThrow(/could not be saved/i);
  });

  it('removes a half-written file when a later chunk fails', async () => {
    // First chunk lands, the append does not: the leftovers would look like a
    // valid backup while holding only the first 3 MB of it.
    const bytes = new Uint8Array(CHUNK_BYTES + 1);
    h.append.mockRejectedValueOnce(new Error('No space left on device'));

    await expect(saveFile(new Blob([bytes]), 'pharmareader-backup.zip')).rejects.toThrow(
      /could not be saved.*No space left/i,
    );

    expect(h.deleteFile).toHaveBeenCalledTimes(1);
    expect(h.deleteFile.mock.calls[0]![0]).toEqual({
      path: `${SAVE_DIR}/pharmareader-backup.zip`,
      directory: 'DOCUMENTS',
    });
  });

  it('still reports the write error when the cleanup itself fails', async () => {
    h.write.mockRejectedValueOnce(new Error('disk full'));
    h.deleteFile.mockRejectedValueOnce(new Error('no such file'));
    await expect(saveFile(new Blob(['x']), 'a.txt')).rejects.toThrow(/could not be saved.*disk full/i);
  });
});

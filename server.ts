import dotenv from 'dotenv';
import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import type { Server } from 'http';
import {
  Book, DownloadEvent, MatchCandidate, MatchEvent, RateLimitError, SearchAccessError,
  applySelectedMatch, findRowCandidates, loadConfig, parseCSVContent, processCSV, readCSV, rejectRowMatch, scanMatches,
} from './main';
import { generateBookList, listLLMProviders } from './llm';
import { isTrustedAnnaURL } from './anna';
import { chooseFolder, FolderPickerUnavailableError, folderPickerSupported } from './folderPicker';
import { LibraryReconciliation, reconcileRowsWithLibrary, writeCSVRows } from './library';

const projectRoot = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(projectRoot, '.env') });
export const app = express();
const port = Number(process.env.UI_PORT) || 4173;
const runtimeDir = path.join(projectRoot, '.ui-runtime');
const csvPath = path.join(runtimeDir, 'selected-books.csv');
const sessionPath = path.join(runtimeDir, 'session.json');
fs.mkdirSync(runtimeDir, { recursive: true });

interface PersistedSession {
  selectedFileName?: string;
  selectedOutputFolder?: string;
  selectedPreferredPublisher?: string;
}

function readPersistedSession(): PersistedSession {
  try {
    const value = JSON.parse(fs.readFileSync(sessionPath, 'utf-8')) as PersistedSession;
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

const persistedSession = readPersistedSession();
const clients = new Set<express.Response>();
let selectedFileName = typeof persistedSession.selectedFileName === 'string' ? persistedSession.selectedFileName : '';
let selectedOutputFolder = typeof persistedSession.selectedOutputFolder === 'string'
  ? path.resolve(persistedSession.selectedOutputFolder)
  : path.resolve(projectRoot, process.env.OUTPUT_FOLDER || './downloads');
let selectedPreferredPublisher = typeof persistedSession.selectedPreferredPublisher === 'string'
  ? persistedSession.selectedPreferredPublisher.trim()
  : (process.env.PREFERRED_PUBLISHER || '').trim();
let activeController: AbortController | null = null;
let activeScanController: AbortController | null = null;
let folderPickerActive = false;
const pendingConfirmations = new Map<number, (decision: 'confirm' | 'skip') => void>();
let runState: 'idle' | 'running' | 'completed' | 'stopped' | 'paused' | 'failed' = 'idle';
let scanState: 'idle' | 'scanning' | 'completed' | 'stopped' | 'paused' | 'failed' = 'idle';
let currentRunRow: number | null = null;
let currentScanRow: number | null = null;
let operationStartedAt: number | null = null;

function persistSession(): void {
  const output = JSON.stringify({ selectedFileName, selectedOutputFolder, selectedPreferredPublisher }, null, 2);
  const temporaryPath = `${sessionPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, output, 'utf-8');
    fs.renameSync(temporaryPath, sessionPath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

function replaceCatalog(content: string): { rows: ReturnType<typeof parseCSVContent>; reconciliation: LibraryReconciliation } {
  const rows = parseCSVContent(content);
  if (!rows.length) throw new Error('The selected CSV has no book rows.');
  if (!rows.every((row) => row.author?.trim() && row.title?.trim())) {
    throw new Error('CSV rows must include author and title values.');
  }
  const configuredLibraryFolder = String(process.env.LIBRARY_SCAN_FOLDER || '').trim();
  const libraryFolder = configuredLibraryFolder ? path.resolve(projectRoot, configuredLibraryFolder) : selectedOutputFolder;
  const reconciliation = reconcileRowsWithLibrary(rows, libraryFolder);
  writeCSVRows(csvPath, rows);
  return { rows, reconciliation };
}

function isValidCandidate(value: unknown): value is MatchCandidate {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<MatchCandidate>;
  const book = candidate.book as Partial<Book> | undefined;
  if (!book || typeof book.hash !== 'string' || !/^[a-f0-9]{32}$/i.test(book.hash)) return false;
  if (typeof book.title !== 'string' || !book.title.trim() || typeof book.format !== 'string' || !book.format.trim()) return false;
  if (typeof book.url !== 'string') return false;
  return isTrustedAnnaURL(book.url, `/md5/${book.hash}`);
}

app.use((request, response, next) => {
  const hostname = String(request.headers.host || '').split(':')[0].replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1') {
    return response.status(403).json({ error: 'This service only accepts local requests.' });
  }
  const origin = request.headers.origin;
  if (origin) {
    try {
      const originHostname = new URL(origin).hostname.toLowerCase();
      if (originHostname !== '127.0.0.1' && originHostname !== 'localhost' && originHostname !== '::1') {
        return response.status(403).json({ error: 'This service only accepts local origins.' });
      }
    } catch {
      return response.status(403).json({ error: 'Invalid request origin.' });
    }
  }
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use('/api/import', express.text({ type: ['text/csv', 'text/plain', 'application/vnd.ms-excel'], limit: '5mb' }));

app.get('/api/llm/providers', (_request, response) => {
  response.json({ providers: listLLMProviders() });
});

app.post('/api/llm/book-list', async (request, response) => {
  const providerId = typeof request.body?.provider === 'string' ? request.body.provider.trim() : '';
  const model = typeof request.body?.model === 'string' ? request.body.model.trim() : '';
  const prompt = typeof request.body?.prompt === 'string' ? request.body.prompt.trim() : '';
  const count = Number(request.body?.count);
  const excludedTitles = Array.isArray(request.body?.excludedTitles)
    ? request.body.excludedTitles.filter((value: unknown): value is string => typeof value === 'string').slice(0, 200)
    : [];
  if (!providerId) return response.status(400).json({ error: 'Choose an LLM provider.' });
  if (prompt.length < 3 || prompt.length > 4_000) return response.status(400).json({ error: 'Describe the list in 3 to 4,000 characters.' });
  if (!Number.isInteger(count) || count < 1 || count > 100) return response.status(400).json({ error: 'Book count must be a whole number between 1 and 100.' });

  try {
    response.json(await generateBookList({ providerId, model, request: prompt, count, excludedTitles }));
  } catch (error: any) {
    const providerMessage = error.response?.data?.error?.message
      || error.response?.data?.message
      || error.response?.data?.error
      || error.message;
    const message = typeof providerMessage === 'string' ? providerMessage : 'The LLM provider could not generate a book list.';
    const status = error.response?.status === 429 ? 429 : error.response?.status === 401 || error.response?.status === 403 ? 401 : 502;
    response.status(status).json({ error: message });
  }
});

function broadcast(type: string, payload: unknown) {
  const message = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  clients.forEach((client) => client.write(message));
}

app.get('/api/events', (_request, response) => {
  response.setHeader('Content-Type', 'text/event-stream');
  response.setHeader('Cache-Control', 'no-cache');
  response.setHeader('Connection', 'keep-alive');
  response.flushHeaders();
  clients.add(response);
  response.write(`event: ready\ndata: {}\n\n`);
  response.on('close', () => clients.delete(response));
});

app.get('/api/session', (_request, response) => {
  const rows = fs.existsSync(csvPath) ? readCSV(csvPath) : [];
  const metadataPath = process.env.ANNA_METADATA_INDEX?.trim();
  const localMetadataEnabled = Boolean(metadataPath && fs.existsSync(path.resolve(projectRoot, metadataPath)));
  const untrustedCatalogEnabled = /^(?:1|true|yes|on)$/i.test(process.env.ENABLE_UNTRUSTED_CATALOG_SEARCH?.trim() || '');
  response.json({
    fileName: selectedFileName || (rows.length ? 'selected-books.csv' : ''), rows,
    destination: selectedOutputFolder, preferredPublisher: selectedPreferredPublisher,
    runState, scanState, currentRunRow, currentScanRow, operationStartedAt,
    searchProvider: localMetadataEnabled ? 'local_metadata' : untrustedCatalogEnabled ? 'untrusted_catalog' : 'disabled',
  });
});

app.post('/api/import', (request, response) => {
  try {
    if (activeController) return response.status(409).json({ error: 'Stop the active download before changing files.' });
    if (activeScanController) return response.status(409).json({ error: 'Stop the active match scan before changing files.' });
    const content = typeof request.body === 'string' ? request.body : '';
    if (!content.trim()) return response.status(400).json({ error: 'The selected CSV is empty.' });
    const { rows, reconciliation } = replaceCatalog(content);
    selectedFileName = String(request.header('x-file-name') || 'selected-books.csv');
    runState = 'idle'; scanState = 'idle'; currentRunRow = null; currentScanRow = null;
    persistSession();
    response.json({ fileName: selectedFileName, rows, reconciliation });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Could not read CSV.' });
  }
});

app.delete('/api/catalog', (_request, response) => {
  if (activeController || activeScanController) return response.status(409).json({ error: 'Stop the active operation before clearing the CSV.' });
  if (fs.existsSync(csvPath)) fs.unlinkSync(csvPath);
  selectedFileName = '';
  runState = 'idle'; scanState = 'idle'; currentRunRow = null; currentScanRow = null; operationStartedAt = null;
  persistSession();
  response.json({ cleared: true });
});

app.get('/api/catalog', (_request, response) => {
  if (!fs.existsSync(csvPath)) return response.status(404).json({ error: 'Choose a CSV file first.' });
  const baseName = path.basename(selectedFileName || 'selected-books.csv', path.extname(selectedFileName || 'selected-books.csv'));
  response.setHeader('Content-Type', 'text/csv; charset=utf-8');
  response.setHeader('Content-Disposition', `attachment; filename="${baseName.replace(/[^a-z0-9_-]/gi, '_')}-updated.csv"`);
  fs.createReadStream(csvPath).pipe(response);
});

app.get('/api/destination', (_request, response) => {
  response.json({ path: selectedOutputFolder, exists: fs.existsSync(selectedOutputFolder), canBrowse: folderPickerSupported() });
});

app.post('/api/destination/browse', async (request, response) => {
  if (activeController) return response.status(409).json({ error: 'Stop the active download before changing the destination.' });
  if (folderPickerActive) return response.status(409).json({ error: 'A folder picker is already open.' });

  const requestedInitialPath = String(request.body?.initialPath || '').trim();
  const initialPath = requestedInitialPath && fs.existsSync(requestedInitialPath) && fs.statSync(requestedInitialPath).isDirectory()
    ? path.resolve(requestedInitialPath)
    : fs.existsSync(selectedOutputFolder) ? selectedOutputFolder : projectRoot;

  folderPickerActive = true;
  try {
    const pickedPath = await chooseFolder(initialPath);
    if (!pickedPath) return response.json({ selected: false, path: selectedOutputFolder });
    const outputFolder = path.resolve(pickedPath);
    if (!fs.existsSync(outputFolder) || !fs.statSync(outputFolder).isDirectory()) {
      return response.status(400).json({ error: 'The selected destination is not an available folder.' });
    }
    selectedOutputFolder = outputFolder;
    persistSession();
    response.json({ selected: true, path: selectedOutputFolder });
  } catch (error) {
    const status = error instanceof FolderPickerUnavailableError ? 501 : 500;
    response.status(status).json({ error: error instanceof Error ? error.message : 'Could not open the folder picker.' });
  } finally {
    folderPickerActive = false;
  }
});

app.post('/api/destination', (request, response) => {
  if (activeController) return response.status(409).json({ error: 'Stop the active download before changing the destination.' });
  const requestedPath = String(request.body?.path || '').trim();
  const create = request.body?.create === true;
  if (!requestedPath) return response.status(400).json({ error: 'Enter a download folder path.' });

  try {
    const outputFolder = path.resolve(projectRoot, requestedPath);
    if (fs.existsSync(outputFolder)) {
      if (!fs.statSync(outputFolder).isDirectory()) return response.status(400).json({ error: 'The destination exists but is not a folder.' });
    } else if (create) {
      fs.mkdirSync(outputFolder, { recursive: true });
    } else {
      return response.status(404).json({ error: 'That folder does not exist. Choose “Create new folder” to create it.' });
    }
    selectedOutputFolder = outputFolder;
    persistSession();
    response.json({ path: selectedOutputFolder, exists: true, created: create });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Could not use that destination.' });
  }
});

app.get('/api/preferred-publisher', (_request, response) => {
  response.json({ publisher: selectedPreferredPublisher });
});

app.post('/api/preferred-publisher', (request, response) => {
  if (activeController) return response.status(409).json({ error: 'Stop the active download before changing the preferred publisher.' });
  if (activeScanController) return response.status(409).json({ error: 'Stop the active match scan before changing the preferred publisher.' });
  selectedPreferredPublisher = String(request.body?.publisher || '').trim();
  persistSession();
  response.json({ publisher: selectedPreferredPublisher });
});

app.post('/api/downloads/start', async (request, response) => {
  if (activeController) return response.status(409).json({ error: 'Downloads are already running.' });
  if (activeScanController) return response.status(409).json({ error: 'Stop the active match scan before starting downloads.' });
  if (!fs.existsSync(csvPath)) return response.status(400).json({ error: 'Choose a CSV file first.' });
  if (!fs.existsSync(selectedOutputFolder) || !fs.statSync(selectedOutputFolder).isDirectory()) {
    return response.status(400).json({ error: 'The saved download destination is no longer available. Choose a valid folder before starting.' });
  }
  const totalRows = readCSV(csvPath).length;
  const startRow = Number(request.body?.startRow ?? 1);
  if (!Number.isInteger(startRow) || startRow < 1 || startRow > totalRows) {
    return response.status(400).json({ error: `Start row must be a whole number between 1 and ${totalRows}.` });
  }

  activeController = new AbortController();
  const controller = activeController;
  runState = 'running'; currentRunRow = startRow - 1; operationStartedAt = Date.now();
  broadcast('run', { state: runState, startedAt: operationStartedAt });
  response.status(202).json({ started: true, fileName: selectedFileName });

  try {
    const config = loadConfig();
    config.outputFolder = selectedOutputFolder;
    config.preferredPublisher = selectedPreferredPublisher;
    await processCSV(csvPath, config, {
      signal: controller.signal,
      startIndex: startRow - 1,
      onEvent: (event: DownloadEvent) => { currentRunRow = event.rowIndex; broadcast('book', event); },
      confirmMatch: (rowIndex: number, _book: Book, _confidence: number) => new Promise((resolve) => {
        pendingConfirmations.set(rowIndex, (decision) => {
          pendingConfirmations.delete(rowIndex);
          resolve(decision);
        });
      }),
    });
    runState = controller.signal.aborted ? 'stopped' : 'completed';
    broadcast('run', { state: runState });
  } catch (error) {
    runState = error instanceof RateLimitError ? 'paused' : 'failed';
    broadcast('run', { state: runState, message: error instanceof Error ? error.message : String(error) });
  } finally {
    pendingConfirmations.forEach((resolve) => resolve('skip'));
    pendingConfirmations.clear();
    if (activeController === controller) activeController = null;
  }
});

app.post('/api/downloads/confirm', (request, response) => {
  const rowIndex = Number(request.body?.rowIndex);
  const action = request.body?.action === 'confirm' ? 'confirm' : request.body?.action === 'skip' ? 'skip' : null;
  const resolve = pendingConfirmations.get(rowIndex);
  if (!action) return response.status(400).json({ error: 'Action must be confirm or skip.' });
  if (!resolve) return response.status(404).json({ error: 'This match is no longer awaiting confirmation.' });
  resolve(action);
  response.json({ accepted: true, action });
});

app.post('/api/downloads/stop', (_request, response) => {
  if (!activeController) return response.json({ stopped: false });
  activeController.abort();
  runState = 'stopped';
  broadcast('run', { state: runState });
  pendingConfirmations.forEach((resolve) => resolve('skip'));
  pendingConfirmations.clear();
  response.json({ stopped: true });
});

app.get('/api/match/:rowIndex/candidates', async (request, response) => {
  if (!fs.existsSync(csvPath)) return response.status(400).json({ error: 'Choose a CSV file first.' });
  const rowIndex = Number(request.params.rowIndex);
  const rows = readCSV(csvPath);
  if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= rows.length) {
    return response.status(400).json({ error: 'Invalid row index.' });
  }
  try {
    const config = loadConfig({ requireSecretKey: false });
    config.preferredPublisher = selectedPreferredPublisher;
    const candidates = await findRowCandidates(rows[rowIndex], config);
    response.json({ rowIndex, candidates });
  } catch (error) {
    response.status(502).json({ error: error instanceof Error ? error.message : 'Could not search for candidates.' });
  }
});

app.post('/api/match/:rowIndex/select', (request, response) => {
  if (activeController) return response.status(409).json({ error: 'Stop the active download run before changing matches.' });
  if (!fs.existsSync(csvPath)) return response.status(400).json({ error: 'Choose a CSV file first.' });
  const rowIndex = Number(request.params.rowIndex);
  const rows = readCSV(csvPath);
  if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= rows.length) {
    return response.status(400).json({ error: 'Invalid row index.' });
  }
  const candidate = request.body?.candidate;
  if (!isValidCandidate(candidate)) return response.status(400).json({ error: 'A valid candidate is required.' });

  applySelectedMatch(csvPath, rowIndex, candidate);
  const event: MatchEvent = { rowIndex, status: 'matched', candidates: [candidate], selected: candidate };
  broadcast('match', event);
  response.json({ accepted: true });
});

app.post('/api/match/:rowIndex/reject', (request, response) => {
  if (activeController) return response.status(409).json({ error: 'Stop the active download run before changing matches.' });
  if (!fs.existsSync(csvPath)) return response.status(400).json({ error: 'Choose a CSV file first.' });
  const rowIndex = Number(request.params.rowIndex);
  const rows = readCSV(csvPath);
  if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= rows.length) {
    return response.status(400).json({ error: 'Invalid row index.' });
  }
  rejectRowMatch(csvPath, rowIndex);
  const event: MatchEvent = { rowIndex, status: 'rejected' };
  broadcast('match', event);
  response.json({ accepted: true });
});

app.post('/api/match/scan', async (request, response) => {
  if (activeScanController) return response.status(409).json({ error: 'A match scan is already running.' });
  if (activeController) return response.status(409).json({ error: 'Stop the active download run before scanning.' });
  if (!fs.existsSync(csvPath)) return response.status(400).json({ error: 'Choose a CSV file first.' });
  const totalRows = readCSV(csvPath).length;
  const startRow = Number(request.body?.startRow ?? 1);
  if (!Number.isInteger(startRow) || startRow < 1 || startRow > totalRows + 1) {
    return response.status(400).json({ error: `Scan start row must be a whole number between 1 and ${totalRows + 1}.` });
  }

  activeScanController = new AbortController();
  const controller = activeScanController;
  scanState = 'scanning'; currentScanRow = startRow - 1; operationStartedAt = Date.now();
  broadcast('scan-run', { state: scanState, startedAt: operationStartedAt });
  response.status(202).json({ started: true });

  try {
    const config = loadConfig({ requireSecretKey: false });
    config.preferredPublisher = selectedPreferredPublisher;
    await scanMatches(csvPath, config, {
      signal: controller.signal,
      startIndex: startRow - 1,
      onEvent: (event: MatchEvent) => { currentScanRow = event.rowIndex; broadcast('match', event); },
    });
    scanState = controller.signal.aborted ? 'stopped' : 'completed';
    broadcast('scan-run', { state: scanState });
  } catch (error) {
    scanState = error instanceof RateLimitError || error instanceof SearchAccessError ? 'paused' : 'failed';
    broadcast('scan-run', { state: scanState, message: error instanceof Error ? error.message : String(error) });
  } finally {
    if (activeScanController === controller) activeScanController = null;
  }
});

app.post('/api/match/stop', (_request, response) => {
  if (!activeScanController) return response.json({ stopped: false });
  activeScanController.abort();
  scanState = 'stopped';
  broadcast('scan-run', { state: scanState });
  response.json({ stopped: true });
});

const staticDir = path.join(projectRoot, 'ui', 'dist');
app.use(express.static(staticDir));
app.get('*path', (_request, response) => response.sendFile(path.join(staticDir, 'index.html')));

export function startServer(listenPort = port, host = '127.0.0.1'): Server {
  return app.listen(listenPort, host, () => {
    console.log(`Anna Downloader UI: http://${host}:${listenPort}`);
  });
}

if (require.main === module) startServer();

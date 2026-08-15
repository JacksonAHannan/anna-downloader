import dotenv from 'dotenv';
import express from 'express';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import type { Server } from 'http';
import {
  Book, DownloadEvent, MatchCandidate, MatchEvent, RateLimitError, SearchAccessError,
  applySelectedMatch, findRowCandidates, loadConfig, processCSV, readCSV, rejectRowMatch, scanMatches,
} from './main';

const projectRoot = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(projectRoot, '.env') });
export const app = express();
const port = Number(process.env.UI_PORT) || 4173;
const runtimeDir = path.join(projectRoot, '.ui-runtime');
const csvPath = path.join(runtimeDir, 'selected-books.csv');
const clients = new Set<express.Response>();
let selectedFileName = '';
let selectedOutputFolder = path.resolve(projectRoot, process.env.OUTPUT_FOLDER || './downloads');
let selectedPreferredPublisher = (process.env.PREFERRED_PUBLISHER || '').trim();
let activeController: AbortController | null = null;
let activeScanController: AbortController | null = null;
const pendingConfirmations = new Map<number, (decision: 'confirm' | 'skip') => void>();
let runState: 'idle' | 'running' | 'completed' | 'stopped' | 'paused' | 'failed' = 'idle';
let scanState: 'idle' | 'scanning' | 'completed' | 'stopped' | 'paused' | 'failed' = 'idle';
let currentRunRow: number | null = null;
let currentScanRow: number | null = null;
let operationStartedAt: number | null = null;

function isValidCandidate(value: unknown): value is MatchCandidate {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<MatchCandidate>;
  const book = candidate.book as Partial<Book> | undefined;
  if (!book || typeof book.hash !== 'string' || !/^[a-z0-9]{6,128}$/i.test(book.hash)) return false;
  if (typeof book.title !== 'string' || !book.title.trim() || typeof book.format !== 'string' || !book.format.trim()) return false;
  if (typeof book.url !== 'string') return false;
  try {
    const url = new URL(book.url);
    return url.protocol === 'https:' && ['annas-archive.is', 'annas-archive.gl', 'annas-archive.gs'].includes(url.hostname) && url.pathname === `/md5/${book.hash}`;
  } catch {
    return false;
  }
}

fs.mkdirSync(runtimeDir, { recursive: true });
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

const googleQueryPrefixes: Record<string, string> = {
  keyword: '',
  subject: 'subject:',
  author: 'inauthor:',
  title: 'intitle:',
  publisher: 'inpublisher:',
  isbn: 'isbn:',
};

app.get('/api/google-books/search', async (request, response) => {
  const query = String(request.query.query || '').trim();
  const field = String(request.query.field || 'keyword');
  const startIndex = Math.max(0, Number(request.query.startIndex) || 0);
  const maxResults = Math.min(40, Math.max(10, Number(request.query.maxResults) || 20));
  const key = process.env.GOOGLE_BOOKS_KEY;

  if (!key) return response.status(500).json({ error: 'GOOGLE_BOOKS_KEY is not configured.' });
  if (!query) return response.status(400).json({ error: 'Enter a search query.' });
  if (!(field in googleQueryPrefixes)) return response.status(400).json({ error: 'Unsupported search field.' });

  try {
    const apiResponse = await axios.get('https://www.googleapis.com/books/v1/volumes', {
      params: {
        q: `${googleQueryPrefixes[field]}${query}`,
        key,
        startIndex,
        maxResults,
        printType: 'books',
        projection: 'full',
      },
      timeout: 15000,
    });

    const books = (apiResponse.data.items || []).map((item: any) => {
      const info = item.volumeInfo || {};
      const thumbnail = info.imageLinks?.thumbnail || info.imageLinks?.smallThumbnail || '';
      return {
        id: item.id,
        title: info.title || 'Untitled',
        authors: Array.isArray(info.authors) ? info.authors : ['Unknown author'],
        publishedDate: info.publishedDate || '',
        categories: Array.isArray(info.categories) ? info.categories : [],
        description: info.description || '',
        thumbnail: thumbnail.replace(/^http:/, 'https:'),
        publisher: info.publisher || '',
        isbn: (info.industryIdentifiers || []).find((identifier: any) => identifier.type === 'ISBN_13')?.identifier || '',
      };
    });

    response.json({ books, totalItems: Number(apiResponse.data.totalItems) || 0, startIndex, maxResults });
  } catch (error: any) {
    const message = error.response?.data?.error?.message || error.message || 'Google Books search failed.';
    response.status(error.response?.status === 429 ? 429 : 502).json({ error: message });
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
  response.json({
    fileName: selectedFileName || (rows.length ? 'selected-books.csv' : ''), rows,
    destination: selectedOutputFolder, preferredPublisher: selectedPreferredPublisher,
    runState, scanState, currentRunRow, currentScanRow, operationStartedAt,
  });
});

app.post('/api/import', (request, response) => {
  try {
    if (activeController) return response.status(409).json({ error: 'Stop the active download before changing files.' });
    const content = typeof request.body === 'string' ? request.body : '';
    if (!content.trim()) return response.status(400).json({ error: 'The selected CSV is empty.' });
    fs.writeFileSync(csvPath, content, 'utf-8');
    const rows = readCSV(csvPath);
    if (!rows.every((row) => row.author && row.title)) {
      return response.status(400).json({ error: 'CSV rows must include author and title values.' });
    }
    selectedFileName = String(request.header('x-file-name') || 'selected-books.csv');
    runState = 'idle'; scanState = 'idle'; currentRunRow = null; currentScanRow = null;
    response.json({ fileName: selectedFileName, rows });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Could not read CSV.' });
  }
});

app.get('/api/catalog', (_request, response) => {
  if (!fs.existsSync(csvPath)) return response.status(404).json({ error: 'Choose a CSV file first.' });
  const baseName = path.basename(selectedFileName || 'selected-books.csv', path.extname(selectedFileName || 'selected-books.csv'));
  response.setHeader('Content-Type', 'text/csv; charset=utf-8');
  response.setHeader('Content-Disposition', `attachment; filename="${baseName.replace(/[^a-z0-9_-]/gi, '_')}-updated.csv"`);
  fs.createReadStream(csvPath).pipe(response);
});

app.get('/api/destination', (_request, response) => {
  response.json({ path: selectedOutputFolder, exists: fs.existsSync(selectedOutputFolder) });
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
  response.json({ publisher: selectedPreferredPublisher });
});

app.post('/api/downloads/start', async (request, response) => {
  if (activeController) return response.status(409).json({ error: 'Downloads are already running.' });
  if (activeScanController) return response.status(409).json({ error: 'Stop the active match scan before starting downloads.' });
  if (!fs.existsSync(csvPath)) return response.status(400).json({ error: 'Choose a CSV file first.' });
  const totalRows = readCSV(csvPath).length;
  const startRow = Number(request.body?.startRow ?? 1);
  if (!Number.isInteger(startRow) || startRow < 1 || startRow > totalRows) {
    return response.status(400).json({ error: `Start row must be a whole number between 1 and ${totalRows}.` });
  }

  activeController = new AbortController();
  const controller = activeController;
  response.status(202).json({ started: true, fileName: selectedFileName });
  runState = 'running'; currentRunRow = startRow - 1; operationStartedAt = Date.now();
  broadcast('run', { state: runState, startedAt: operationStartedAt });

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
    const config = loadConfig();
    config.preferredPublisher = selectedPreferredPublisher;
    const candidates = await findRowCandidates(rows[rowIndex], config);
    response.json({ rowIndex, candidates });
  } catch (error) {
    response.status(502).json({ error: error instanceof Error ? error.message : 'Could not search for candidates.' });
  }
});

app.post('/api/match/:rowIndex/select', (request, response) => {
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

  activeScanController = new AbortController();
  const controller = activeScanController;
  response.status(202).json({ started: true });
  scanState = 'scanning'; currentScanRow = null; operationStartedAt = Date.now();
  broadcast('scan-run', { state: scanState, startedAt: operationStartedAt });

  try {
    const config = loadConfig();
    config.preferredPublisher = selectedPreferredPublisher;
    await scanMatches(csvPath, config, {
      signal: controller.signal,
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

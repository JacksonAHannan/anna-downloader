import dotenv from 'dotenv';
import express from 'express';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { Book, DownloadEvent, RateLimitError, loadConfig, processCSV, readCSV } from './main';

const projectRoot = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(projectRoot, '.env') });
const app = express();
const port = Number(process.env.UI_PORT) || 4173;
const runtimeDir = path.join(projectRoot, '.ui-runtime');
const csvPath = path.join(runtimeDir, 'selected-books.csv');
const clients = new Set<express.Response>();
let selectedFileName = '';
let selectedOutputFolder = path.resolve(projectRoot, process.env.OUTPUT_FOLDER || './downloads');
let activeController: AbortController | null = null;
const pendingConfirmations = new Map<number, (decision: 'confirm' | 'skip') => void>();

fs.mkdirSync(runtimeDir, { recursive: true });
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

app.post('/api/downloads/start', async (request, response) => {
  if (activeController) return response.status(409).json({ error: 'Downloads are already running.' });
  if (!fs.existsSync(csvPath)) return response.status(400).json({ error: 'Choose a CSV file first.' });
  const totalRows = readCSV(csvPath).length;
  const startRow = Number(request.body?.startRow ?? 1);
  if (!Number.isInteger(startRow) || startRow < 1 || startRow > totalRows) {
    return response.status(400).json({ error: `Start row must be a whole number between 1 and ${totalRows}.` });
  }

  activeController = new AbortController();
  const controller = activeController;
  response.status(202).json({ started: true, fileName: selectedFileName });
  broadcast('run', { state: 'running' });

  try {
    const config = loadConfig();
    config.outputFolder = selectedOutputFolder;
    await processCSV(csvPath, config, {
      signal: controller.signal,
      startIndex: startRow - 1,
      onEvent: (event: DownloadEvent) => broadcast('book', event),
      confirmMatch: (rowIndex: number, _book: Book, _confidence: number) => new Promise((resolve) => {
        pendingConfirmations.set(rowIndex, (decision) => {
          pendingConfirmations.delete(rowIndex);
          resolve(decision);
        });
      }),
    });
    broadcast('run', { state: controller.signal.aborted ? 'stopped' : 'completed' });
  } catch (error) {
    broadcast('run', { state: error instanceof RateLimitError ? 'paused' : 'failed', message: error instanceof Error ? error.message : String(error) });
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
  pendingConfirmations.forEach((resolve) => resolve('skip'));
  pendingConfirmations.clear();
  response.json({ stopped: true });
});

const staticDir = path.join(projectRoot, 'ui', 'dist');
app.use(express.static(staticDir));
app.get('*path', (_request, response) => response.sendFile(path.join(staticDir, 'index.html')));

app.listen(port, () => {
  console.log(`Anna Downloader UI: http://localhost:${port}`);
});

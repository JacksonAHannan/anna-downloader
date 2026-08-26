import * as fs from 'node:fs';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { LocalMetadataCandidate, searchLocalMetadata } from './localMetadata';

interface SearchResponse {
  id: number;
  results?: LocalMetadataCandidate[];
  error?: string;
}

interface PendingSearch {
  resolve: (results: LocalMetadataCandidate[]) => void;
  reject: (error: Error) => void;
}

let metadataWorker: Worker | undefined;
let nextRequestId = 1;
const pendingSearches = new Map<number, PendingSearch>();

function failWorker(error: Error, failedWorker: Worker): void {
  if (metadataWorker !== failedWorker) return;
  metadataWorker = undefined;
  for (const pending of pendingSearches.values()) pending.reject(error);
  pendingSearches.clear();
}

function getMetadataWorker(): Worker | undefined {
  if (metadataWorker) return metadataWorker;
  const workerPath = path.join(__dirname, 'localMetadataWorker.js');
  // Jest/ts-node execute TypeScript directly without a compiled worker file.
  // Production builds always include this file in dist/.
  if (process.env.JEST_WORKER_ID || !fs.existsSync(workerPath)) return undefined;

  const worker = new Worker(workerPath);
  metadataWorker = worker;
  worker.on('message', (response: SearchResponse) => {
    const pending = pendingSearches.get(response.id);
    if (!pending) return;
    pendingSearches.delete(response.id);
    if (response.error) pending.reject(new Error(response.error));
    else pending.resolve(response.results ?? []);
  });
  worker.on('error', (error) => failWorker(error, worker));
  worker.on('exit', (code) => {
    failWorker(new Error(`Local metadata worker exited with code ${code}.`), worker);
  });
  return worker;
}

export function searchLocalMetadataAsync(
  databasePath: string,
  title: string,
  author = '',
  limit = 25,
): Promise<LocalMetadataCandidate[]> {
  const worker = getMetadataWorker();
  if (!worker) return Promise.resolve(searchLocalMetadata(databasePath, title, author, limit));
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    pendingSearches.set(id, { resolve, reject });
    worker.postMessage({ id, databasePath, title, author, limit });
  });
}

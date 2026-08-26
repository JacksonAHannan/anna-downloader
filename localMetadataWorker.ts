import { parentPort } from 'node:worker_threads';
import { searchLocalMetadata } from './localMetadata';

interface SearchRequest {
  id: number;
  databasePath: string;
  title: string;
  author: string;
  limit: number;
}

const port = parentPort;
if (!port) throw new Error('The local metadata worker must run inside a worker thread.');

port.on('message', (request: SearchRequest) => {
  try {
    port.postMessage({
      id: request.id,
      results: searchLocalMetadata(request.databasePath, request.title, request.author, request.limit),
    });
  } catch (error) {
    port.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

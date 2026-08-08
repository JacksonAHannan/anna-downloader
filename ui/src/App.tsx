import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import { BookListBuilder } from './BookListBuilder';
import { readApiResponse } from './api';

type Status = 'queued' | 'searching' | 'awaiting_confirmation' | 'downloading' | 'completed' | 'failed' | 'skipped';
type Row = { author: string; title: string; status: Status; progress: number; format?: string; size?: string; message?: string; matchTitle?: string; matchAuthors?: string; confidence?: number };
type BookEvent = Partial<Row> & { rowIndex: number; status: Status };
type ImportedRow = { author: string; title: string; status?: string; error?: string; matched_title?: string; matched_author?: string; match_confidence?: string };

const Icon = ({ name }: { name: 'file' | 'play' | 'stop' | 'check' | 'alert' | 'close' }) => {
  const paths = {
    file: <><path d="M6 2.5h7l5 5V21.5H6z"/><path d="M13 2.5v5h5"/></>,
    play: <path d="m8 5 10 7-10 7z"/>, stop: <rect x="7" y="7" width="10" height="10" rx="1"/>,
    check: <path d="m7 12 3 3 7-7"/>, alert: <><path d="M12 4 3.5 20h17z"/><path d="M12 9v5M12 17.2v.1"/></>,
    close: <path d="m7 7 10 10M17 7 7 17"/>,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24">{paths[name]}</svg>;
};

function StatusMark({ row }: { row: Row }) {
  const label = row.status === 'downloading' ? `Downloading ${row.progress}%` : row.status === 'awaiting_confirmation' ? 'Review match' : row.status[0].toUpperCase() + row.status.slice(1);
  return <span className={`status status-${row.status}`}>
    {row.status === 'completed' ? <Icon name="check" /> : row.status === 'failed' ? <Icon name="alert" /> : <i />}{label}
  </span>;
}

export function App() {
  const [tab, setTab] = useState<'download' | 'builder'>('download');
  const [rows, setRows] = useState<Row[]>([]);
  const [fileName, setFileName] = useState('');
  const [fileSize, setFileSize] = useState(0);
  const [runState, setRunState] = useState<'idle' | 'running' | 'completed' | 'stopped' | 'paused' | 'failed'>('idle');
  const [error, setError] = useState('');
  const [destination, setDestination] = useState('');
  const [savedDestination, setSavedDestination] = useState('');
  const [destinationMode, setDestinationMode] = useState<'existing' | 'create'>('existing');
  const [destinationBusy, setDestinationBusy] = useState(false);
  const [startRow, setStartRow] = useState(1);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch('/api/destination').then((response) => readApiResponse<{ path: string }>(response)).then((data) => {
      setDestination(data.path);
      setSavedDestination(data.path);
    }).catch((reason) => setError(reason instanceof Error ? reason.message : 'Could not load the download destination.'));
    const events = new EventSource('/api/events');
    events.addEventListener('book', (message) => {
      const event = JSON.parse((message as MessageEvent).data) as BookEvent;
      setRows((current) => current.map((row, index) => index === event.rowIndex ? { ...row, ...event } : row));
    });
    events.addEventListener('run', (message) => {
      const event = JSON.parse((message as MessageEvent).data) as { state: typeof runState; message?: string };
      setRunState(event.state);
      if (event.message) setError(event.message);
    });
    return () => events.close();
  }, []);

  const summary = useMemo(() => ({
    total: rows.length,
    completed: rows.filter((row) => row.status === 'completed' || row.status === 'skipped').length,
    active: rows.filter((row) => row.status === 'searching' || row.status === 'awaiting_confirmation' || row.status === 'downloading').length,
    failed: rows.filter((row) => row.status === 'failed').length,
  }), [rows]);
  const overall = rows.length ? Math.round(rows.reduce((sum, row) => sum + row.progress, 0) / rows.length) : 0;
  const displayedRows = useMemo(() => rows.map((row, originalIndex) => ({ row, originalIndex })).sort((left, right) => {
    const leftDeferred = left.row.message?.startsWith('Review deferred') || left.row.status === 'awaiting_confirmation';
    const rightDeferred = right.row.message?.startsWith('Review deferred') || right.row.status === 'awaiting_confirmation';
    return Number(leftDeferred) - Number(rightDeferred) || left.originalIndex - right.originalIndex;
  }), [rows]);

  function applyImportedRows(data: { fileName: string; rows: ImportedRow[] }, size = 0) {
    setFileName(data.fileName); setFileSize(size); setRunState('idle'); setError('');
    setStartRow(1);
    setRows(data.rows.map((row) => { const owned = row.status?.trim().toLowerCase() === 'downloaded'; return { author: row.author, title: row.title, status: owned ? 'skipped' : 'queued', progress: owned ? 100 : 0, message: row.error || undefined, matchTitle: row.matched_title || undefined, matchAuthors: row.matched_author || undefined, confidence: row.match_confidence ? Number(row.match_confidence) / 100 : undefined }; }));
  }

  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const response = await fetch('/api/import', { method: 'POST', headers: { 'Content-Type': 'text/csv', 'X-File-Name': file.name }, body: await file.text() });
    const data = await readApiResponse<{ fileName: string; rows: ImportedRow[]; error?: string }>(response);
    if (!response.ok) return setError(data.error || 'Could not import CSV.');
    applyImportedRows(data, file.size);
  }

  async function useGeneratedList(csv: string, name: string) {
    const response = await fetch('/api/import', { method: 'POST', headers: { 'Content-Type': 'text/csv', 'X-File-Name': name }, body: csv });
    const data = await readApiResponse<{ fileName: string; rows: ImportedRow[]; error?: string }>(response);
    if (!response.ok) throw new Error(data.error || 'Could not create the downloader list.');
    applyImportedRows(data, new Blob([csv]).size);
    setTab('download');
  }

  async function start() {
    setError('');
    setRows((current) => current.map((row) => row.status === 'skipped' ? row : { ...row, status: 'queued', progress: 0, message: undefined }));
    const response = await fetch('/api/downloads/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ startRow }) });
    const data = await readApiResponse<{ error?: string }>(response);
    if (!response.ok) setError(data.error || 'Could not start downloads.');
  }
  async function stop() { await fetch('/api/downloads/stop', { method: 'POST' }); }
  async function saveDestination() {
    setDestinationBusy(true); setError('');
    try {
      const response = await fetch('/api/destination', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: destination, create: destinationMode === 'create' }) });
      const data = await readApiResponse<{ path?: string; error?: string }>(response);
      if (!response.ok) return setError(data.error || 'Could not use that destination.');
      setDestination(data.path || destination);
      setSavedDestination(data.path || destination);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not use that destination.');
    } finally { setDestinationBusy(false); }
  }
  async function decideMatch(rowIndex: number, action: 'confirm' | 'skip') {
    const response = await fetch('/api/downloads/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rowIndex, action }) });
    const data = await readApiResponse<{ error?: string }>(response);
    if (!response.ok) setError(data.error || 'Could not submit match decision.');
  }
  function clearFile() { setRows([]); setFileName(''); setFileSize(0); setRunState('idle'); if (inputRef.current) inputRef.current.value = ''; }

  return <main className={`shell ${tab === 'builder' ? 'builder-shell' : ''}`}>
    <header><h1>Anna Downloader</h1>{tab === 'download' && <span className={`connection ${runState}`}>{runState === 'running' ? 'Downloads active' : runState === 'completed' ? 'Run complete' : runState === 'paused' ? 'Daily limit reached' : 'Ready'}</span>}</header>
    <nav className="workspace-tabs" aria-label="Workspace">
      <button className={tab === 'download' ? 'active' : ''} onClick={() => setTab('download')}>Download CSV</button>
      <button className={tab === 'builder' ? 'active' : ''} onClick={() => setTab('builder')}>Build a book list</button>
    </nav>

    {tab === 'builder' ? <BookListBuilder onUseInDownloader={useGeneratedList} /> : <>
      <section className="file-row" aria-label="CSV selection">
        <button className="primary choose" onClick={() => inputRef.current?.click()} disabled={runState === 'running'}><Icon name="file" />Choose CSV</button>
        <input ref={inputRef} hidden type="file" accept=".csv,text/csv" onChange={chooseFile} />
        <div className={`file-selection ${fileName ? 'selected' : ''}`}><Icon name="file" /><div><strong>{fileName || 'No CSV selected'}</strong><span>{fileName ? `${(fileSize / 1024).toFixed(1)} KB · ${rows.length} ${rows.length === 1 ? 'row' : 'rows'}` : 'Choose a file with author and title columns'}</span></div>{fileName && runState !== 'running' && <button className="icon-button" onClick={clearFile} aria-label="Clear selected file"><Icon name="close" /></button>}</div>
      </section>
      <section className="destination-panel" aria-label="Download destination">
        <div className="destination-heading"><div><strong>Download destination</strong><span>Choose an existing folder or enter a path for a new one.</span></div>{savedDestination && <span className="destination-ready"><Icon name="check" />Ready</span>}</div>
        <div className="destination-modes" role="radiogroup" aria-label="Destination type">
          <label><input type="radio" name="destination-mode" checked={destinationMode === 'existing'} onChange={() => setDestinationMode('existing')} disabled={runState === 'running'} />Use existing folder</label>
          <label><input type="radio" name="destination-mode" checked={destinationMode === 'create'} onChange={() => setDestinationMode('create')} disabled={runState === 'running'} />Create new folder</label>
        </div>
        <div className="destination-entry"><input aria-label="Destination folder path" value={destination} onChange={(event) => setDestination(event.target.value)} placeholder="C:\\Users\\User\\Desktop\\Books" disabled={runState === 'running'} /><button className="secondary" onClick={saveDestination} disabled={!destination.trim() || destinationBusy || runState === 'running'}>{destinationBusy ? 'Saving…' : destinationMode === 'create' ? 'Create and use' : 'Use folder'}</button></div>
        {savedDestination && <small>Downloads will be saved to <strong>{savedDestination}</strong></small>}
      </section>
      {error && <div className="error-banner" role="alert"><Icon name="alert" />{error}</div>}
      <section className="summary" aria-label="Download summary"><div><span>Total</span><strong>{summary.total}</strong></div><div><span>Completed</span><strong className="green">{summary.completed}</strong></div><div><span>In progress</span><strong className="blue">{summary.active}</strong></div><div><span>Failed</span><strong className="red">{summary.failed}</strong></div></section>
      <footer><div className="actions"><label className="start-row"><span>Start at row</span><input type="number" min={1} max={Math.max(1, rows.length)} value={startRow} onChange={(event) => setStartRow(Math.max(1, Math.min(Math.max(1, rows.length), Number(event.target.value) || 1)))} disabled={!rows.length || runState === 'running'} /></label><button className="primary" disabled={!rows.length || !savedDestination || destination !== savedDestination || runState === 'running'} onClick={start}><Icon name="play" />Start downloads</button><button className="secondary" disabled={runState !== 'running'} onClick={stop}><Icon name="stop" />Stop</button><a className={`secondary catalog-download ${!rows.length ? 'disabled' : ''}`} href={rows.length ? '/api/catalog' : undefined} download>Save updated CSV</a></div><div className="overall"><div><strong>Overall progress</strong><span>{overall}%</span></div><div className="track"><i style={{ width: `${overall}%` }} /></div></div></footer>
      <section className="queue" aria-label="Book download queue">
        <div className="table-head"><span>Book</span><span>Author</span><span>Format</span><span>Status</span><span>Progress</span></div>
        {rows.length === 0 ? <div className="empty"><div className="empty-file"><Icon name="file" /></div><h2>Your download queue is empty</h2><p>Choose a CSV file to review books before downloading.</p></div> : displayedRows.map(({ row, originalIndex }) => <div className={`book-row row-${row.status}`} key={`${row.title}-${row.author}-${originalIndex}`}><div className="book"><strong>{row.title}</strong>{row.matchTitle && <small className="match-detail" title={`${row.matchTitle} — ${row.matchAuthors || ''}`}>Match: {row.matchTitle} · {Math.round((row.confidence || 0) * 100)}%</small>}{row.message && <small title={row.message}>{row.message}</small>}</div><span>{row.author}</span><span className="format">{row.format || '—'}</span><StatusMark row={row} />{row.status === 'awaiting_confirmation' ? <div className="match-actions"><button className="confirm-match" onClick={() => decideMatch(originalIndex, 'confirm')}>Confirm</button><button className="skip-match" onClick={() => decideMatch(originalIndex, 'skip')}>Skip</button></div> : <div className="progress-wrap"><div className="track"><i style={{ width: `${row.progress}%` }} /></div><span>{row.status === 'searching' ? 'Searching…' : `${row.progress}%`}</span></div>}</div>)}
      </section>
    </>}
  </main>;
}

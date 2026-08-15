import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import { BookListBuilder } from './BookListBuilder';
import { readApiResponse } from './api';

type Status = 'queued' | 'searching' | 'awaiting_confirmation' | 'downloading' | 'completed' | 'failed' | 'skipped';
type MatchState = 'idle' | 'scanning' | 'matched' | 'needs_review' | 'rejected' | 'failed';
type CandidateBook = { title: string; authors: string; publisher: string; language: string; format: string; size: string; url: string; hash: string; downloadCount: number };
type MatchCandidate = { book: CandidateBook; titleScore: number; authorScore: number; confidence: number; isExactMatch: boolean };
type Row = { author: string; title: string; status: Status; progress: number; format?: string; size?: string; message?: string; matchTitle?: string; matchAuthors?: string; matchPublisher?: string; confidence?: number; matchState?: MatchState; candidates?: MatchCandidate[]; selectedHash?: string };
type BookEvent = Partial<Row> & { rowIndex: number; status: Status };
type MatchEvent = { rowIndex: number; status: Exclude<MatchState, 'idle'>; message?: string; candidates?: MatchCandidate[]; selected?: MatchCandidate };
type ImportedRow = { author: string; title: string; status?: string; error?: string; matched_title?: string; matched_author?: string; match_confidence?: string; selected_hash?: string; selected_publisher?: string; selected_format?: string; selected_size?: string };
type QueueFilter = 'all' | 'pending' | 'matched' | 'needs_review' | 'downloaded' | 'failed' | 'rejected';

function isPreferredPublisher(publisher: string, preferredPublisher: string) {
  const preference = preferredPublisher.trim();
  return preference.length > 0 && publisher.toLowerCase().includes(preference.toLowerCase());
}

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

function MatchCandidateRow({ candidate, isSelected, preferredPublisher, onSelect }: { candidate: MatchCandidate; isSelected: boolean; preferredPublisher: string; onSelect: () => void }) {
  const preferred = isPreferredPublisher(candidate.book.publisher, preferredPublisher);
  return <div className={`candidate-row ${isSelected ? 'selected' : ''}`}>
    <div className="candidate-identity">
      <strong>{candidate.book.title}</strong>
      <span>{candidate.book.authors || 'Unknown author'}</span>
      <small>{candidate.book.publisher || 'Unknown publisher'}{preferred && <em className="publisher-badge">{preferredPublisher.trim()}</em>}</small>
    </div>
    <span>{candidate.book.language || '—'}</span>
    <span>{candidate.book.format || '—'} · {candidate.book.size || '—'}</span>
    <span>{candidate.book.downloadCount ? `${candidate.book.downloadCount.toLocaleString()} downloads` : '—'}</span>
    <span className="candidate-confidence" title={`Title ${Math.round(candidate.titleScore * 100)}% · Author ${Math.round(candidate.authorScore * 100)}%`}><i style={{ width: `${Math.round(candidate.confidence * 100)}%` }} />{candidate.isExactMatch ? 'Exact' : `${Math.round(candidate.confidence * 100)}%`}</span>
    <a className="candidate-link" href={candidate.book.url} target="_blank" rel="noreferrer">View</a>
    <button className={isSelected ? 'primary compact' : 'secondary compact'} onClick={onSelect} disabled={isSelected}>{isSelected ? 'Selected' : 'Select'}</button>
  </div>;
}

function MatchPanel({ row, rowIndex, preferredPublisher, onSelect, onReject }: { row: Row; rowIndex: number; preferredPublisher: string; onSelect: (rowIndex: number, candidate: MatchCandidate) => void; onReject: (rowIndex: number) => void }) {
  return <div className="match-panel">
    {!row.candidates ? <div className="match-panel-loading">Loading candidates…</div> : row.candidates.length === 0 ? <div className="match-panel-empty">No editions found.</div> : <>
      <div className="candidate-head"><span>Edition</span><span>Language</span><span>Format · Size</span><span>Popularity</span><span>Match</span><span>Source</span><span /></div>
      {row.candidates.map((candidate) => <MatchCandidateRow key={candidate.book.hash} candidate={candidate} isSelected={candidate.book.hash === row.selectedHash} preferredPublisher={preferredPublisher} onSelect={() => onSelect(rowIndex, candidate)} />)}
    </>}
    <div className="match-panel-actions"><button className="skip-match" onClick={() => onReject(rowIndex)}>None of these — reject</button></div>
  </div>;
}

export function App() {
  const [tab, setTab] = useState<'download' | 'builder'>('download');
  const [rows, setRows] = useState<Row[]>([]);
  const [fileName, setFileName] = useState('');
  const [fileSize, setFileSize] = useState(0);
  const [runState, setRunState] = useState<'idle' | 'running' | 'completed' | 'stopped' | 'paused' | 'failed'>('idle');
  const [scanState, setScanState] = useState<'idle' | 'scanning' | 'completed' | 'stopped' | 'paused' | 'failed'>('idle');
  const [expandedMatches, setExpandedMatches] = useState<Set<number>>(() => new Set());
  const [error, setError] = useState('');
  const [destination, setDestination] = useState('');
  const [savedDestination, setSavedDestination] = useState('');
  const [destinationMode, setDestinationMode] = useState<'existing' | 'create'>('existing');
  const [destinationBusy, setDestinationBusy] = useState(false);
  const [preferredPublisher, setPreferredPublisher] = useState('');
  const [savedPreferredPublisher, setSavedPreferredPublisher] = useState('');
  const [preferredPublisherBusy, setPreferredPublisherBusy] = useState(false);
  const [startRow, setStartRow] = useState(1);
  const [queueFilter, setQueueFilter] = useState<QueueFilter>('all');
  const [queueSearch, setQueueSearch] = useState('');
  const [reviewFirst, setReviewFirst] = useState(true);
  const [currentRunRow, setCurrentRunRow] = useState<number | null>(null);
  const [currentScanRow, setCurrentScanRow] = useState<number | null>(null);
  const [operationStartedAt, setOperationStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [toast, setToast] = useState('');
  const [stoppingScan, setStoppingScan] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingCandidateFetches = useRef<Set<number>>(new Set());
  const busy = runState === 'running' || scanState === 'scanning';

  useEffect(() => {
    fetch('/api/session').then((response) => readApiResponse<{ fileName: string; rows: ImportedRow[]; destination: string; preferredPublisher: string; runState: typeof runState; scanState: typeof scanState; currentRunRow: number | null; currentScanRow: number | null; operationStartedAt: number | null }>(response)).then((data) => {
      setDestination(data.destination); setSavedDestination(data.destination);
      setPreferredPublisher(data.preferredPublisher); setSavedPreferredPublisher(data.preferredPublisher);
      if (data.rows.length) applyImportedRows({ fileName: data.fileName, rows: data.rows });
      setRunState(data.runState); setScanState(data.scanState); setCurrentRunRow(data.currentRunRow); setCurrentScanRow(data.currentScanRow); setOperationStartedAt(data.operationStartedAt);
    }).catch((reason) => setError(reason instanceof Error ? reason.message : 'Could not restore the current session.'));
    const events = new EventSource('/api/events');
    events.addEventListener('book', (message) => {
      const event = JSON.parse((message as MessageEvent).data) as BookEvent;
      setCurrentRunRow(event.rowIndex);
      setRows((current) => current.map((row, index) => index === event.rowIndex ? { ...row, ...event } : row));
    });
    events.addEventListener('run', (message) => {
      const event = JSON.parse((message as MessageEvent).data) as { state: typeof runState; message?: string; startedAt?: number };
      setRunState(event.state);
      if (event.startedAt) setOperationStartedAt(event.startedAt);
      if (event.message) setError(event.message);
    });
    events.addEventListener('match', (message) => {
      const event = JSON.parse((message as MessageEvent).data) as MatchEvent;
      setCurrentScanRow(event.rowIndex);
      const best = event.selected ?? event.candidates?.[0];
      setRows((current) => current.map((row, index) => {
        if (index !== event.rowIndex) return row;
        const rejected = event.status === 'rejected';
        return {
          ...row,
          matchState: event.status,
          candidates: event.candidates ?? row.candidates,
          matchTitle: rejected ? undefined : best?.book.title ?? row.matchTitle,
          matchAuthors: rejected ? undefined : best?.book.authors ?? row.matchAuthors,
          matchPublisher: rejected ? undefined : event.selected ? event.selected.book.publisher : row.matchPublisher,
          confidence: rejected ? undefined : best?.confidence ?? row.confidence,
          format: rejected ? undefined : event.selected ? event.selected.book.format : row.format,
          size: rejected ? undefined : event.selected ? event.selected.book.size : row.size,
          selectedHash: rejected ? undefined : event.selected ? event.selected.book.hash : row.selectedHash,
          message: event.status === 'scanning' ? undefined : event.message ?? row.message,
        };
      }));
    });
    events.addEventListener('scan-run', (message) => {
      const event = JSON.parse((message as MessageEvent).data) as { state: typeof scanState; message?: string; startedAt?: number };
      setScanState(event.state);
      if (event.startedAt) setOperationStartedAt(event.startedAt);
      if (event.message) setError(event.message);
    });
    return () => events.close();
  }, []);

  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(''), 2800); return () => window.clearTimeout(timer); }, [toast]);
  useEffect(() => { if (!busy) return; const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, [busy]);

  useEffect(() => {
    rows.forEach((row, index) => {
      if (row.matchState !== 'needs_review' || row.candidates || pendingCandidateFetches.current.has(index)) return;
      pendingCandidateFetches.current.add(index);
      void loadCandidates(index).finally(() => pendingCandidateFetches.current.delete(index));
    });
  }, [rows]);

  const summary = useMemo(() => ({
    total: rows.length,
    completed: rows.filter((row) => row.status === 'completed' || row.status === 'skipped').length,
    active: rows.filter((row) => row.status === 'searching' || row.status === 'awaiting_confirmation' || row.status === 'downloading').length,
    failed: rows.filter((row) => row.status === 'failed').length,
  }), [rows]);
  const overall = rows.length ? Math.round(rows.reduce((sum, row) => sum + row.progress, 0) / rows.length) : 0;
  const displayedRows = useMemo(() => rows.map((row, originalIndex) => ({ row, originalIndex })).filter(({ row }) => {
    const searchable = `${row.title} ${row.author}`.toLowerCase().includes(queueSearch.trim().toLowerCase());
    if (!searchable) return false;
    if (queueFilter === 'all') return true;
    if (queueFilter === 'pending') return row.status === 'queued' && !row.matchState;
    if (queueFilter === 'matched') return row.matchState === 'matched';
    if (queueFilter === 'needs_review') return row.matchState === 'needs_review' || row.status === 'awaiting_confirmation';
    if (queueFilter === 'downloaded') return row.status === 'completed' || row.status === 'skipped';
    if (queueFilter === 'rejected') return row.matchState === 'rejected';
    return row.status === 'failed' || row.matchState === 'failed';
  }).sort((left, right) => {
    if (!reviewFirst) return left.originalIndex - right.originalIndex;
    const leftDeferred = left.row.message?.startsWith('Review deferred') || left.row.status === 'awaiting_confirmation' || left.row.matchState === 'needs_review';
    const rightDeferred = right.row.message?.startsWith('Review deferred') || right.row.status === 'awaiting_confirmation' || right.row.matchState === 'needs_review';
    return Number(leftDeferred) - Number(rightDeferred) || left.originalIndex - right.originalIndex;
  }), [rows, queueFilter, queueSearch, reviewFirst]);

  function applyImportedRows(data: { fileName: string; rows: ImportedRow[] }, size = 0) {
    setFileName(data.fileName); setFileSize(size); setRunState('idle'); setScanState('idle'); setError('');
    setStartRow(1); setExpandedMatches(new Set());
    setRows(data.rows.map((row) => {
      const normalizedStatus = row.status?.trim().toLowerCase();
      const owned = normalizedStatus === 'downloaded';
      const matchState: MatchState | undefined = normalizedStatus === 'matched' ? 'matched' : normalizedStatus === 'pending_review' ? 'needs_review' : normalizedStatus === 'rejected' ? 'rejected' : undefined;
      const restoredStatus: Status = owned || normalizedStatus === 'rejected' ? 'skipped' : normalizedStatus === 'failed' ? 'failed' : 'queued';
      return {
        author: row.author, title: row.title, status: restoredStatus, progress: owned ? 100 : 0,
        message: row.error || undefined,
        matchTitle: row.matched_title || undefined, matchAuthors: row.matched_author || undefined,
        matchPublisher: row.selected_publisher || undefined,
        confidence: row.match_confidence ? Number(row.match_confidence) / 100 : undefined,
        matchState, selectedHash: row.selected_hash || undefined,
        format: row.selected_format || undefined, size: row.selected_size || undefined,
      };
    }));
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
      setToast('Download destination saved');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not use that destination.');
    } finally { setDestinationBusy(false); }
  }
  async function savePreferredPublisher() {
    setPreferredPublisherBusy(true); setError('');
    try {
      const response = await fetch('/api/preferred-publisher', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ publisher: preferredPublisher }) });
      const data = await readApiResponse<{ publisher?: string; error?: string }>(response);
      if (!response.ok) return setError(data.error || 'Could not save the preferred publisher.');
      setPreferredPublisher(data.publisher || '');
      setSavedPreferredPublisher(data.publisher || '');
      setToast('Matching preference saved');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save the preferred publisher.');
    } finally { setPreferredPublisherBusy(false); }
  }
  async function decideMatch(rowIndex: number, action: 'confirm' | 'skip') {
    const response = await fetch('/api/downloads/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rowIndex, action }) });
    const data = await readApiResponse<{ error?: string }>(response);
    if (!response.ok) setError(data.error || 'Could not submit match decision.');
  }
  async function startScan() {
    setError('');
    setScanState('scanning');
    setRows((current) => current.map((row) => row.matchState === 'matched' || row.matchState === 'rejected' ? row : { ...row, matchState: undefined, candidates: undefined }));
    try {
      const response = await fetch('/api/match/scan', { method: 'POST' });
      const data = await readApiResponse<{ error?: string }>(response);
      if (!response.ok) {
        setScanState('failed');
        setError(data.error || 'Could not start match scan.');
      }
    } catch (reason) {
      setScanState('failed');
      setError(reason instanceof Error ? reason.message : 'Could not start match scan.');
    }
  }
  async function stopScan() {
    setError('');
    setStoppingScan(true);
    try {
      const response = await fetch('/api/match/stop', { method: 'POST' });
      const data = await readApiResponse<{ stopped?: boolean; error?: string }>(response);
      if (!response.ok) return setError(data.error || 'Could not stop the match scan.');
      setScanState('stopped');
      setToast(`Scan stopped${currentScanRow === null ? '' : ` after row ${currentScanRow + 1}`}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not stop the match scan.');
    } finally { setStoppingScan(false); }
  }
  async function loadCandidates(rowIndex: number) {
    try {
      const response = await fetch(`/api/match/${rowIndex}/candidates`);
      const data = await readApiResponse<{ candidates: MatchCandidate[]; error?: string }>(response);
      if (!response.ok) return setError(data.error || 'Could not load candidates.');
      setRows((current) => current.map((row, index) => index === rowIndex ? { ...row, candidates: data.candidates } : row));
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not load candidates.'); }
  }
  function toggleExpanded(rowIndex: number) {
    setExpandedMatches((current) => { const next = new Set(current); next.has(rowIndex) ? next.delete(rowIndex) : next.add(rowIndex); return next; });
    if (!rows[rowIndex]?.candidates?.length) void loadCandidates(rowIndex);
  }
  async function selectCandidate(rowIndex: number, candidate: MatchCandidate) {
    const response = await fetch(`/api/match/${rowIndex}/select`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ candidate }) });
    const data = await readApiResponse<{ error?: string }>(response);
    if (!response.ok) return setError(data.error || 'Could not save that match.');
    setToast(`Match selected for row ${rowIndex + 1}`);
    setExpandedMatches((current) => { const next = new Set(current); next.delete(rowIndex); return next; });
  }
  async function rejectMatch(rowIndex: number) {
    if (!window.confirm(`Reject row ${rowIndex + 1}? It will be skipped in future runs.`)) return;
    const response = await fetch(`/api/match/${rowIndex}/reject`, { method: 'POST' });
    const data = await readApiResponse<{ error?: string }>(response);
    if (!response.ok) setError(data.error || 'Could not reject that title.');
    else setToast(`Row ${rowIndex + 1} rejected`);
  }
  function clearFile() { if (!window.confirm('Clear this catalog from the screen? The updated server copy will remain available for download.')) return; setRows([]); setFileName(''); setFileSize(0); setRunState('idle'); setScanState('idle'); setExpandedMatches(new Set()); if (inputRef.current) inputRef.current.value = ''; }
  function jumpToRow(rowNumber = startRow) { document.getElementById(`queue-row-${rowNumber}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  function retryFromRow(rowIndex: number) { setStartRow(rowIndex + 1); setQueueFilter('all'); setToast(`Start row set to ${rowIndex + 1}`); window.setTimeout(() => jumpToRow(rowIndex + 1), 0); }
  function retryFailed() { const first = rows.findIndex((row) => row.status === 'failed' || row.matchState === 'failed'); if (first >= 0) retryFromRow(first); }
  const activeRowIndex = scanState === 'scanning' ? currentScanRow : currentRunRow;
  const activeRow = activeRowIndex === null ? undefined : rows[activeRowIndex];
  const elapsedSeconds = operationStartedAt ? Math.max(0, Math.floor((now - operationStartedAt) / 1000)) : 0;
  const scanExamined = rows.filter((row) => row.matchState && row.matchState !== 'idle').length;
  return <main className={`shell ${tab === 'builder' ? 'builder-shell' : ''}`}>
    <header><h1>Anna Downloader</h1>{tab === 'download' && <span className={`connection ${runState}`}>{runState === 'running' ? 'Downloads active' : runState === 'completed' ? 'Run complete' : runState === 'paused' ? 'Daily limit reached' : 'Ready'}</span>}</header>
    <nav className="workspace-tabs" aria-label="Workspace">
      <button className={tab === 'download' ? 'active' : ''} onClick={() => setTab('download')}>Download CSV</button>
      <button className={tab === 'builder' ? 'active' : ''} onClick={() => setTab('builder')}>Build a book list</button>
    </nav>

    {tab === 'builder' ? <BookListBuilder onUseInDownloader={useGeneratedList} /> : <>
      {busy && <section className="operation-bar" aria-live="polite">
        <div className="operation-main"><i className="spinner" /><div><strong>{scanState === 'scanning' ? `Scanning row ${activeRowIndex === null ? '…' : activeRowIndex + 1} of ${rows.length}` : `Downloading row ${activeRowIndex === null ? '…' : activeRowIndex + 1} of ${rows.length}`}</strong><span>{activeRow ? `${activeRow.title} · ${activeRow.author}` : 'Preparing operation…'}</span></div></div>
        <div className="operation-stats"><span>{scanState === 'scanning' ? `${scanExamined} examined` : `${summary.completed} completed`}</span><span>{rows.filter((row) => row.matchState === 'needs_review').length} need review</span><span>{summary.failed} failed</span><span>{Math.floor(elapsedSeconds / 60)}:{String(elapsedSeconds % 60).padStart(2, '0')}</span></div>
        <button className="secondary" onClick={scanState === 'scanning' ? stopScan : stop} disabled={stoppingScan}><Icon name="stop" />{stoppingScan ? 'Stopping…' : scanState === 'scanning' ? 'Stop scan' : 'Stop downloads'}</button>
      </section>}
      <section className="workflow" aria-label="Workflow progress"><div className={scanState === 'completed' ? 'done' : scanState === 'scanning' ? 'active' : ''}><b>1</b><span><strong>Review matches</strong><small>{scanState === 'completed' ? 'Scan complete' : scanState === 'scanning' ? `${scanExamined} of ${rows.length} examined` : 'Optional preliminary scan'}</small></span></div><i /><div className={runState === 'completed' ? 'done' : runState === 'running' ? 'active' : ''}><b>2</b><span><strong>Download editions</strong><small>{runState === 'completed' ? 'Run complete' : runState === 'running' ? `Working on row ${(currentRunRow ?? 0) + 1}` : 'Download selected matches'}</small></span></div></section>
      <section className="file-row" aria-label="CSV selection">
        <button className="primary choose" onClick={() => inputRef.current?.click()} disabled={busy}><Icon name="file" />Choose CSV</button>
        <input ref={inputRef} hidden type="file" accept=".csv,text/csv" onChange={chooseFile} />
        <div className={`file-selection ${fileName ? 'selected' : ''}`}><Icon name="file" /><div><strong>{fileName || 'No CSV selected'}</strong><span>{fileName ? `${(fileSize / 1024).toFixed(1)} KB · ${rows.length} ${rows.length === 1 ? 'row' : 'rows'}` : 'Choose a file with author and title columns'}</span></div>{fileName && !busy && <button className="icon-button" onClick={clearFile} aria-label="Clear selected file"><Icon name="close" /></button>}</div>
      </section>
      <section className="match-toolbar" aria-label="Match review">
        <div>
          <strong>Preliminary match review</strong>
          <span>{savedPreferredPublisher ? `Editions from "${savedPreferredPublisher}" rank higher and only exact matches are picked automatically — everything else waits for your pick from the top 10.` : 'Scan for the best edition of every row before downloading. With no preferred publisher set, matches above 80% confidence are picked automatically, same as a normal download run.'}</span>
          <div className="publisher-preference">
            <label><span>Preferred publisher</span><input value={preferredPublisher} onChange={(event) => setPreferredPublisher(event.target.value)} placeholder="e.g. Penguin" disabled={busy} /></label>
            <button className="secondary compact" onClick={savePreferredPublisher} disabled={busy || preferredPublisherBusy || preferredPublisher === savedPreferredPublisher}>{preferredPublisherBusy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
        <div className="match-toolbar-actions">
          <span className={`connection ${scanState}`}>{scanState === 'scanning' ? 'Scanning…' : scanState === 'completed' ? 'Scan complete' : scanState === 'paused' ? 'Daily limit reached' : scanState === 'stopped' ? 'Scan stopped' : ''}</span>
          {scanState === 'scanning' ? <button className="secondary" onClick={stopScan} disabled={stoppingScan}><Icon name="stop" />{stoppingScan ? 'Stopping…' : 'Stop scan'}</button> : <button className="secondary" disabled={!rows.length || runState === 'running'} onClick={startScan}><Icon name="play" />{scanState === 'stopped' && currentScanRow !== null ? `Resume after row ${currentScanRow + 1}` : 'Scan matches'}</button>}
        </div>
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
      {error && <div className="error-banner" role="alert" tabIndex={-1} ref={errorRef}><Icon name="alert" /><div><strong>Action failed</strong><span>{error}</span></div><button className="icon-button" onClick={() => setError('')} aria-label="Dismiss error"><Icon name="close" /></button></div>}
      <section className="summary" aria-label="Download summary"><div><span>Total</span><strong>{summary.total}</strong></div><div><span>Completed</span><strong className="green">{summary.completed}</strong></div><div><span>In progress</span><strong className="blue">{summary.active}</strong></div><div><span>Failed</span><strong className="red">{summary.failed}</strong></div></section>
      <footer><div className="actions"><label className="start-row"><span>Start at row</span><span className="start-row-controls"><input type="number" min={1} max={Math.max(1, rows.length)} value={startRow} onChange={(event) => setStartRow(Math.max(1, Math.min(Math.max(1, rows.length), Number(event.target.value) || 1)))} disabled={!rows.length || busy} /><button className="secondary compact" onClick={() => jumpToRow()} disabled={!rows.length}>Jump</button></span></label><button className="primary" disabled={!rows.length || !savedDestination || destination !== savedDestination || busy} onClick={start}><Icon name="play" />Start downloads</button><button className="secondary" disabled={runState !== 'running'} onClick={stop}><Icon name="stop" />Stop</button><a className={`secondary catalog-download ${!rows.length ? 'disabled' : ''}`} href={rows.length ? '/api/catalog' : undefined} download onClick={() => rows.length && setToast('Updated CSV downloaded')}>Save updated CSV</a></div><div className="overall"><div><strong>Download progress</strong><span>{overall}%</span></div><div className="track"><i style={{ width: `${overall}%` }} /></div></div></footer>
      <section className="queue-tools" aria-label="Queue filters"><div className="filter-tabs">{(['all','pending','matched','needs_review','downloaded','failed','rejected'] as QueueFilter[]).map((filter) => <button key={filter} className={queueFilter === filter ? 'active' : ''} onClick={() => setQueueFilter(filter)}>{filter === 'needs_review' ? 'Needs review' : filter[0].toUpperCase() + filter.slice(1)}</button>)}</div>{summary.failed > 0 && <button className="secondary retry-failed" onClick={retryFailed}>Retry failed</button>}<input type="search" value={queueSearch} onChange={(event) => setQueueSearch(event.target.value)} placeholder="Search title or author" aria-label="Search queue" /><label><input type="checkbox" checked={reviewFirst} onChange={(event) => setReviewFirst(event.target.checked)} />Review items last</label></section>
      <section className="queue" aria-label="Book download queue">
        <div className="table-head"><span>Row</span><span>Book</span><span>Author</span><span>Format</span><span>Status</span><span>Progress</span></div>
        {rows.length === 0 ? <div className="empty"><div className="empty-file"><Icon name="file" /></div><h2>Your download queue is empty</h2><p>Choose a CSV file to review books before downloading.</p></div> : displayedRows.map(({ row, originalIndex }) => {
          const panelOpen = row.matchState === 'needs_review' || expandedMatches.has(originalIndex);
          return <div className="queue-item" id={`queue-row-${originalIndex + 1}`} key={`${row.title}-${row.author}-${originalIndex}`}>
            {originalIndex + 1 === startRow && <div className="start-divider"><span>Downloads start here</span></div>}
            <div className={`book-row row-${row.status}`}>
              <button className="row-number" title={`Set start row to ${originalIndex + 1}`} onClick={() => setStartRow(originalIndex + 1)}>#{originalIndex + 1}</button>
              <div className="book">
                <strong>{row.title}</strong>
                {row.matchTitle && <small className="match-detail" title={`${row.matchTitle} — ${row.matchAuthors || ''}`}>Match: {row.matchTitle}{row.matchPublisher ? ` · ${row.matchPublisher}` : ''}{row.matchPublisher && isPreferredPublisher(row.matchPublisher, savedPreferredPublisher) && <em className="publisher-badge">{savedPreferredPublisher.trim()}</em>} · {Math.round((row.confidence || 0) * 100)}%</small>}
                {row.matchState === 'scanning' && <small className="match-detail">Scanning for editions…</small>}
                {row.matchState === 'rejected' && <small className="match-detail">No acceptable match found</small>}
                {row.matchState && row.matchState !== 'scanning' && row.matchState !== 'needs_review' && <button className="link-button" aria-expanded={panelOpen} aria-controls={`match-panel-${originalIndex}`} onClick={() => toggleExpanded(originalIndex)}>{panelOpen ? 'Hide candidates' : row.matchState === 'rejected' ? 'Review again' : 'Change match'}</button>}
                {row.message && <small title={row.message}>{row.message}</small>}
                {(row.status === 'failed' || row.matchState === 'failed') && <button className="link-button retry-row" onClick={() => retryFromRow(originalIndex)}>Retry from this row</button>}
              </div>
              <span>{row.author}</span>
              <span className="format">{row.format || '—'}</span>
              <StatusMark row={row} />
              {row.status === 'awaiting_confirmation' ? <div className="match-actions"><button className="confirm-match" onClick={() => decideMatch(originalIndex, 'confirm')}>Confirm</button><button className="skip-match" onClick={() => decideMatch(originalIndex, 'skip')}>Skip</button></div> : <div className="progress-wrap"><div className="track"><i style={{ width: `${row.progress}%` }} /></div><span>{row.status === 'searching' ? 'Searching…' : `${row.progress}%`}</span></div>}
            </div>
            {panelOpen && <div id={`match-panel-${originalIndex}`}><MatchPanel row={row} rowIndex={originalIndex} preferredPublisher={savedPreferredPublisher} onSelect={selectCandidate} onReject={rejectMatch} /></div>}
          </div>;
        })}
      </section>
      <div className="sr-only" aria-live="polite">{scanState === 'scanning' ? `Scanned ${scanExamined} of ${rows.length} rows` : ''}</div>
      {toast && <div className="toast" role="status">{toast}</div>}
    </>}
  </main>;
}

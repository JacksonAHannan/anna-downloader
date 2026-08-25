import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import { BookListBuilder } from './BookListBuilder';
import { readApiResponse } from './api';
import { ImportedRow, MatchCandidate, MatchState, Row, Status, adjacentReviewRow, importedRowToRow, nextUnresolvedReviewRow, reviewRowIndexes as collectReviewRowIndexes } from './rowState';

type BookEvent = Partial<Row> & { rowIndex: number; status: Status };
type MatchEvent = { rowIndex: number; status: Exclude<MatchState, 'idle'>; message?: string; candidates?: MatchCandidate[]; selected?: MatchCandidate };
type QueueFilter = 'all' | 'pending' | 'matched' | 'needs_review' | 'downloaded' | 'failed' | 'rejected';
type ImportResponse = { fileName: string; rows: ImportedRow[]; error?: string; reconciliation?: { libraryFolder: string; filesScanned: number; newlyDownloaded: number } };

function isPreferredPublisher(publisher: string, preferredPublisher: string) {
  const preference = preferredPublisher.trim();
  return preference.length > 0 && publisher.toLowerCase().includes(preference.toLowerCase());
}

const Icon = ({ name }: { name: 'file' | 'folder' | 'play' | 'stop' | 'check' | 'alert' | 'close' }) => {
  const paths = {
    file: <><path d="M6 2.5h7l5 5V21.5H6z"/><path d="M13 2.5v5h5"/></>,
    folder: <path d="M3.5 6.5h6l2 2h9v10.5h-17z"/>,
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
  const sourceLabel = candidate.book.searchSource === 'untrusted_catalog'
    ? 'Untrusted web catalog'
    : candidate.book.searchSource === 'local_metadata' ? 'Local metadata' : 'Catalog';
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
    <span className="candidate-source"><span className={`source-badge ${candidate.book.searchSource === 'untrusted_catalog' ? 'untrusted' : ''}`}>{sourceLabel}</span><a className="candidate-link" href={candidate.book.url} target="_blank" rel="noreferrer">Details</a></span>
    <button className={isSelected ? 'primary compact' : 'secondary compact'} onClick={onSelect} disabled={isSelected}>{isSelected ? 'Selected' : 'Select'}</button>
  </div>;
}

function MatchPanel({ row, rowIndex, preferredPublisher, onSelect, onReject, hideReject = false }: { row: Row; rowIndex: number; preferredPublisher: string; onSelect: (rowIndex: number, candidate: MatchCandidate) => void; onReject: (rowIndex: number) => void; hideReject?: boolean }) {
  return <div className="match-panel">
    {!row.candidates ? <div className="match-panel-loading">Loading candidates…</div> : row.candidates.length === 0 ? <div className="match-panel-empty">No editions found.</div> : <>
      <div className="candidate-head"><span>Edition</span><span>Language</span><span>Format · Size</span><span>Popularity</span><span>Match</span><span>Source</span><span /></div>
      {row.candidates.map((candidate) => <MatchCandidateRow key={candidate.book.hash} candidate={candidate} isSelected={candidate.book.hash === row.selectedHash} preferredPublisher={preferredPublisher} onSelect={() => onSelect(rowIndex, candidate)} />)}
    </>}
    {!hideReject && <div className="match-panel-actions"><button className="skip-match" onClick={() => onReject(rowIndex)}>None of these — reject</button></div>}
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
  const [destinationPickerBusy, setDestinationPickerBusy] = useState(false);
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
  const [reviewMode, setReviewMode] = useState(false);
  const [reviewRowIndex, setReviewRowIndex] = useState<number | null>(null);
  const [searchProvider, setSearchProvider] = useState<'local_metadata' | 'untrusted_catalog' | 'disabled'>('disabled');
  const errorRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingCandidateFetches = useRef<Set<number>>(new Set());
  const reviewDialogRef = useRef<HTMLElement>(null);
  const reviewReturnFocusRef = useRef<HTMLElement | null>(null);
  const busy = runState === 'running' || scanState === 'scanning';

  useEffect(() => {
    const restoreSession = () => fetch('/api/session').then((response) => readApiResponse<{ fileName: string; rows: ImportedRow[]; destination: string; preferredPublisher: string; runState: typeof runState; scanState: typeof scanState; currentRunRow: number | null; currentScanRow: number | null; operationStartedAt: number | null; searchProvider: typeof searchProvider }>(response)).then((data) => {
      setDestination(data.destination); setSavedDestination(data.destination);
      setPreferredPublisher(data.preferredPublisher); setSavedPreferredPublisher(data.preferredPublisher);
      applyImportedRows({ fileName: data.fileName, rows: data.rows }, 0, false);
      setRunState(data.runState); setScanState(data.scanState); setCurrentRunRow(data.currentRunRow); setCurrentScanRow(data.currentScanRow); setOperationStartedAt(data.operationStartedAt);
      setSearchProvider(data.searchProvider);
    });
    void restoreSession().catch((reason) => setError(reason instanceof Error ? reason.message : 'Could not restore the current session.'));
    const events = new EventSource('/api/events');
    let eventStreamConnected = false;
    events.addEventListener('ready', () => {
      if (eventStreamConnected) {
        void restoreSession().catch((reason) => setError(reason instanceof Error ? reason.message : 'Could not resync progress after reconnecting.'));
      }
      eventStreamConnected = true;
    });
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
          status: event.status === 'failed' ? 'failed' : rejected ? 'skipped' : 'queued',
          progress: 0,
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
    if (!reviewMode || reviewRowIndex === null) return;
    const row = rows[reviewRowIndex];
    if (!row || row.matchState !== 'needs_review' || row.candidates || pendingCandidateFetches.current.has(reviewRowIndex)) return;
    pendingCandidateFetches.current.add(reviewRowIndex);
    void loadCandidates(reviewRowIndex).finally(() => pendingCandidateFetches.current.delete(reviewRowIndex));
  }, [reviewMode, reviewRowIndex, rows]);

  useEffect(() => {
    if (!reviewMode) return;
    const previousOverflow = document.body.style.overflow;
    reviewReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = 'hidden';
    const dialog = reviewDialogRef.current;
    const focusableSelector = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>(focusableSelector) ?? []);
    focusable()[0]?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeFocusedReview();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = focusable();
      if (!controls.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
      reviewReturnFocusRef.current?.focus();
    };
  }, [reviewMode]);

  const summary = useMemo(() => ({
    total: rows.length,
    completed: rows.filter((row) => row.status === 'completed').length,
    active: rows.filter((row) => row.status === 'searching' || row.status === 'awaiting_confirmation' || row.status === 'downloading').length,
    failed: rows.filter((row) => row.status === 'failed').length,
  }), [rows]);
  const overall = rows.length ? Math.round(rows.reduce((sum, row) => sum + row.progress, 0) / rows.length) : 0;
  const reviewIndexes = useMemo(() => collectReviewRowIndexes(rows), [rows]);
  const reviewPosition = reviewRowIndex === null ? -1 : reviewIndexes.indexOf(reviewRowIndex);
  const reviewRow = reviewRowIndex === null ? undefined : rows[reviewRowIndex];
  const displayedRows = useMemo(() => rows.map((row, originalIndex) => ({ row, originalIndex })).filter(({ row }) => {
    const searchable = `${row.title} ${row.author}`.toLowerCase().includes(queueSearch.trim().toLowerCase());
    if (!searchable) return false;
    if (queueFilter === 'all') return true;
    if (queueFilter === 'pending') return row.status === 'queued' && !row.matchState;
    if (queueFilter === 'matched') return row.matchState === 'matched';
    if (queueFilter === 'needs_review') return row.matchState === 'needs_review' || row.status === 'awaiting_confirmation';
    if (queueFilter === 'downloaded') return row.status === 'completed';
    if (queueFilter === 'rejected') return row.matchState === 'rejected';
    return row.status === 'failed' || row.matchState === 'failed';
  }).sort((left, right) => {
    if (!reviewFirst) return left.originalIndex - right.originalIndex;
    const leftDeferred = left.row.message?.startsWith('Review deferred') || left.row.status === 'awaiting_confirmation' || left.row.matchState === 'needs_review';
    const rightDeferred = right.row.message?.startsWith('Review deferred') || right.row.status === 'awaiting_confirmation' || right.row.matchState === 'needs_review';
    return Number(leftDeferred) - Number(rightDeferred) || left.originalIndex - right.originalIndex;
  }), [rows, queueFilter, queueSearch, reviewFirst]);

  function applyImportedRows(data: { fileName: string; rows: ImportedRow[] }, size = 0, resetControls = true) {
    setFileName(data.fileName); setFileSize(size);
    if (resetControls) {
      setRunState('idle'); setScanState('idle'); setError('');
      setStartRow(1); setExpandedMatches(new Set());
    }
    setRows(data.rows.map(importedRowToRow));
  }

  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const response = await fetch('/api/import', { method: 'POST', headers: { 'Content-Type': 'text/csv', 'X-File-Name': file.name }, body: await file.text() });
    const data = await readApiResponse<ImportResponse>(response);
    if (!response.ok) return setError(data.error || 'Could not import CSV.');
    applyImportedRows(data, file.size);
    if (data.reconciliation?.newlyDownloaded) setToast(`Found ${data.reconciliation.newlyDownloaded} existing downloads in ${data.reconciliation.libraryFolder}`);
  }

  async function useGeneratedList(csv: string, name: string) {
    const response = await fetch('/api/import', { method: 'POST', headers: { 'Content-Type': 'text/csv', 'X-File-Name': name }, body: csv });
    const data = await readApiResponse<ImportResponse>(response);
    if (!response.ok) throw new Error(data.error || 'Could not create the downloader list.');
    applyImportedRows(data, new Blob([csv]).size);
    if (data.reconciliation?.newlyDownloaded) setToast(`Found ${data.reconciliation.newlyDownloaded} existing downloads in ${data.reconciliation.libraryFolder}`);
    setTab('download');
  }

  async function start() {
    setError('');
    const response = await fetch('/api/downloads/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ startRow }) });
    const data = await readApiResponse<{ error?: string }>(response);
    if (!response.ok) setError(data.error || 'Could not start downloads.');
    else setRunState('running');
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
  async function browseDestination() {
    setDestinationPickerBusy(true); setError('');
    try {
      const response = await fetch('/api/destination/browse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initialPath: destination }) });
      const data = await readApiResponse<{ selected?: boolean; path?: string; error?: string }>(response);
      if (!response.ok) return setError(data.error || 'Could not open the folder picker.');
      if (!data.selected || !data.path) return;
      setDestination(data.path);
      setSavedDestination(data.path);
      setDestinationMode('existing');
      setToast('Download destination saved');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not open the folder picker.');
    } finally { setDestinationPickerBusy(false); }
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
    try {
      const resumeRow = scanState === 'stopped' && currentScanRow !== null ? currentScanRow + 2 : 1;
      const response = await fetch('/api/match/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ startRow: resumeRow }) });
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
    if (reviewMode) advanceFocusedReview(rowIndex, `Match selected for row ${rowIndex + 1}`);
    else setToast(`Match selected for row ${rowIndex + 1}`);
    setExpandedMatches((current) => { const next = new Set(current); next.delete(rowIndex); return next; });
  }
  async function rejectMatch(rowIndex: number) {
    if (!reviewMode && !window.confirm(`Reject row ${rowIndex + 1}? It will be skipped in future runs.`)) return;
    const response = await fetch(`/api/match/${rowIndex}/reject`, { method: 'POST' });
    const data = await readApiResponse<{ error?: string }>(response);
    if (!response.ok) setError(data.error || 'Could not reject that title.');
    else if (reviewMode) advanceFocusedReview(rowIndex, `Row ${rowIndex + 1} rejected`);
    else setToast(`Row ${rowIndex + 1} rejected`);
  }
  function openFocusedReview(rowIndex = reviewIndexes[0]) {
    if (rowIndex === undefined) return;
    setReviewRowIndex(rowIndex);
    setReviewMode(true);
  }
  function closeFocusedReview() {
    setReviewMode(false);
    setReviewRowIndex(null);
  }
  function moveFocusedReview(direction: -1 | 1) {
    if (reviewRowIndex === null) return;
    const next = adjacentReviewRow(reviewIndexes, reviewRowIndex, direction);
    if (next !== undefined) setReviewRowIndex(next);
  }
  function advanceFocusedReview(resolvedRowIndex: number, message: string) {
    const next = nextUnresolvedReviewRow(reviewIndexes, resolvedRowIndex);
    if (next === undefined) {
      closeFocusedReview();
      setToast(`${message}. All partial matches reviewed.`);
    } else {
      setReviewRowIndex(next);
      setToast(message);
    }
  }
  async function clearFile() {
    if (!window.confirm('Clear this catalog and its server working copy? Save the updated CSV first if you need it.')) return;
    const response = await fetch('/api/catalog', { method: 'DELETE' });
    const data = await readApiResponse<{ error?: string }>(response);
    if (!response.ok) return setError(data.error || 'Could not clear the catalog.');
    setRows([]); setFileName(''); setFileSize(0); setRunState('idle'); setScanState('idle'); setExpandedMatches(new Set());
    if (inputRef.current) inputRef.current.value = '';
  }
  function jumpToRow(rowNumber = startRow) { document.getElementById(`queue-row-${rowNumber}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  function retryFromRow(rowIndex: number) { setStartRow(rowIndex + 1); setQueueFilter('all'); setToast(`Start row set to ${rowIndex + 1}`); window.setTimeout(() => jumpToRow(rowIndex + 1), 0); }
  function retryFailed() { const first = rows.findIndex((row) => row.status === 'failed' || row.matchState === 'failed'); if (first >= 0) retryFromRow(first); }
  const activeRowIndex = scanState === 'scanning' ? currentScanRow : currentRunRow;
  const activeRow = activeRowIndex === null ? undefined : rows[activeRowIndex];
  const elapsedSeconds = operationStartedAt ? Math.max(0, Math.floor((now - operationStartedAt) / 1000)) : 0;
  const scanExamined = rows.filter((row) => row.matchState && row.matchState !== 'idle').length;
  const scanMatched = rows.filter((row) => row.matchState === 'matched').length;
  const scanNeedsReview = rows.filter((row) => row.matchState === 'needs_review').length;
  const scanFailed = rows.filter((row) => row.matchState === 'failed').length;
  const scanProgress = rows.length ? Math.round((scanExamined / rows.length) * 100) : 0;
  return <main className={`shell ${tab === 'builder' ? 'builder-shell' : ''}`}>
    <header className="app-header">
      <div className="brand-lockup">
        <span className="brand-mark" aria-hidden="true"><span>A</span></span>
        <div><span className="brand-kicker">Reading list workspace</span><h1>Anna Downloader</h1><p>Build, match, and manage your library queue.</p></div>
      </div>
      {tab === 'download' && <span className={`connection ${runState}`}>{runState === 'running' ? 'Downloads active' : runState === 'completed' ? 'Run complete' : runState === 'paused' ? 'Daily limit reached' : 'Ready'}</span>}
    </header>
    <nav className="workspace-tabs" aria-label="Workspace">
      <button className={tab === 'download' ? 'active' : ''} aria-pressed={tab === 'download'} onClick={() => setTab('download')}>Download CSV</button>
      <button className={tab === 'builder' ? 'active' : ''} aria-pressed={tab === 'builder'} onClick={() => setTab('builder')}>Build a book list</button>
    </nav>

    {tab === 'builder' ? <BookListBuilder onUseInDownloader={useGeneratedList} /> : <>
      {searchProvider === 'untrusted_catalog' && <div className="catalog-warning" role="status"><Icon name="alert" /><div><strong>Untrusted catalog mode is active</strong><span>Titles are sent to a third-party site. Results are treated only as MD5 leads, limited to PDF/EPUB, and always require your review before download. No API keys, cookies, or referrer are sent.</span></div></div>}
      {searchProvider === 'disabled' && <div className="catalog-warning neutral" role="status"><Icon name="alert" /><div><strong>No search provider is configured</strong><span>Preselected CSV rows can still download. Configure a local metadata index, or explicitly enable the untrusted catalog mode, to scan unmatched rows.</span></div></div>}
      {busy && <section className="operation-bar" aria-live="polite">
        <div className="operation-main"><i className="spinner" /><div><strong>{scanState === 'scanning' ? `Scanning row ${activeRowIndex === null ? '…' : activeRowIndex + 1} of ${rows.length}` : `Downloading row ${activeRowIndex === null ? '…' : activeRowIndex + 1} of ${rows.length}`}</strong><span>{activeRow ? `${activeRow.title} · ${activeRow.author}` : 'Preparing operation…'}</span></div></div>
        <div className="operation-stats">{scanState === 'scanning' ? <><span>{scanExamined} examined</span><span className="matched-stat">{scanMatched} matched</span><span>{scanNeedsReview} need review</span><span>{scanFailed} failed</span></> : <><span>{summary.completed} completed</span><span>{summary.failed} failed</span></>}<span>{Math.floor(elapsedSeconds / 60)}:{String(elapsedSeconds % 60).padStart(2, '0')}</span></div>
        <button className="secondary" onClick={scanState === 'scanning' ? stopScan : stop} disabled={stoppingScan}><Icon name="stop" />{stoppingScan ? 'Stopping…' : scanState === 'scanning' ? 'Stop scan' : 'Stop downloads'}</button>
      </section>}
      <section className="workflow" aria-label="Workflow progress"><div className={scanState === 'completed' ? 'done' : scanState === 'scanning' ? 'active' : ''}><b>1</b><span><strong>Review matches</strong><small>{scanState === 'scanning' ? `${scanExamined} of ${rows.length} examined · ${scanMatched} matched` : scanExamined ? `${scanMatched} matched · ${scanNeedsReview} need review` : 'Optional preliminary scan'}</small><span className="workflow-scan-meter" role="progressbar" aria-label={`${scanMatched} rows matched; ${scanExamined} of ${rows.length} examined`} aria-valuemin={0} aria-valuemax={Math.max(1, rows.length)} aria-valuenow={scanExamined}><i style={{ width: `${scanProgress}%` }} /></span></span></div><i /><div className={runState === 'completed' ? 'done' : runState === 'running' ? 'active' : ''}><b>2</b><span><strong>Download editions</strong><small>{runState === 'completed' ? 'Run complete' : runState === 'running' ? `Working on row ${(currentRunRow ?? 0) + 1}` : 'Download selected matches'}</small></span></div></section>
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
          {reviewIndexes.length > 0 && <button className="primary review-matches" onClick={() => openFocusedReview()}>{`Review ${reviewIndexes.length} partial ${reviewIndexes.length === 1 ? 'match' : 'matches'}`}</button>}
          {scanState === 'scanning' ? <button className="secondary" onClick={stopScan} disabled={stoppingScan}><Icon name="stop" />{stoppingScan ? 'Stopping…' : 'Stop scan'}</button> : <button className="secondary" disabled={!rows.length || runState === 'running'} onClick={startScan}><Icon name="play" />{scanState === 'stopped' && currentScanRow !== null ? `Resume after row ${currentScanRow + 1}` : 'Scan matches'}</button>}
        </div>
      </section>
      <section className="destination-panel" aria-label="Download destination">
        <div className="destination-heading"><div><strong>Download destination</strong><span>Browse to an existing folder or enter a path for a new one.</span></div>{savedDestination && <span className="destination-ready"><Icon name="check" />Ready</span>}</div>
        <div className="destination-modes" role="radiogroup" aria-label="Destination type">
          <label><input type="radio" name="destination-mode" checked={destinationMode === 'existing'} onChange={() => setDestinationMode('existing')} disabled={runState === 'running'} />Use existing folder</label>
          <label><input type="radio" name="destination-mode" checked={destinationMode === 'create'} onChange={() => setDestinationMode('create')} disabled={runState === 'running'} />Create new folder</label>
        </div>
        <div className="destination-entry"><input aria-label="Destination folder path" value={destination} onChange={(event) => setDestination(event.target.value)} placeholder="C:\\Users\\User\\Desktop\\Books" disabled={runState === 'running' || destinationPickerBusy} /><button className="secondary browse-folder" onClick={browseDestination} disabled={destinationBusy || destinationPickerBusy || runState === 'running'}><Icon name="folder" />{destinationPickerBusy ? 'Choose a folder in the open dialog…' : 'Browse…'}</button><button className="secondary save-destination" onClick={saveDestination} disabled={!destination.trim() || destinationBusy || destinationPickerBusy || runState === 'running'}>{destinationBusy ? 'Saving…' : destinationMode === 'create' ? 'Create and use' : 'Use folder'}</button></div>
        {savedDestination && <small>Downloads will be saved to <strong>{savedDestination}</strong></small>}
      </section>
      {error && <div className="error-banner" role="alert" tabIndex={-1} ref={errorRef}><Icon name="alert" /><div><strong>Action failed</strong><span>{error}</span></div><button className="icon-button" onClick={() => setError('')} aria-label="Dismiss error"><Icon name="close" /></button></div>}
      <section className="summary" aria-label="Download summary"><div><span>Total</span><strong>{summary.total}</strong></div><div><span>Completed</span><strong className="green">{summary.completed}</strong></div><div><span>In progress</span><strong className="blue">{summary.active}</strong></div><div><span>Failed</span><strong className="red">{summary.failed}</strong></div></section>
      <footer className="run-footer"><div className="actions"><label className="start-row"><span>Start at row</span><span className="start-row-controls"><input type="number" min={1} max={Math.max(1, rows.length)} value={startRow} onChange={(event) => setStartRow(Math.max(1, Math.min(Math.max(1, rows.length), Number(event.target.value) || 1)))} disabled={!rows.length || busy} /><button className="secondary compact" onClick={() => jumpToRow()} disabled={!rows.length}>Jump</button></span></label><button className="primary" disabled={!rows.length || !savedDestination || destination !== savedDestination || busy} onClick={start}><Icon name="play" />Start downloads</button><button className="secondary" disabled={runState !== 'running'} onClick={stop}><Icon name="stop" />Stop</button><a className={`secondary catalog-download ${!rows.length ? 'disabled' : ''}`} href={rows.length ? '/api/catalog' : undefined} download onClick={() => rows.length && setToast('Updated CSV downloaded')}>Save updated CSV</a></div><div className="overall"><div><strong>Download progress</strong><span>{overall}%</span></div><div className="track"><i style={{ width: `${overall}%` }} /></div></div></footer>
      <section className="queue-tools" aria-label="Queue filters"><div className="filter-tabs">{(['all','pending','matched','needs_review','downloaded','failed','rejected'] as QueueFilter[]).map((filter) => <button key={filter} className={queueFilter === filter ? 'active' : ''} aria-pressed={queueFilter === filter} onClick={() => setQueueFilter(filter)}>{filter === 'needs_review' ? 'Needs review' : filter[0].toUpperCase() + filter.slice(1)}</button>)}</div>{summary.failed > 0 && <button className="secondary retry-failed" onClick={retryFailed}>Retry failed</button>}<span className="queue-count">{displayedRows.length} of {rows.length} books</span><input type="search" value={queueSearch} onChange={(event) => setQueueSearch(event.target.value)} placeholder="Search title or author" aria-label="Search queue" /><label><input type="checkbox" checked={reviewFirst} onChange={(event) => setReviewFirst(event.target.checked)} />Review items last</label></section>
      <section className="queue" aria-label="Book download queue">
        <div className="table-head"><span>Row</span><span>Book</span><span>Author</span><span>Format</span><span>Status</span><span>Progress</span></div>
        {rows.length === 0 ? <div className="empty"><div className="empty-file"><Icon name="file" /></div><h2>Your download queue is empty</h2><p>Choose a CSV file to review books before downloading.</p></div> : displayedRows.map(({ row, originalIndex }) => {
          const panelOpen = expandedMatches.has(originalIndex);
          return <div className="queue-item" id={`queue-row-${originalIndex + 1}`} key={`${row.title}-${row.author}-${originalIndex}`}>
            {originalIndex + 1 === startRow && <div className="start-divider"><span>Downloads start here</span></div>}
            <div className={`book-row row-${row.status}`}>
              <button className="row-number" title={`Set start row to ${originalIndex + 1}`} onClick={() => setStartRow(originalIndex + 1)}>#{originalIndex + 1}</button>
              <div className="book">
                <strong>{row.title}</strong>
                {row.matchTitle && <small className="match-detail" title={`${row.matchTitle} — ${row.matchAuthors || ''}`}>Match: {row.matchTitle}{row.matchPublisher ? ` · ${row.matchPublisher}` : ''}{row.matchPublisher && isPreferredPublisher(row.matchPublisher, savedPreferredPublisher) && <em className="publisher-badge">{savedPreferredPublisher.trim()}</em>} · {Math.round((row.confidence || 0) * 100)}%</small>}
                {row.matchState === 'scanning' && <small className="match-detail">Scanning for editions…</small>}
                {row.matchState === 'rejected' && <small className="match-detail">No acceptable match found</small>}
                {row.matchState && row.matchState !== 'scanning' && <button className="link-button" aria-expanded={panelOpen} aria-controls={`match-panel-${originalIndex}`} onClick={() => row.matchState === 'needs_review' ? openFocusedReview(originalIndex) : toggleExpanded(originalIndex)}>{row.matchState === 'needs_review' ? 'Review candidates' : panelOpen ? 'Hide candidates' : row.matchState === 'rejected' ? 'Review again' : 'Change match'}</button>}
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
      {reviewMode && reviewRow && reviewRowIndex !== null && <div className="review-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeFocusedReview(); }}>
        <section className="review-dialog" ref={reviewDialogRef} role="dialog" aria-modal="true" aria-labelledby="review-dialog-title" aria-describedby="review-dialog-description">
          <header className="review-dialog-header">
            <div><span>Partial match {Math.max(1, reviewPosition + 1)} of {reviewIndexes.length} · CSV row #{reviewRowIndex + 1}</span><h2 id="review-dialog-title">{reviewRow.title}</h2><p>{reviewRow.author}</p></div>
            <button className="icon-button" onClick={closeFocusedReview} aria-label="Close match review"><Icon name="close" /></button>
          </header>
          <div className="review-dialog-toolbar">
            <span id="review-dialog-description">Select the correct edition below. Your choice is saved immediately.</span>
            <div><button className="secondary compact" onClick={() => moveFocusedReview(-1)} disabled={reviewIndexes.length < 2}>Previous</button><button className="secondary compact" onClick={() => moveFocusedReview(1)} disabled={reviewIndexes.length < 2}>Next</button><button className="skip-match compact" onClick={() => rejectMatch(reviewRowIndex)}>None match — reject</button></div>
          </div>
          <MatchPanel row={reviewRow} rowIndex={reviewRowIndex} preferredPublisher={savedPreferredPublisher} onSelect={selectCandidate} onReject={rejectMatch} hideReject />
        </section>
      </div>}
      <div className="sr-only" aria-live="polite">{scanState === 'scanning' ? `Scanned ${scanExamined} of ${rows.length} rows` : ''}</div>
      {toast && <div className="toast" role="status">{toast}</div>}
    </>}
  </main>;
}

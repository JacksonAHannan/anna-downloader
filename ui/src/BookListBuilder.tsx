import { FormEvent, useEffect, useMemo, useState } from 'react';
import { readApiResponse } from './api';

type LLMProvider = { id: string; label: string; configured: boolean; model: string };
type GeneratedBook = { id: string; author: string; title: string; reason: string };

function csvCell(value: string) { return `"${value.replace(/"/g, '""')}"`; }
function booksToCSV(books: GeneratedBook[]) {
  return `author,title\r\n${books.map((book) => `${csvCell(book.author)},${csvCell(book.title)}`).join('\r\n')}\r\n`;
}
function fileSlug(value: string) { return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'books'; }
function bookId(book: { author: string; title: string }) { return `${book.author.trim().toLowerCase()}|${book.title.trim().toLowerCase()}`; }

export function BookListBuilder({ onUseInDownloader }: { onUseInDownloader: (csv: string, name: string) => Promise<void> }) {
  const [providers, setProviders] = useState<LLMProvider[]>([]);
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [count, setCount] = useState(20);
  const [books, setBooks] = useState<GeneratedBook[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(false);
  const [loadingProviders, setLoadingProviders] = useState(true);
  const [error, setError] = useState('');
  const [hasGenerated, setHasGenerated] = useState(false);
  const [transferMessage, setTransferMessage] = useState('');
  const [lastProviderLabel, setLastProviderLabel] = useState('');

  useEffect(() => {
    fetch('/api/llm/providers')
      .then((response) => readApiResponse<{ providers: LLMProvider[]; error?: string }>(response).then((data) => ({ response, data })))
      .then(({ response, data }) => {
        if (!response.ok) throw new Error(data.error || 'Could not load LLM providers.');
        setProviders(data.providers);
        const first = data.providers.find((provider) => provider.configured);
        if (first) { setProviderId(first.id); setModel(first.model); }
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : 'Could not load LLM providers.'))
      .finally(() => setLoadingProviders(false));
  }, []);

  const selectedBooks = useMemo(() => books.filter((book) => selected.has(book.id)), [books, selected]);
  const allSelected = books.length > 0 && books.every((book) => selected.has(book.id));
  const selectedProvider = providers.find((provider) => provider.id === providerId);
  const configuredCount = providers.filter((provider) => provider.configured).length;

  function changeProvider(nextId: string) {
    setProviderId(nextId);
    setModel(providers.find((provider) => provider.id === nextId)?.model || '');
  }

  async function generate(append: boolean) {
    if (!prompt.trim()) { setError('Describe the book list you want.'); return; }
    if (!selectedProvider?.configured) { setError('Choose a provider with a configured API key.'); return; }
    setLoading(true); setError(''); setTransferMessage('');
    try {
      const response = await fetch('/api/llm/book-list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: providerId,
          model,
          prompt: prompt.trim(),
          count,
          excludedTitles: append ? books.map((book) => book.title) : [],
        }),
      });
      const data = await readApiResponse<{ books: Array<Omit<GeneratedBook, 'id'>>; provider: string; model: string; error?: string }>(response);
      if (!response.ok) throw new Error(data.error || 'The LLM could not generate a book list.');
      const generated = data.books.map((book) => ({ ...book, id: bookId(book) }));
      setBooks((current) => append
        ? [...current, ...generated.filter((next) => !current.some((book) => book.id === next.id))]
        : generated);
      setSelected((current) => append ? new Set([...current, ...generated.map((book) => book.id)]) : new Set(generated.map((book) => book.id)));
      setHasGenerated(true);
      setModel(data.model);
      setLastProviderLabel(providers.find((provider) => provider.id === data.provider)?.label || data.provider);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The LLM could not generate a book list.');
    } finally { setLoading(false); }
  }

  function submit(event: FormEvent) { event.preventDefault(); void generate(false); }
  function toggle(id: string) { setSelected((current) => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; }); }
  function toggleAll() { setSelected(allSelected ? new Set() : new Set(books.map((book) => book.id))); }
  function downloadCSV() {
    const csv = booksToCSV(selectedBooks);
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${fileSlug(prompt)}-books.csv`; anchor.click(); URL.revokeObjectURL(url);
  }
  async function useInDownloader() {
    try {
      setTransferMessage('');
      await onUseInDownloader(booksToCSV(selectedBooks), `${fileSlug(prompt)}-books.csv`);
    } catch (caught) { setTransferMessage(caught instanceof Error ? caught.message : 'Could not create downloader list.'); }
  }

  return <section className="builder" aria-label="Build a book list with an LLM">
    <div className="builder-intro">
      <span>AI-assisted curation</span>
      <h2>Shape a reading list around your question.</h2>
      <p>Describe the subject, audience, depth, and viewpoints you want represented. Review every suggestion before exporting it or moving it into the downloader.</p>
    </div>
    <form className="book-search llm-book-search" onSubmit={submit}>
      <label><span>LLM provider</span><select value={providerId} onChange={(event) => changeProvider(event.target.value)} disabled={loadingProviders || loading}>
        {!providerId && <option value="">No configured provider</option>}
        {providers.map((provider) => <option value={provider.id} key={provider.id} disabled={!provider.configured}>{provider.label}{provider.configured ? '' : ' — key missing'}</option>)}
      </select></label>
      <label><span>Model</span><input value={model} onChange={(event) => setModel(event.target.value)} placeholder="Provider model name" disabled={!providerId || loading} /></label>
      <label className="count-label"><span>Number of books</span><select value={count} onChange={(event) => setCount(Number(event.target.value))} disabled={loading}><option value="10">10</option><option value="20">20</option><option value="30">30</option><option value="50">50</option><option value="75">75</option><option value="100">100</option></select></label>
      <label className="prompt-label"><span>Describe the list</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={4000} placeholder="Example: Build a graduate-level reading list on urban housing supply, zoning reform, land-use economics, and the YIMBY movement. Include foundational books, empirical work, and thoughtful critiques." /></label>
      <div className="llm-submit"><button className="primary search-button" type="submit" disabled={loading || !selectedProvider?.configured || !prompt.trim()}>{loading ? 'Generating…' : 'Generate book list'}</button><small>API keys stay on this local server and are never sent to the browser. {configuredCount} provider{configuredCount === 1 ? '' : 's'} configured.</small></div>
    </form>

    {error && <div className="builder-message error-builder" role="alert">{error}</div>}
    {transferMessage && <div className="builder-message error-builder" role="alert">{transferMessage}</div>}

    <div className="results-frame">
      <div className="selection-toolbar">
        <label className="check-label"><input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={!books.length} />Select all {books.length ? `${books.length} generated books` : 'books'}</label>
        <span className="selection-count">{selected.size} selected</span>
        {hasGenerated && <span className="total-results">Generated by {lastProviderLabel || selectedProvider?.label}{model ? ` · ${model}` : ''}</span>}
        <div className="selection-actions"><button className="secondary compact" disabled={!selected.size} onClick={downloadCSV}>Download CSV</button><button className="primary compact" disabled={!selected.size} onClick={useInDownloader}>Use in downloader</button></div>
      </div>
      <div className="result-head llm-result-head"><span></span><span>Title &amp; author</span><span>Why it belongs</span></div>

      {!books.length && !loading ? <div className="builder-empty"><h2>{hasGenerated ? 'No books generated' : 'Generate a curated book list'}</h2><p>Describe a topic, audience, level, perspective, exclusions, or desired balance. The selected LLM will return a downloader-ready list you can review first.</p></div> : books.map((book) => {
        const isSelected = selected.has(book.id);
        return <label className={`result-row llm-result-row ${isSelected ? 'selected' : ''}`} key={book.id}>
          <input type="checkbox" checked={isSelected} onChange={() => toggle(book.id)} aria-label={`Select ${book.title}`} />
          <div className="result-identity"><div className="cover-placeholder" aria-hidden="true">Aa</div><div><strong>{book.title}</strong><span>{book.author}</span></div></div>
          <span className="description">{book.reason || 'Recommended for the requested list.'}</span>
        </label>;
      })}
      {loading && <div className="loading-results" aria-live="polite"><i/><span>Generating and validating book suggestions…</span></div>}
    </div>
    {books.length > 0 && <button className="load-more secondary" disabled={loading} onClick={() => void generate(true)}>Generate {count} more without duplicates</button>}
  </section>;
}

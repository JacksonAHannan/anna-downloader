import { FormEvent, useMemo, useState } from 'react';
import { readApiResponse } from './api';

type SearchField = 'keyword' | 'subject' | 'author' | 'title' | 'publisher' | 'isbn';
type GoogleBook = {
  id: string; title: string; authors: string[]; publishedDate: string; categories: string[];
  description: string; thumbnail: string; publisher: string; isbn: string;
};

const fieldOptions: Array<{ value: SearchField; label: string }> = [
  { value: 'keyword', label: 'Any keyword' },
  { value: 'subject', label: 'Topic / genre' },
  { value: 'author', label: 'Author' },
  { value: 'title', label: 'Title' },
  { value: 'publisher', label: 'Publisher' },
  { value: 'isbn', label: 'ISBN' },
];

function csvCell(value: string) { return `"${value.replace(/"/g, '""')}"`; }
function booksToCSV(books: GoogleBook[]) {
  return `author,title\r\n${books.map((book) => `${csvCell(book.authors.join('; '))},${csvCell(book.title)}`).join('\r\n')}\r\n`;
}
function fileSlug(value: string) { return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'books'; }

export function BookListBuilder({ onUseInDownloader }: { onUseInDownloader: (csv: string, name: string) => Promise<void> }) {
  const [field, setField] = useState<SearchField>('subject');
  const [query, setQuery] = useState('');
  const [pageSize, setPageSize] = useState(20);
  const [books, setBooks] = useState<GoogleBook[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [totalItems, setTotalItems] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [hasSearched, setHasSearched] = useState(false);
  const [transferMessage, setTransferMessage] = useState('');

  const selectedBooks = useMemo(() => books.filter((book) => selected.has(book.id)), [books, selected]);
  const allSelected = books.length > 0 && books.every((book) => selected.has(book.id));
  const resultLabel = totalItems > 1000 ? `${totalItems.toLocaleString()}+` : totalItems.toLocaleString();

  async function fetchBooks(startIndex: number, append: boolean) {
    if (!query.trim()) { setError('Enter a search query.'); return; }
    setLoading(true); setError(''); setTransferMessage('');
    try {
      const params = new URLSearchParams({ query: query.trim(), field, startIndex: String(startIndex), maxResults: String(pageSize) });
      const response = await fetch(`/api/google-books/search?${params}`);
      const data = await readApiResponse<{ books: GoogleBook[]; totalItems: number; error?: string }>(response);
      if (!response.ok) throw new Error(data.error || 'Google Books search failed.');
      setBooks((current) => append ? [...current, ...data.books.filter((next: GoogleBook) => !current.some((book) => book.id === next.id))] : data.books);
      setTotalItems(data.totalItems); setHasSearched(true);
      if (!append) setSelected(new Set());
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Google Books search failed.'); }
    finally { setLoading(false); }
  }

  function search(event: FormEvent) { event.preventDefault(); void fetchBooks(0, false); }
  function toggle(id: string) { setSelected((current) => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; }); }
  function toggleAll() { setSelected(allSelected ? new Set() : new Set(books.map((book) => book.id))); }
  function downloadCSV() {
    const csv = booksToCSV(selectedBooks); const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${fileSlug(query)}-books.csv`; anchor.click(); URL.revokeObjectURL(url);
  }
  async function useInDownloader() {
    try { setTransferMessage(''); await onUseInDownloader(booksToCSV(selectedBooks), `${fileSlug(query)}-books.csv`); }
    catch (caught) { setTransferMessage(caught instanceof Error ? caught.message : 'Could not create downloader list.'); }
  }

  return <section className="builder" aria-label="Build a book list">
    <form className="book-search" onSubmit={search}>
      <label><span>Search by</span><select value={field} onChange={(event) => setField(event.target.value as SearchField)}>{fieldOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
      <label className="query-label"><span>Search query</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={field === 'subject' ? 'e.g. Victorian science fiction' : `Search by ${field}`} /></label>
      <button className="primary search-button" type="submit" disabled={loading}>{loading ? 'Searching…' : 'Search books'}</button>
      <label className="page-size"><span>Results per page</span><select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}><option value="10">10</option><option value="20">20</option><option value="40">40</option></select></label>
    </form>

    {error && <div className="builder-message error-builder" role="alert">{error}</div>}
    {transferMessage && <div className="builder-message error-builder" role="alert">{transferMessage}</div>}

    <div className="results-frame">
      <div className="selection-toolbar">
        <label className="check-label"><input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={!books.length} />Select all {books.length ? `${books.length} loaded results` : 'results'}</label>
        <span className="selection-count">{selected.size} selected</span>
        {hasSearched && <span className="total-results">{resultLabel} Google Books matches</span>}
        <div className="selection-actions"><button className="secondary compact" disabled={!selected.size} onClick={downloadCSV}>Download CSV</button><button className="primary compact" disabled={!selected.size} onClick={useInDownloader}>Use in downloader</button></div>
      </div>
      <div className="result-head"><span></span><span>Title &amp; author</span><span>Published</span><span>Categories</span><span>Description</span></div>

      {!books.length && !loading ? <div className="builder-empty"><h2>{hasSearched ? 'No books found' : 'Search Google Books'}</h2><p>{hasSearched ? 'Try a broader query or another search category.' : 'Find books by topic, genre, author, title, publisher, ISBN, or any keyword.'}</p></div> : books.map((book) => {
        const isSelected = selected.has(book.id);
        return <label className={`result-row ${isSelected ? 'selected' : ''}`} key={book.id}>
          <input type="checkbox" checked={isSelected} onChange={() => toggle(book.id)} aria-label={`Select ${book.title}`} />
          <div className="result-identity">{book.thumbnail ? <img src={book.thumbnail} alt="" loading="lazy" /> : <div className="cover-placeholder" aria-hidden="true">Aa</div>}<div><strong>{book.title}</strong><span>{book.authors.join('; ')}</span>{book.publisher && <small>{book.publisher}</small>}</div></div>
          <span>{book.publishedDate || '—'}</span>
          <span className="categories">{book.categories.length ? book.categories.join('; ') : '—'}</span>
          <span className="description">{book.description || 'No description available.'}</span>
        </label>;
      })}
      {loading && <div className="loading-results" aria-live="polite"><i/><span>Searching Google Books…</span></div>}
    </div>
    {books.length > 0 && books.length < totalItems && <button className="load-more secondary" disabled={loading} onClick={() => fetchBooks(books.length, true)}>Load more</button>}
  </section>;
}

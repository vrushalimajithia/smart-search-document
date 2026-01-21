import { useState, useEffect } from 'react';
import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || '';

interface SearchResult {
  answer: string;
  source: string;
  confidence: number;
  score?: number;
}

interface SearchInterfaceProps {
  clearTrigger?: number;
}

const SearchInterface = ({ clearTrigger }: SearchInterfaceProps) => {
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Clear search results when documents are cleared
  useEffect(() => {
    if (clearTrigger && clearTrigger > 0) {
      setResult(null);
      setError(null);
      setQuery('');
    }
  }, [clearTrigger]);

  const handleClear = () => {
    setQuery('');
    setResult(null);
    setError(null);
  };

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!query.trim()) {
      setError('Please enter a search query');
      return;
    }

    setSearching(true);
    setError(null);
    setResult(null);

    try {
      const response = await axios.post(`${API_URL}/api/search`, {
        query: query.trim()
      });

      // Handle single result
      if (response.data.answer) {
        setResult({
          answer: response.data.answer,
          source: response.data.source,
          confidence: response.data.confidence
        });
      } else {
        setError('No results found. Please try a different query or upload some documents first.');
      }
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error performing search');
    } finally {
      setSearching(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-gray-800">
          Search Documents
        </h2>
        {(result || error || query.trim()) && (
          <button
            onClick={handleClear}
            className="text-sm text-red-600 hover:text-red-800 font-medium"
          >
            Clear
          </button>
        )}
      </div>

      <form onSubmit={handleSearch} className="mb-6">
        <div className="flex gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Enter your search query..."
            className="flex-1 px-4 py-3 border border-gray-300 rounded-lg
              focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-lg"
            disabled={searching}
          />
          <button
            type="submit"
            disabled={searching || !query.trim()}
            className="bg-blue-600 text-white px-8 py-3 rounded-lg
              hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed
              transition-colors font-medium text-lg"
          >
            {searching ? 'Searching...' : 'Search'}
          </button>
        </div>
      </form>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded-lg mb-4">
          {error}
        </div>
      )}

      {/* Display single result */}
      {result && (
        <div className="border border-gray-200 rounded-lg p-6 hover:shadow-md transition-shadow bg-white">
          <div className="flex items-start justify-between mb-4">
            <div className="flex items-center gap-3">
              <span className="bg-purple-100 text-purple-800 text-sm font-semibold px-3 py-1 rounded">
                {result.source}
              </span>
            </div>
          </div>
          <div className="bg-gray-50 rounded-lg p-4">
            <p className="text-gray-800 leading-relaxed whitespace-pre-wrap">
              {result.answer}
            </p>
          </div>
        </div>
      )}

      {!searching && !result && !error && (
        <div className="text-center py-12 text-gray-500">
          <p>Enter a query above to search through your uploaded documents</p>
          <p className="text-sm mt-2">The system will return the best matching snippet with source file name</p>
        </div>
      )}
    </div>
  );
};

export default SearchInterface;

import { useState, useEffect } from 'react';
import axios from 'axios';

interface DocumentInfo {
  name: string;
  size: number;
}

interface DocumentListProps {
  refreshTrigger: number;
  onDocumentsCleared?: () => void;
}

const DocumentList = ({ refreshTrigger, onDocumentsCleared }: DocumentListProps) => {
  const [documents, setDocuments] = useState<DocumentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchDocuments();
  }, [refreshTrigger]);

  const fetchDocuments = async () => {
    try {
      setLoading(true);
      const response = await axios.get('/api/documents');
      // Use documentsWithSize if available, otherwise fallback to documents array
      if (response.data.documentsWithSize) {
        setDocuments(response.data.documentsWithSize);
      } else if (response.data.documents) {
        // Fallback: convert string array to DocumentInfo array
        setDocuments(response.data.documents.map((name: string) => ({ name, size: 0 })));
      } else {
        setDocuments([]);
      }
      setError(null);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error fetching documents');
    } finally {
      setLoading(false);
    }
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return 'Unknown size';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const handleDelete = async (fileName: string) => {
    if (!confirm(`Are you sure you want to delete "${fileName}"?`)) {
      return;
    }

    try {
      // Encode the fileName to handle special characters
      const encodedFileName = encodeURIComponent(fileName);
      await axios.delete(`/api/documents/${encodedFileName}`);
      // Refresh the document list
      await fetchDocuments();
      setError(null);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error deleting document');
    }
  };

  const handleClear = async () => {
    if (!confirm('Are you sure you want to clear all documents?')) {
      return;
    }

    try {
      await axios.delete('/api/documents/clear');
      // Refresh the document list to ensure it's cleared
      await fetchDocuments();
      setError(null);
      // Notify parent component that documents were cleared
      if (onDocumentsCleared) {
        onDocumentsCleared();
      }
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error clearing documents');
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold text-gray-800">
          Uploaded Documents
        </h2>
        {documents.length > 0 && (
          <button
            onClick={handleClear}
            className="text-sm text-red-600 hover:text-red-800 font-medium"
          >
            Clear All
          </button>
        )}
      </div>

      {loading ? (
        <p className="text-gray-500 text-sm">Loading...</p>
      ) : error ? (
        <p className="text-red-600 text-sm">{error}</p>
      ) : documents.length === 0 ? (
        <p className="text-gray-500 text-sm">
          No documents uploaded yet. Upload some documents to get started.
        </p>
      ) : (
        <ul className="space-y-2">
          {documents.map((doc, index) => (
            <li
              key={index}
              className="text-sm text-gray-700 bg-gray-50 px-3 py-2 rounded flex items-center justify-between gap-2 group hover:bg-gray-100 transition-colors"
              title={doc.name}
            >
              <span className="truncate flex-1">📄 {doc.name}</span>
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className="text-xs text-gray-500">
                  {formatFileSize(doc.size)}
                </span>
                <button
                  onClick={() => handleDelete(doc.name)}
                  className="text-red-500 hover:text-red-700 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-red-50"
                  title={`Delete ${doc.name}`}
                  aria-label={`Delete ${doc.name}`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {documents.length > 0 && (
        <p className="text-xs text-gray-500 mt-4">
          Total: {documents.length} document(s)
        </p>
      )}
    </div>
  );
};

export default DocumentList;

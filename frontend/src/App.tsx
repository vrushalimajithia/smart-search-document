import { useState } from 'react';
import DocumentUpload from './components/DocumentUpload';
import SearchInterface from './components/SearchInterface';
import DocumentList from './components/DocumentList';

function App() {
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [clearTrigger, setClearTrigger] = useState(0);

  const handleUploadSuccess = () => {
    setRefreshTrigger(prev => prev + 1);
  };

  const handleDocumentsCleared = () => {
    setClearTrigger(prev => prev + 1);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
      <div className="container mx-auto px-4 py-8">
        <div className="max-w-4xl mx-auto">
          <div className="bg-white rounded-lg shadow-xl p-8">
            <header className="text-center mb-8">
              <div className="flex items-center justify-center gap-3 mb-3">
                <svg className="w-8 h-8 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <h1 className="text-4xl font-bold text-gray-800">
                  Smart Document Search Agent
                </h1>
              </div>
              <p className="text-gray-600 text-lg">
                Upload documents and search for relevant information using AI
              </p>
            </header>

            <div className="space-y-6">
              <DocumentUpload onUploadSuccess={handleUploadSuccess} clearTrigger={clearTrigger} />
              <DocumentList refreshTrigger={refreshTrigger} onDocumentsCleared={handleDocumentsCleared} />
              <SearchInterface clearTrigger={clearTrigger} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;

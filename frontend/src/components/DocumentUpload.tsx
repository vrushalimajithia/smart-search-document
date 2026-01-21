import { useState, useEffect, useRef } from 'react';
import axios from 'axios';

interface DocumentUploadProps {
  onUploadSuccess: () => void;
  clearTrigger?: number;
}

const DocumentUpload = ({ onUploadSuccess, clearTrigger }: DocumentUploadProps) => {
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Clear message and file input when documents are cleared
  useEffect(() => {
    if (clearTrigger && clearTrigger > 0) {
      setMessage(null);
      setFiles([]);
      // Reset the file input element
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }, [clearTrigger]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const selectedFiles = Array.from(e.target.files);
      
      // Enforce 10 file limit
      if (selectedFiles.length > 10) {
        setMessage({ 
          type: 'error', 
          text: `You can only upload up to 10 files at a time. You selected ${selectedFiles.length} files. Please select 10 or fewer files.` 
        });
        // Reset the input
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
        setFiles([]);
        return;
      }
      
      // Filter valid file types and check file sizes
      const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
      const validFiles: File[] = [];
      const invalidFiles: string[] = [];
      const oversizedFiles: string[] = [];
      
      selectedFiles.forEach(file => {
        const ext = file.name.toLowerCase().split('.').pop();
        if (ext !== 'pdf' && ext !== 'txt' && ext !== 'docx') {
          invalidFiles.push(file.name);
          return;
        }
        
        if (file.size > MAX_FILE_SIZE) {
          oversizedFiles.push(`${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
          return;
        }
        
        validFiles.push(file);
      });
      
      // Show error messages if any
      if (invalidFiles.length > 0 || oversizedFiles.length > 0) {
        const errors: string[] = [];
        if (invalidFiles.length > 0) {
          errors.push(`Invalid file type: ${invalidFiles.join(', ')}`);
        }
        if (oversizedFiles.length > 0) {
          errors.push(`Files too large (>10MB): ${oversizedFiles.join(', ')}`);
        }
        setMessage({ 
          type: 'error', 
          text: errors.join('\n') 
        });
      } else {
        setMessage(null);
      }
      
      setFiles(validFiles);
    }
  };

  const handleUpload = async () => {
    if (files.length === 0) {
      setMessage({ type: 'error', text: 'Please select at least one file' });
      return;
    }

    setUploading(true);
    setMessage(null);

    try {
      const formData = new FormData();
      files.forEach(file => {
        formData.append('documents', file);
      });

      console.log('Starting upload...', files.length, 'files');
      console.log('File names:', files.map(f => f.name));
      
      const response = await axios.post('/api/upload/multiple', formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
        timeout: 300000, // 5 minutes timeout for large files
        onUploadProgress: (progressEvent) => {
          if (progressEvent.total) {
            const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total);
            console.log(`Upload progress: ${percentCompleted}%`);
          }
        }
      });
      
      console.log('Upload response received:', response.data);

      if (response.data.results) {
        const successCount = response.data.results.filter((r: any) => r.status === 'success').length;
        const errorResults = response.data.results.filter((r: any) => r.error);
        const errorCount = errorResults.length;
        
        if (successCount > 0) {
          let errorMessage = '';
          if (errorCount > 0) {
            const errorDetails = errorResults
              .map((r: any) => `✗ ${r.fileName || 'Unknown file'}: ${r.error || 'Unknown error'}${r.fileSize ? ` (Size: ${r.fileSize})` : ''}`)
              .join('\n');
            errorMessage = `\n\n⚠️ Failed to upload ${errorCount} file(s):\n${errorDetails}`;
          }
          setMessage({
            type: errorCount > 0 ? 'error' : 'success',
            text: `✓ Successfully uploaded ${successCount} of ${files.length} file(s)${errorMessage}`
          });
          setFiles([]);
          // Clear the file input
          if (fileInputRef.current) {
            fileInputRef.current.value = '';
          }
          onUploadSuccess();
        } else {
          // All files failed - show detailed error messages
          const errorMessages = errorResults
            .map((r: any) => `• ${r.fileName || 'Unknown file'}: ${r.error || 'Unknown error'}${r.fileSize ? ` (${r.fileSize})` : ''}`)
            .join('\n');
          setMessage({
            type: 'error',
            text: `Upload failed for all files:\n${errorMessages || 'Unknown error occurred'}`
          });
        }
      } else {
        // Unexpected response format
        setMessage({
          type: 'error',
          text: 'Unexpected response from server. Please try again.'
        });
      }
    } catch (error: any) {
      let errorMessage = 'Error uploading files';
      
      if (error.code === 'ECONNABORTED') {
        errorMessage = 'Upload timeout - files are too large or processing is taking too long. Please try uploading fewer files at once.';
      } else if (error.response) {
        const responseData = error.response.data;
        // Check if server provided details about which file is too large
        if (responseData?.details) {
          errorMessage = responseData.details;
        } else if (responseData?.fileName) {
          errorMessage = `File "${responseData.fileName}" is too large. Maximum size is 10MB. Please remove it and try again.`;
        } else {
          errorMessage = responseData?.error || `Server error: ${error.response.status}`;
        }
      } else if (error.request) {
        errorMessage = 'Cannot connect to server. Please make sure the backend is running on port 3001.';
      } else {
        errorMessage = error.message || 'Error uploading files';
      }
      
      setMessage({
        type: 'error',
        text: errorMessage
      });
    } finally {
      setUploading(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    
    if (e.dataTransfer.files) {
      const droppedFiles = Array.from(e.dataTransfer.files);
      const fileInput = fileInputRef.current;
      if (fileInput) {
        const dataTransfer = new DataTransfer();
        droppedFiles.forEach(file => dataTransfer.items.add(file));
        fileInput.files = dataTransfer.files;
        const event = new Event('change', { bubbles: true });
        fileInput.dispatchEvent(event);
      }
    }
  };

  return (
    <div>
      <h2 className="text-xl font-semibold text-gray-800 mb-6">
        Upload Documents
      </h2>
      
      <div className="space-y-4">
        {/* Drag & Drop Area */}
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`border-2 border-dashed rounded-lg p-12 text-center transition-colors ${
            isDragging 
              ? 'border-blue-500 bg-blue-50' 
              : 'border-blue-400 bg-white'
          }`}
        >
          <div className="flex flex-col items-center">
            {/* Yellow Folder Icon */}
            <svg className="w-20 h-20 text-yellow-400 mb-4" fill="currentColor" viewBox="0 0 20 20">
              <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
            </svg>
            <p className="text-gray-700 font-medium mb-2">
              Drag & Drop your document here
            </p>
            <p className="text-gray-500 mb-4">or</p>
            <label className="cursor-pointer">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".pdf,.txt,.docx"
                onChange={handleFileChange}
                className="hidden"
              />
              <span className="inline-block bg-blue-600 text-white px-6 py-2 rounded-lg font-medium hover:bg-blue-700 transition-colors">
                Choose File
              </span>
            </label>
            <p className="text-xs text-gray-500 mt-3">
              Select PDF, TXT, or DOCX files (up to 10 files, max 10MB per file)
            </p>
          </div>
        </div>

        {files.length > 0 && (
          <div className="bg-green-50 border border-green-200 rounded-lg p-4">
            <p className="text-sm font-medium text-green-800 mb-2">
              Selected files ({files.length}):
            </p>
            <ul className="text-sm text-green-700 space-y-1">
              {files.map((file, index) => (
                <li key={index} className="truncate">
                  • {file.name} ({(file.size / 1024).toFixed(2)} KB)
                </li>
              ))}
            </ul>
          </div>
        )}

        <button
          onClick={handleUpload}
          disabled={uploading || files.length === 0}
          className="w-full bg-blue-600 text-white py-3 px-6 rounded-lg
            hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed
            transition-colors font-medium text-lg"
        >
          {uploading ? 'Uploading and processing... (this may take a few minutes)' : 'Upload Documents'}
        </button>
        
        {uploading && (
          <div className="text-sm text-gray-600 text-center">
            <p>Processing documents and generating embeddings. Please wait...</p>
            <p className="text-xs mt-1">Large PDFs may take several minutes to process.</p>
          </div>
        )}

        {message && (
          <div
            className={`p-4 rounded-lg text-sm ${
              message.type === 'success'
                ? 'bg-green-50 text-green-800 border border-green-200'
                : 'bg-red-50 text-red-800 border border-red-200'
            }`}
          >
            <div className="flex items-start gap-2">
              {message.type === 'error' && (
                <svg className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              )}
              {message.type === 'success' && (
                <svg className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              )}
              <div className="flex-1">
                <p className="font-semibold mb-2">
                  {message.type === 'success' ? '✓ Upload Successful' : message.text.includes('Successfully uploaded') ? '⚠️ Partial Upload' : 'Upload Failed'}
                </p>
                <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">{message.text}</pre>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default DocumentUpload;

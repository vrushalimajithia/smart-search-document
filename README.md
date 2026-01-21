# Smart Document Search Agent

An AI-powered document search application that allows users to upload documents (PDF and text files) and search through them using semantic search powered by OpenAI embeddings.

## Features

- 📄 Upload multiple PDF and text documents (5-10 files)
- 🔍 Semantic search using OpenAI embeddings
- 📊 Returns most relevant snippets with source file references
- 🎨 Modern, responsive UI built with React and Tailwind CSS
- ⚡ Fast search results with similarity scores

## Tech Stack

### Backend
- **Node.js** with **Express.js**
- **TypeScript** for type safety
- **OpenAI API** for embeddings (text-embedding-ada-002)
- **pdf-parse** for PDF text extraction
- **multer** for file uploads
- In-memory vector store with cosine similarity search

### Frontend
- **React 18** with **TypeScript**
- **Vite** for fast development and building
- **Tailwind CSS** for styling
- **Axios** for API calls

## Prerequisites

- Node.js 18+ installed
- npm or yarn package manager
- OpenAI API key (provided by management)

## Setup Instructions

### 1. Backend Setup

```bash
# Navigate to backend directory
cd backend

# Install dependencies
npm install

# Create .env file
# Copy the following and add your OpenAI API key:
# PORT=3001
# OPENAI_API_KEY=your_openai_api_key_here
# UPLOAD_DIR=./uploads

# Create .env file (Windows PowerShell)
echo "PORT=3001`nOPENAI_API_KEY=your_openai_api_key_here`nUPLOAD_DIR=./uploads" > .env

# Or manually create .env file with:
# PORT=3001
# OPENAI_API_KEY=your_actual_openai_key
# UPLOAD_DIR=./uploads

# Run in development mode
npm run dev

# Or build and run in production
npm run build
npm start
```

The backend server will run on `http://localhost:3001`

### 2. Frontend Setup

```bash
# Navigate to frontend directory
cd frontend

# Install dependencies
npm install

# Run development server
npm run dev
```

The frontend will run on `http://localhost:3000`

### 3. Access the Application

Open your browser and navigate to `http://localhost:3000`

## Usage

### Uploading Documents

1. Click on "Upload Documents" section
2. Select PDF or TXT files (you can select multiple files, up to 10)
3. Click "Upload Documents" button
4. Wait for the upload and processing to complete
5. Uploaded documents will appear in the "Uploaded Documents" list

### Searching Documents

1. Enter your search query in the search box
2. Click "Search" button
3. View the results showing:
   - Relevant snippets from documents
   - Source file name for each snippet
   - Similarity score (percentage)

### Example Queries

Try these example queries to test the system:
- "What is the main topic discussed?"
- "Summarize the key points"
- "What are the important dates mentioned?"
- Any specific information you want to find in your documents

## API Endpoints

### Backend API (Port 3001)

- `GET /api/health` - Health check endpoint
- `POST /api/upload/single` - Upload a single document
- `POST /api/upload/multiple` - Upload multiple documents
- `POST /api/search` - Search documents
  ```json
  {
    "query": "your search query",
    "topK": 5
  }
  ```
- `GET /api/documents` - Get list of uploaded documents
- `DELETE /api/documents/clear` - Clear all documents

## Project Structure

```
smart-search-document/
├── backend/
│   ├── src/
│   │   ├── index.ts              # Main server file
│   │   ├── routes/               # API routes
│   │   │   ├── upload.ts
│   │   │   ├── search.ts
│   │   │   └── documents.ts
│   │   └── utils/                # Utility functions
│   │       ├── documentProcessor.ts
│   │       ├── vectorStore.ts
│   │       └── openaiService.ts
│   ├── uploads/                  # Uploaded files (created automatically)
│   ├── package.json
│   └── tsconfig.json
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── DocumentUpload.tsx
│   │   │   ├── SearchInterface.tsx
│   │   │   └── DocumentList.tsx
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   └── index.css
│   ├── package.json
│   └── vite.config.ts
└── README.md
```

## How It Works

1. **Document Upload**: When documents are uploaded, they are:
   - Saved to the uploads directory
   - Text is extracted (PDFs are parsed, text files are read)
   - Documents are chunked into smaller pieces (1000 characters with 200 character overlap)
   - Each chunk is converted to an embedding using OpenAI API
   - Embeddings are stored in an in-memory vector store

2. **Search Process**:
   - User query is converted to an embedding
   - Cosine similarity is calculated between query embedding and all document chunk embeddings
   - Top K most similar chunks are returned
   - Results include the snippet, source file name, and similarity score

## Acceptance Criteria Met

✅ Upload at least 5 text/PDF docs  
✅ User types a query → AI returns the best matching snippet  
✅ Must show source file name with the answer  
✅ Should work with at least 3 different queries  

## Troubleshooting

### Backend Issues

- **Port already in use**: Change the PORT in `.env` file
- **OpenAI API errors**: Verify your API key is correct in `.env`
- **File upload errors**: Check that the `uploads` directory exists and has write permissions

### Frontend Issues

- **Cannot connect to backend**: Ensure backend is running on port 3001
- **CORS errors**: Check that CORS is enabled in backend (it should be by default)

## Notes

- Documents are stored in memory, so they will be lost when the server restarts
- For production use, consider using a persistent vector database (Pinecone, Weaviate, etc.)
- File size limit is set to 10MB per file
- Maximum 10 files can be uploaded at once

## License

ISC

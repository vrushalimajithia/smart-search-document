import express, { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { processPDF, processTextFile, processDocx, getFileExtension } from '../utils/documentProcessor';
import { vectorStore } from '../utils/vectorStore';
import { getEmbeddings } from '../utils/openaiService';

const router = express.Router();

// Configure multer for file uploads
const uploadDir = process.env.UPLOAD_DIR || './uploads';

// Ensure upload directory exists
(async () => {
  try {
    await fs.mkdir(uploadDir, { recursive: true });
  } catch (error) {
    console.error('Error creating upload directory:', error);
  }
})();

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.pdf' || ext === '.txt' || ext === '.docx') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, TXT, and DOCX files are allowed'));
    }
  }
});

// Upload single file
router.post('/single', upload.single('document'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const filePath = req.file.path;
    const fileName = req.file.originalname;
    const ext = getFileExtension(fileName);

    // Process document based on type
    let chunks;
    if (ext === '.pdf') {
      chunks = await processPDF(filePath, fileName, req.file.size);
    } else if (ext === '.txt') {
      chunks = await processTextFile(filePath, fileName, req.file.size);
    } else if (ext === '.docx') {
      chunks = await processDocx(filePath, fileName, req.file.size);
    } else {
      await fs.unlink(filePath);
      return res.status(400).json({ error: 'Unsupported file type' });
    }

    // Get embeddings for all chunks
    const texts = chunks.map(chunk => chunk.text);
    const embeddings = await getEmbeddings(texts);

    // Store in vector store
    vectorStore.addDocument(chunks, embeddings);

    res.json({
      message: 'Document uploaded and processed successfully',
      fileName,
      chunksCount: chunks.length
    });
  } catch (error: any) {
    console.error('Upload error:', error);
    if (req.file) {
      try {
        await fs.unlink(req.file.path);
      } catch (unlinkError) {
        console.error('Error deleting file:', unlinkError);
      }
    }
    res.status(500).json({ error: error.message || 'Error processing document' });
  }
});

// Upload multiple files
router.post('/multiple', upload.array('documents', 10), async (req, res, next) => {
  const requestId = Date.now();
  console.log(`\n\n[${requestId}] === UPLOAD REQUEST RECEIVED ===`);
  console.log(`[${requestId}] Timestamp:`, new Date().toISOString());
  console.log(`[${requestId}] Request method:`, req.method);
  console.log(`[${requestId}] Request URL:`, req.url);
  console.log(`[${requestId}] Content-Type:`, req.headers['content-type']);
  console.log(`[${requestId}] Files received:`, req.files ? (Array.isArray(req.files) ? req.files.length : 1) : 0);
  console.log(`[${requestId}] Memory before processing:`, Math.round(process.memoryUsage().heapUsed / 1024 / 1024), 'MB');
  
  // Set a timeout to prevent hanging
  const timeout = setTimeout(() => {
    console.error(`[${requestId}] === UPLOAD TIMEOUT - Request taking too long ===`);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Upload timeout - request took too long to process' });
    }
  }, 300000); // 5 minutes
  
  try {
    if (!req.files || (Array.isArray(req.files) && req.files.length === 0)) {
      console.log('No files in request');
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const files = req.files as Express.Multer.File[];
    console.log(`[${requestId}] Processing ${files.length} file(s)`);
    const results: any[] = [];

    for (const file of files) {
      try {
        const fileName = file.originalname;
        console.log(`[${requestId}] \n--- Processing file: ${fileName} ---`);
        
        // Check file size before processing
        const fileSizeMB = file.size / 1024 / 1024;
        if (file.size > 10 * 1024 * 1024) {
          console.warn(`[${requestId}] File ${fileName} is too large: ${fileSizeMB.toFixed(2)} MB`);
          await fs.unlink(file.path);
          results.push({ 
            fileName, 
            error: `File is too large (${fileSizeMB.toFixed(2)} MB). Maximum size is 10MB.`,
            fileSize: fileSizeMB.toFixed(2) + ' MB'
          });
          continue;
        }
        
        const filePath = file.path;
        const ext = getFileExtension(fileName);
        console.log(`[${requestId}] File path: ${filePath}, Extension: ${ext}, Size: ${fileSizeMB.toFixed(2)} MB`);

        let chunks;
        if (ext === '.pdf') {
          console.log(`[${requestId}] Extracting text from PDF: ${fileName}`);
          chunks = await processPDF(filePath, fileName, file.size);
          console.log(`[${requestId}] Extracted ${chunks.length} chunks from PDF`);
        } else if (ext === '.txt') {
          console.log(`[${requestId}] Reading text file: ${fileName}`);
          chunks = await processTextFile(filePath, fileName, file.size);
          console.log(`[${requestId}] Extracted ${chunks.length} chunks from text file`);
        } else if (ext === '.docx') {
          console.log(`[${requestId}] Extracting text from DOCX: ${fileName}`);
          chunks = await processDocx(filePath, fileName, file.size);
          console.log(`[${requestId}] Extracted ${chunks.length} chunks from DOCX`);
        } else {
          await fs.unlink(filePath);
          results.push({ fileName, error: 'Unsupported file type' });
          continue;
        }

        if (chunks.length === 0) {
          console.warn(`[${requestId}] Warning: No text extracted from ${fileName}`);
          // Check if it's a PDF with a specific error message
          if (ext === '.pdf') {
            results.push({ 
              fileName, 
              error: 'PDF appears to be a scanned document or image-based PDF. The PDF contains images but no extractable text. Please use a PDF with selectable text, or convert scanned PDFs to text using OCR.' 
            });
          } else {
            results.push({ fileName, error: 'No text content found in file' });
          }
          continue;
        }

        console.log(`[${requestId}] File ${fileName} has ${chunks.length} chunks. Getting embeddings...`);
        console.log(`[${requestId}] Memory before preparing texts:`, Math.round(process.memoryUsage().heapUsed / 1024 / 1024), 'MB');
        
        // Get embeddings for all chunks (with batching)
        const texts = chunks.map(chunk => chunk.text);
        console.log(`[${requestId}] Prepared ${texts.length} texts for embedding. Starting OpenAI API calls...`);
        console.log(`[${requestId}] Memory before embeddings:`, Math.round(process.memoryUsage().heapUsed / 1024 / 1024), 'MB');
        console.log(`[${requestId}] First text preview (50 chars):`, texts[0]?.substring(0, 50) || 'N/A');
        
        const embeddingsStartTime = Date.now();
        const embeddings = await getEmbeddings(texts);
        const embeddingsDuration = Date.now() - embeddingsStartTime;
        console.log(`[${requestId}] Received ${embeddings.length} embeddings from OpenAI in ${embeddingsDuration}ms`);
        console.log(`[${requestId}] Memory after embeddings:`, Math.round(process.memoryUsage().heapUsed / 1024 / 1024), 'MB');

        if (embeddings.length !== chunks.length) {
          throw new Error(`Mismatch: got ${embeddings.length} embeddings for ${chunks.length} chunks`);
        }

        console.log(`[${requestId}] Got embeddings for ${fileName}. Storing in vector store...`);

        // Store in vector store
        vectorStore.addDocument(chunks, embeddings);

        console.log(`[${requestId}] ✓ Successfully processed ${fileName}`);

        results.push({
          fileName,
          chunksCount: chunks.length,
          status: 'success'
        });
      } catch (error: any) {
        console.error(`[${requestId}] ✗ Error processing ${file.originalname}:`, error);
        console.error(`[${requestId}] Error details:`, error.message);
        if (error.stack) {
          console.error(`[${requestId}] Stack trace:`, error.stack);
        }
        results.push({
          fileName: file.originalname,
          error: error.message || 'Unknown error'
        });
      }
    }

    console.log(`[${requestId}] \n=== Upload request completed ===`);
    console.log(`[${requestId}] Results:`, JSON.stringify(results, null, 2));
    clearTimeout(timeout);
    
    if (!res.headersSent) {
      res.json({
        message: 'Files processed',
        results
      });
      console.log('Response sent successfully');
    } else {
      console.warn('Response already sent, skipping');
    }
  } catch (error: any) {
    console.error('=== Upload error ===', error);
    console.error('Error stack:', error.stack);
    clearTimeout(timeout);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message || 'Error processing documents' });
    }
  }
});

// Error handler for multer errors (must be after routes)
router.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err instanceof multer.MulterError) {
    console.error('Multer error:', err);
    if (err.code === 'LIMIT_FILE_SIZE') {
      // Try to get the filename from the request if available
      const fileName = (req as any).file?.originalname || 'one or more files';
      return res.status(400).json({ 
        error: `File too large. Maximum size is 10MB.`,
        fileName: fileName,
        details: `The file "${fileName}" exceeds the 10MB limit. Please remove it and try again.`
      });
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({ error: 'Too many files. Maximum is 10 files.' });
    }
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  if (err) {
    console.error('Upload middleware error:', err);
    return res.status(400).json({ error: err.message || 'File upload error' });
  }
  next();
});

// Simple test endpoint to verify upload route is accessible
router.post('/test', (req, res) => {
  console.log('Test endpoint hit!');
  res.json({ message: 'Upload route is working', timestamp: new Date().toISOString() });
});

// Health check for upload route
router.get('/status', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Upload route is accessible',
    timestamp: new Date().toISOString(),
    memory: process.memoryUsage()
  });
});

// Test endpoint to verify OpenAI connection
router.get('/test-openai', async (req, res) => {
  try {
    const { getEmbedding } = await import('../utils/openaiService');
    const testEmbedding = await getEmbedding('test');
    res.json({ 
      success: true, 
      message: 'OpenAI connection working',
      embeddingLength: testEmbedding.length 
    });
  } catch (error: any) {
    res.status(500).json({ 
      success: false, 
      error: error.message,
      details: error.stack 
    });
  }
});

export { router as uploadRouter };

import fs from 'fs/promises';
import path from 'path';
import pdf from 'pdf-parse';
import mammoth from 'mammoth';

export interface DocumentChunk {
  text: string;
  sourceFile: string;
  chunkIndex: number;
  startIndex: number;
  endIndex: number;
  fileSize?: number; // File size in bytes
}

const CHUNK_SIZE = 1000; // characters per chunk
const CHUNK_OVERLAP = 200; // overlap between chunks

export async function processPDF(filePath: string, fileName: string, fileSize?: number): Promise<DocumentChunk[]> {
  try {
    console.log(`Reading PDF file: ${fileName}`);
    const stats = await fs.stat(filePath);
    const actualFileSize = fileSize || stats.size;
    console.log(`PDF file size: ${(actualFileSize / 1024 / 1024).toFixed(2)} MB`);
    
    // Check file size - warn if very large
    if (actualFileSize > 5 * 1024 * 1024) { // 5MB
      console.warn(`Warning: Large PDF file (${(actualFileSize / 1024 / 1024).toFixed(2)} MB). Processing may take time and use significant memory.`);
    }
    
    const dataBuffer = await fs.readFile(filePath);
    console.log(`PDF buffer loaded, size: ${(dataBuffer.length / 1024 / 1024).toFixed(2)} MB`);
    
    console.log(`Parsing PDF content...`);
    const parseStartTime = Date.now();
    const data = await pdf(dataBuffer);
    const parseDuration = Date.now() - parseStartTime;
    console.log(`PDF parsing completed in ${parseDuration}ms`);
    
    const text = data.text;
    const numPages = data.numpages;
    console.log(`Extracted text length: ${text.length} characters`);
    console.log(`PDF has ${numPages} page(s)`);
    
    if (!text || text.trim().length === 0) {
      // Check if PDF has pages but no text - likely scanned/image-based PDF
      if (numPages > 0) {
        throw new Error(`PDF appears to be a scanned document or image-based PDF (${numPages} page(s)). The PDF contains images but no extractable text. Please use a PDF with selectable text, or convert scanned PDFs to text using OCR.`);
      }
      throw new Error('PDF appears to be empty or contains no extractable text');
    }
    
    console.log(`Chunking text into segments...`);
    const chunkStartTime = Date.now();
    const chunks = chunkText(text, fileName, actualFileSize);
    const chunkDuration = Date.now() - chunkStartTime;
    console.log(`Created ${chunks.length} chunks in ${chunkDuration}ms`);
    
    return chunks;
  } catch (error: any) {
    if (error.message.includes('empty') || error.message.includes('extractable')) {
      throw error;
    }
    if (error.message.includes('heap') || error.message.includes('memory')) {
      throw new Error(`PDF is too large to process. Please try a smaller file or split the PDF into smaller parts. Original error: ${error.message}`);
    }
    throw new Error(`Failed to process PDF: ${error.message || 'Unknown error'}`);
  }
}

export async function processTextFile(filePath: string, fileName: string, fileSize?: number): Promise<DocumentChunk[]> {
  try {
    const stats = await fs.stat(filePath);
    const actualFileSize = fileSize || stats.size;
    const text = await fs.readFile(filePath, 'utf-8');
    
    if (!text || text.trim().length === 0) {
      throw new Error('Text file is empty');
    }
    
    return chunkText(text, fileName, actualFileSize);
  } catch (error: any) {
    if (error.message.includes('empty')) {
      throw error;
    }
    throw new Error(`Failed to process text file: ${error.message || 'Unknown error'}`);
  }
}

export async function processDocx(filePath: string, fileName: string, fileSize?: number): Promise<DocumentChunk[]> {
  try {
    console.log(`Reading DOCX file: ${fileName}`);
    const stats = await fs.stat(filePath);
    const actualFileSize = fileSize || stats.size;
    console.log(`DOCX file size: ${(actualFileSize / 1024 / 1024).toFixed(2)} MB`);
    
    // Check file size - warn if very large
    if (actualFileSize > 5 * 1024 * 1024) { // 5MB
      console.warn(`Warning: Large DOCX file (${(actualFileSize / 1024 / 1024).toFixed(2)} MB). Processing may take time.`);
    }
    
    const dataBuffer = await fs.readFile(filePath);
    console.log(`DOCX buffer loaded, size: ${(dataBuffer.length / 1024 / 1024).toFixed(2)} MB`);
    
    console.log(`Extracting text from DOCX content...`);
    const parseStartTime = Date.now();
    const result = await mammoth.extractRawText({ buffer: dataBuffer });
    const parseDuration = Date.now() - parseStartTime;
    console.log(`DOCX parsing completed in ${parseDuration}ms`);
    
    const text = result.value;
    console.log(`Extracted text length: ${text.length} characters`);
    
    if (!text || text.trim().length === 0) {
      throw new Error('DOCX appears to be empty or contains no extractable text');
    }
    
    if (result.messages.length > 0) {
      console.warn(`DOCX processing warnings:`, result.messages);
    }
    
    console.log(`Chunking text into segments...`);
    const chunkStartTime = Date.now();
    const chunks = chunkText(text, fileName, actualFileSize);
    const chunkDuration = Date.now() - chunkStartTime;
    console.log(`Created ${chunks.length} chunks in ${chunkDuration}ms`);
    
    return chunks;
  } catch (error: any) {
    if (error.message.includes('empty') || error.message.includes('extractable')) {
      throw error;
    }
    throw new Error(`Failed to process DOCX: ${error.message || 'Unknown error'}`);
  }
}

function chunkText(text: string, sourceFile: string, fileSize?: number): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];
  let startIndex = 0;
  let chunkIndex = 0;
  const maxChunks = 10000; // Safety limit to prevent infinite loops

  while (startIndex < text.length && chunkIndex < maxChunks) {
    const endIndex = Math.min(startIndex + CHUNK_SIZE, text.length);
    const chunkText = text.substring(startIndex, endIndex);
    
    chunks.push({
      text: chunkText,
      sourceFile,
      chunkIndex,
      startIndex,
      endIndex,
      fileSize
    });

    const nextStartIndex = endIndex - CHUNK_OVERLAP;
    // Prevent infinite loop - ensure we always make progress
    if (nextStartIndex <= startIndex) {
      startIndex = endIndex;
    } else {
      startIndex = nextStartIndex;
    }
    chunkIndex++;
  }

  if (chunkIndex >= maxChunks) {
    console.warn(`Warning: Reached maximum chunk limit (${maxChunks}). Text may be very long.`);
  }

  return chunks;
}

export function getFileExtension(fileName: string): string {
  return path.extname(fileName).toLowerCase();
}

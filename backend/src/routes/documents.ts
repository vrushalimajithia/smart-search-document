import express, { Request, Response } from 'express';
import { vectorStore } from '../utils/vectorStore';

const router = express.Router();

// Get all uploaded documents
router.get('/', (req, res) => {
  try {
    const vectors = vectorStore.getAllVectors();
    const documentMap = new Map<string, number>(); // Map<fileName, fileSize>
    
    // Safely extract document names and file sizes
    if (vectors && Array.isArray(vectors)) {
      vectors.forEach(vector => {
        if (vector && vector.chunk && vector.chunk.sourceFile) {
          const fileName = vector.chunk.sourceFile;
          const fileSize = vector.chunk.fileSize || 0;
          // Store the file size (all chunks from same file have same size)
          if (!documentMap.has(fileName) || fileSize > 0) {
            documentMap.set(fileName, fileSize);
          }
        }
      });
    }

    // Convert to array of objects with name and size
    const documents = Array.from(documentMap.entries()).map(([name, size]) => ({
      name,
      size
    }));

    res.json({
      documents: documents.map(d => d.name), // Keep backward compatibility
      documentsWithSize: documents, // New format with sizes
      count: documents.length,
      totalChunks: vectors ? vectors.length : 0
    });
  } catch (error: any) {
    console.error('Error getting documents:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ error: error.message || 'Error retrieving documents' });
  }
});

// Clear all documents (must come before /:fileName route)
router.delete('/clear', (req, res) => {
  try {
    const vectorsBefore = vectorStore.getAllVectors();
    const countBefore = vectorsBefore.length;
    console.log(`Clearing all documents. Current count: ${countBefore}`);
    
    vectorStore.clear();
    
    const vectorsAfter = vectorStore.getAllVectors();
    const countAfter = vectorsAfter.length;
    console.log(`Documents cleared. Count after: ${countAfter}`);
    
    if (countAfter > 0) {
      console.error(`WARNING: Clear operation did not fully clear vectors. Expected 0, got ${countAfter}`);
    }
    
    res.json({ 
      message: 'All documents cleared successfully',
      cleared: countBefore,
      remaining: countAfter
    });
  } catch (error: any) {
    console.error('Error clearing documents:', error);
    res.status(500).json({ error: error.message || 'Error clearing documents' });
  }
});

// Delete a specific document (must come after /clear route)
router.delete('/:fileName', (req, res) => {
  try {
    const fileName = decodeURIComponent(req.params.fileName);
    console.log(`Deleting document: ${fileName}`);
    
    const vectorsBefore = vectorStore.getAllVectors();
    const countBefore = vectorsBefore.length;
    
    // Remove the document from vector store
    vectorStore.removeDocument(fileName);
    
    const vectorsAfter = vectorStore.getAllVectors();
    const countAfter = vectorsAfter.length;
    const chunksRemoved = countBefore - countAfter;
    
    console.log(`Document deleted. Removed ${chunksRemoved} chunks. Remaining: ${countAfter}`);
    
    res.json({ 
      message: `Document "${fileName}" deleted successfully`,
      fileName,
      chunksRemoved,
      remaining: countAfter
    });
  } catch (error: any) {
    console.error('Error deleting document:', error);
    res.status(500).json({ error: error.message || 'Error deleting document' });
  }
});

export { router as documentsRouter };

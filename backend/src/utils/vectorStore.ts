import { DocumentChunk } from './documentProcessor';

export interface DocumentVector {
  chunk: DocumentChunk;
  embedding: number[];
}

class VectorStore {
  private vectors: DocumentVector[] = [];

  addDocument(chunks: DocumentChunk[], embeddings: number[][]): void {
    for (let i = 0; i < chunks.length; i++) {
      this.vectors.push({
        chunk: chunks[i],
        embedding: embeddings[i]
      });
    }
  }

  removeDocument(fileName: string): void {
    this.vectors = this.vectors.filter(v => v.chunk.sourceFile !== fileName);
  }

  getAllVectors(): DocumentVector[] {
    return this.vectors;
  }

  clear(): void {
    this.vectors = [];
  }

  // Cosine similarity (public method for external use)
  cosineSimilarity(vecA: number[], vecB: number[]): number {
    if (vecA.length !== vecB.length) {
      throw new Error('Vectors must have the same length');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }

  // Find most similar chunks
  findSimilar(queryEmbedding: number[], topK: number = 5, minSimilarity: number = 0.5): Array<{ chunk: DocumentChunk; similarity: number }> {
    const similarities = this.vectors.map(vector => ({
      chunk: vector.chunk,
      similarity: this.cosineSimilarity(queryEmbedding, vector.embedding)
    }));

    // Filter by minimum similarity, sort by similarity (descending), and return top K
    return similarities
      .filter(result => result.similarity >= minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);
  }
  
  // Calculate similarity for a single vector (helper method)
  calculateSimilarity(queryEmbedding: number[], vectorEmbedding: number[]): number {
    return this.cosineSimilarity(queryEmbedding, vectorEmbedding);
  }
}

export const vectorStore = new VectorStore();

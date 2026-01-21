import OpenAI from 'openai';

let openai: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!openai) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not set in environment variables');
    }
    openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: 300000, // 5 minutes timeout
      maxRetries: 2
    });
  }
  return openai;
}

export async function getEmbedding(text: string): Promise<number[]> {
  try {
    const client = getOpenAIClient();
    const response = await client.embeddings.create({
      model: 'text-embedding-ada-002',
      input: text.trim()
    });

    return response.data[0].embedding;
  } catch (error) {
    console.error('Error getting embedding:', error);
    throw error;
  }
}

export async function getEmbeddings(texts: string[]): Promise<number[][]> {
  try {
    if (!texts || texts.length === 0) {
      throw new Error('No texts provided for embedding');
    }

    // Filter out empty texts
    const validTexts = texts.filter(t => t && t.trim().length > 0);
    if (validTexts.length === 0) {
      throw new Error('All texts are empty');
    }

    const client = getOpenAIClient();
    
    // OpenAI API has limits - batch requests to avoid rate limits
    // text-embedding-ada-002 supports up to 2048 inputs per request
    // We'll use smaller batches to be safe (100 at a time)
    const BATCH_SIZE = 100;
    const allEmbeddings: number[][] = [];
    
    console.log(`Getting embeddings for ${validTexts.length} chunks in batches of ${BATCH_SIZE}...`);
    
    for (let i = 0; i < validTexts.length; i += BATCH_SIZE) {
      const batch = validTexts.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(validTexts.length / BATCH_SIZE);
      
      console.log(`Processing batch ${batchNum} of ${totalBatches} (${batch.length} chunks)...`);
      
      try {
        const trimmedBatch = batch.map(t => {
          const trimmed = t.trim();
          // Ensure text is not too long (OpenAI has token limits)
          return trimmed.length > 8000 ? trimmed.substring(0, 8000) : trimmed;
        });

        console.log(`Calling OpenAI API for batch ${batchNum}...`);
        const startTime = Date.now();
        const response = await client.embeddings.create({
          model: 'text-embedding-ada-002',
          input: trimmedBatch
        });
        const duration = Date.now() - startTime;
        console.log(`OpenAI API responded for batch ${batchNum} in ${duration}ms`);
        
        if (!response || !response.data || response.data.length !== trimmedBatch.length) {
          throw new Error(`Unexpected response: expected ${trimmedBatch.length} embeddings, got ${response?.data?.length || 0}`);
        }
        
        allEmbeddings.push(...response.data.map(item => item.embedding));
        console.log(`✓ Completed batch ${batchNum}/${totalBatches}`);
        
        // Small delay between batches to avoid rate limiting
        if (i + BATCH_SIZE < validTexts.length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (batchError: any) {
        console.error(`✗ Error in batch ${batchNum}:`, batchError);
        console.error('Batch error details:', batchError.message);
        if (batchError.response) {
          console.error('OpenAI API response:', batchError.response.status, batchError.response.data);
        }
        throw new Error(`Failed to get embeddings for batch ${batchNum}: ${batchError.message}`);
      }
    }
    
    console.log(`✓ Successfully got embeddings for all ${validTexts.length} chunks`);
    return allEmbeddings;
  } catch (error: any) {
    console.error('Error getting embeddings:', error);
    console.error('Error stack:', error.stack);
    throw error;
  }
}

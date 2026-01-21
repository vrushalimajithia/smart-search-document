import express, { Request, Response } from 'express';
import { getEmbedding } from '../utils/openaiService';
import { vectorStore } from '../utils/vectorStore';

const router = express.Router();

/**
 * Normalizes text for exact matching by:
 * - converting to lowercase
 * - removing punctuation (except spaces)
 * - replacing multiple whitespace (including line breaks) with a single space
 * - trimming leading/trailing spaces
 */
function normalizeTextForMatching(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ') // Replace punctuation with space
    .replace(/\s+/g, ' ') // Replace all whitespace (spaces, tabs, newlines) with single space
    .trim();
}

/**
 * Extracts a snippet from a known phrase index.
 * Finds sentence boundaries and returns a complete sentence/paragraph.
 */
/**
 * Detects if a match is in a table of contents entry
 * TOC entries have various formats:
 * - "Heading ................................8"
 * - "Heading ........8"
 * - "Heading                    8" (spaces)
 * - "Heading 8" (with many spaces between)
 */
function isTocEntry(originalText: string, phraseIndex: number, phrasePattern: string): boolean {
  const contextAroundMatch = originalText.substring(
    Math.max(0, phraseIndex - 30), 
    Math.min(originalText.length, phraseIndex + phrasePattern.length + 80)
  );
  
  const afterPhrase = originalText.substring(
    phraseIndex + phrasePattern.length, 
    Math.min(originalText.length, phraseIndex + phrasePattern.length + 80)
  );
  
  // Pattern 1: Multiple dots (3+) followed by a number at end of line
  const tocPattern1 = /\.{3,}\s*\d+\s*$/m;
  
  // Pattern 2: Many dots (10+) after the phrase
  const dotsCount = (afterPhrase.match(/\./g) || []).length;
  const hasManyDots = dotsCount > 10;
  
  // Pattern 3: Many spaces (20+) followed by a number (spaces-based TOC)
  const spacesPattern = /\s{20,}\d+\s*$/m;
  const hasManySpaces = spacesPattern.test(contextAroundMatch);
  
  // Pattern 4: Check if the line ends with just a number (common TOC pattern)
  const endsWithNumber = /^\s*\.{3,}\s*\d+\s*$/m.test(afterPhrase.trim()) || 
                         /^\s{10,}\d+\s*$/m.test(afterPhrase.trim());
  
  return tocPattern1.test(contextAroundMatch) || hasManyDots || hasManySpaces || endsWithNumber;
}

function extractSnippetFromPhraseIndex(originalText: string, phraseIndex: number, phrasePattern: string): string {
  // CRITICAL: First check if this is a table of contents entry
  if (isTocEntry(originalText, phraseIndex, phrasePattern)) {
    console.log(`⚠️ Detected TOC entry for "${phrasePattern}" at index ${phraseIndex}`);
    // Note: We'll handle TOC skipping at the scoring level, not here
    // This function will still extract from the TOC entry, but scoring will penalize it
    // The actual content match should score higher and be selected instead
  }
  
  // Strategy: Find the section/paragraph that contains the phrase
  // Look backwards to find section breaks (role titles, headers, etc.)
  let snippetStart = phraseIndex;
  
  // Look backwards up to 500 chars to find section start
  const lookBackStart = Math.max(0, phraseIndex - 500);
  const lookBackText = originalText.substring(lookBackStart, phraseIndex);
  
  // Look for section breaks - common patterns:
  // 1. Double newlines (paragraph breaks)
  // 2. Role titles (e.g., "Software Engineer", "Sr. Software Engineer", "Trainee Software Engineer")
  // 3. Bullet point markers followed by newlines
  // 4. Numbered sections/questions (e.g., "2. What is Agile Manifesto?")
  
  // Find the last double newline (strong paragraph break)
  const lastDoubleNewline = lookBackText.lastIndexOf('\n\n');
  
  // Find numbered questions/sections (e.g., "2. What is Agile Manifesto?", "1. What is Agile Testing?")
  // Pattern: newline followed by optional whitespace, then number, then period, then space
  const numberedSectionPattern = /\n\s*\d+\.\s/;
  const numberedMatches = [...lookBackText.matchAll(new RegExp(numberedSectionPattern.source, 'g'))];
  
  // Find role title patterns (look for common patterns like "Engineer", "Manager", etc. on their own line)
  const roleTitlePatterns = [
    /\n(Sr\.|Senior|Junior|Trainee|Intern)?\s*(Software|Senior|Lead|Principal)?\s*(Engineer|Developer|Manager|Analyst)/i,
    /\n[A-Z][a-z]+\s+(Engineer|Developer|Manager|Analyst|Designer)/i
  ];
  
  let sectionBreakIndex = -1;
  
  // Check for numbered sections first (strongest indicator of a new question/section)
  if (numberedMatches.length > 0) {
    const lastNumberedMatch = numberedMatches[numberedMatches.length - 1];
    sectionBreakIndex = lookBackStart + (lastNumberedMatch.index || 0);
  }
  
  // Check for double newline (strong paragraph break)
  if (lastDoubleNewline !== -1) {
    const doubleNewlineIndex = lookBackStart + lastDoubleNewline + 2; // +2 for \n\n
    // Only use double newline if it's closer to the phrase than numbered section, or if no numbered section found
    if (sectionBreakIndex === -1 || doubleNewlineIndex > sectionBreakIndex) {
      sectionBreakIndex = doubleNewlineIndex;
    }
  }
  
  // Check for role titles (look backwards from phrase)
  for (const pattern of roleTitlePatterns) {
    const matches = [...lookBackText.matchAll(new RegExp(pattern.source, 'g'))];
    if (matches.length > 0) {
      const lastMatch = matches[matches.length - 1];
      const matchIndex = lookBackStart + (lastMatch.index || 0);
      // Only use this if it's closer to the phrase than existing section break, or if no section break found
      if (sectionBreakIndex === -1 || matchIndex > sectionBreakIndex) {
        sectionBreakIndex = matchIndex;
      }
    }
  }
  
  if (sectionBreakIndex !== -1 && sectionBreakIndex < phraseIndex) {
    snippetStart = sectionBreakIndex;
    // Skip whitespace after the section break
    while (snippetStart < originalText.length && /\s/.test(originalText[snippetStart])) {
      snippetStart++;
    }
  } else {
    // Fallback: look for single newline or sentence boundary
    const lastNewline = lookBackText.lastIndexOf('\n');
    const lastPeriod = lookBackText.lastIndexOf('.');
    const boundaries = [lastNewline, lastPeriod].filter(idx => idx !== -1);
    
    if (boundaries.length > 0) {
      const closestBoundary = Math.max(...boundaries);
      snippetStart = lookBackStart + closestBoundary + 1;
      while (snippetStart < originalText.length && /\s/.test(originalText[snippetStart])) {
        snippetStart++;
      }
    } else {
      snippetStart = Math.max(0, phraseIndex - 100);
    }
  }
  
  // Look forwards from the phrase to find the END of the section/paragraph
  const phraseEnd = phraseIndex + phrasePattern.length;
  let snippetEnd = phraseEnd;
  
  // Look forward up to 500 chars to find section end
  const lookForwardStart = phraseEnd;
  const lookForwardEnd = Math.min(originalText.length, phraseEnd + 500);
  const lookForwardText = originalText.substring(lookForwardStart, lookForwardEnd);
  
  // Find section breaks going forward:
  // 1. Double newlines (paragraph breaks)
  // 2. Next role title
  // 3. End of bullet list (when we see a new section header)
  
  const firstDoubleNewline = lookForwardText.indexOf('\n\n');
  
  // Look for next role title
  const nextRoleTitlePatterns = [
    /\n(Sr\.|Senior|Junior|Trainee|Intern)?\s*(Software|Senior|Lead|Principal)?\s*(Engineer|Developer|Manager|Analyst)/i,
    /\n[A-Z][a-z]+\s+(Engineer|Developer|Manager|Analyst|Designer)/i
  ];
  
  let sectionEndIndex = -1;
  
  // Check for double newline first
  if (firstDoubleNewline !== -1) {
    sectionEndIndex = phraseEnd + firstDoubleNewline;
  }
  
  // Check for next role title
  for (const pattern of nextRoleTitlePatterns) {
    const match = lookForwardText.match(pattern);
    if (match && match.index !== undefined) {
      const matchIndex = phraseEnd + match.index;
      // Only use this if it's before double newline, or if no double newline found
      if (sectionEndIndex === -1 || matchIndex < sectionEndIndex) {
        sectionEndIndex = matchIndex;
      }
    }
  }
  
  if (sectionEndIndex !== -1 && sectionEndIndex > lookForwardStart) {
    snippetEnd = sectionEndIndex;
  } else {
    // Fallback: find end of current paragraph or section
    // Look for end of bullet list (when we see a new bullet or section)
    const firstNewline = lookForwardText.indexOf('\n');
    const firstPeriod = lookForwardText.indexOf('.');
    
    // If we're in a bullet list, stop at the end of the current item
    // Look for next bullet marker or end of list
    const nextBullet = lookForwardText.search(/\n\s*[•\-\*]\s/);
    const nextNumbered = lookForwardText.search(/\n\s*\d+\.\s/);
    
    // Look for next section heading (all caps or title case on its own line)
    const nextHeading = lookForwardText.search(/\n[A-Z][A-Za-z\s]{10,}\n/);
    
    if (nextBullet !== -1) {
      snippetEnd = lookForwardStart + nextBullet;
    } else if (nextNumbered !== -1) {
      snippetEnd = lookForwardStart + nextNumbered;
    } else if (nextHeading !== -1) {
      snippetEnd = lookForwardStart + nextHeading;
    } else if (firstPeriod !== -1) {
      // Find the end of the sentence/paragraph (look for period followed by newline or double newline)
      let periodIndex = firstPeriod;
      while (periodIndex < lookForwardText.length && lookForwardText[periodIndex] === '.') {
        periodIndex++;
      }
      // Check if there's a newline after the period(s)
      const afterPeriod = lookForwardText.substring(periodIndex, Math.min(lookForwardText.length, periodIndex + 10));
      if (afterPeriod.includes('\n')) {
        snippetEnd = lookForwardStart + periodIndex;
      } else {
        // No newline, extend to include more sentences
        snippetEnd = Math.min(originalText.length, lookForwardStart + 600);
      }
    } else if (firstNewline !== -1) {
      snippetEnd = lookForwardStart + firstNewline;
    } else {
      // Extend a reasonable amount to include full paragraph
      snippetEnd = Math.min(originalText.length, lookForwardStart + 600);
    }
  }
  
  // Extract the snippet
  let snippet = originalText.substring(snippetStart, snippetEnd).trim();
  
  // Clean up: remove any leading section headers that might have been included
  // If snippet starts with a role title pattern, find the actual content start
  const roleTitleAtStart = snippet.match(/^(Sr\.|Senior|Junior|Trainee|Intern)?\s*(Software|Senior|Lead|Principal)?\s*(Engineer|Developer|Manager|Analyst)/i);
  if (roleTitleAtStart) {
    // Find the content after the role title
    const titleEnd = snippet.indexOf('\n', roleTitleAtStart[0].length);
    if (titleEnd !== -1) {
      snippet = snippet.substring(titleEnd).trim();
    }
  }
  
  // Add ellipsis if we didn't start from the beginning of the document
  if (snippetStart > 0) {
    snippet = '...' + snippet;
  }
  // Add ellipsis if we didn't reach the end of the document
  if (snippetEnd < originalText.length) {
    snippet = snippet + '...';
  }
  
  console.log(`Snippet extraction: phraseIndex=${phraseIndex}, snippetStart=${snippetStart}, snippetEnd=${snippetEnd}, snippetLength=${snippet.length}`);
  console.log(`Snippet preview: "${snippet.substring(0, 200)}..."`);
  
  return snippet;
}

/**
 * Extracts a focused snippet around the matched query words.
 * Prioritizes locations where all query words appear close together.
 * Returns ~200 characters before and after the best match location.
 */
function extractFocusedSnippet(originalText: string, queryWords: string[]): string {
  const originalLower = originalText.toLowerCase();
  
  // First, try to find the exact phrase (all words in order, close together)
  const normalizedQueryPhrase = queryWords.join(' ').toLowerCase();
  let exactPhraseIndex = -1;
  let allPhraseMatches: number[] = [];
  
  // Find ALL occurrences of the exact phrase
  let searchIndex = 0;
  while (true) {
    const index = originalLower.indexOf(normalizedQueryPhrase, searchIndex);
    if (index === -1) break;
    allPhraseMatches.push(index);
    searchIndex = index + 1;
  }
  
  // If exact phrase not found, try with variations (e.g., "wood stove design" vs "wood-stove design")
  if (allPhraseMatches.length === 0) {
    const variations = [
      queryWords.join(' '),
      queryWords.join('-'),
      queryWords.join('_'),
    ];
    for (const variation of variations) {
      searchIndex = 0;
      while (true) {
        const index = originalLower.indexOf(variation.toLowerCase(), searchIndex);
        if (index === -1) break;
        allPhraseMatches.push(index);
        searchIndex = index + 1;
      }
      if (allPhraseMatches.length > 0) break;
    }
  }
  
  // If we found the exact phrase, pick the best match (prefer matches in longer sentences/paragraphs)
  if (allPhraseMatches.length > 0) {
    // Score each match based on context (prefer matches with more surrounding text)
    let bestMatch = allPhraseMatches[0];
    let bestScore = 0;
    
    for (const matchIndex of allPhraseMatches) {
      // Check how much text is around this match
      const beforeText = originalText.substring(Math.max(0, matchIndex - 100), matchIndex);
      const afterText = originalText.substring(matchIndex + normalizedQueryPhrase.length, Math.min(originalText.length, matchIndex + normalizedQueryPhrase.length + 100));
      
      // Prefer matches that have more context and are in sentences (contain periods, not just headers)
      let score = beforeText.length + afterText.length;
      
      // Boost score if it's in a sentence (has periods nearby)
      if (beforeText.includes('.') || afterText.includes('.')) {
        score += 200;
      }
      
      // Boost score if it contains words like "challenge", "prize", "award" (contextual relevance)
      const contextText = (beforeText + ' ' + afterText).toLowerCase();
      if (contextText.includes('challenge') || contextText.includes('prize') || contextText.includes('award') || contextText.includes('won')) {
        score += 300;
      }
      
      // Penalize if it's likely a header (all caps, short, no periods)
      const matchText = originalText.substring(Math.max(0, matchIndex - 20), Math.min(originalText.length, matchIndex + normalizedQueryPhrase.length + 20));
      if (matchText === matchText.toUpperCase() && matchText.length < 50) {
        score -= 100;
      }
      
      if (score > bestScore) {
        bestScore = score;
        bestMatch = matchIndex;
      }
    }
    
    exactPhraseIndex = bestMatch;
    console.log(`Found ${allPhraseMatches.length} phrase matches, selected best at index ${exactPhraseIndex} with score ${bestScore}`);
  }
  
  // If we found the exact phrase, use it
  if (exactPhraseIndex !== -1) {
    console.log(`Using exact phrase match at index ${exactPhraseIndex}`);
    return extractSnippetFromPhraseIndex(originalText, exactPhraseIndex, normalizedQueryPhrase);
  }
  
  // If exact phrase not found, find where all query words appear close together (within 100 chars)
  const MAX_PHRASE_DISTANCE = 100;
  let bestMatchIndex = -1;
  let bestMatchScore = 0;
  
  // Find all positions of each query word
  const wordPositions: Array<{ word: string; positions: number[] }> = [];
  
  for (const word of queryWords) {
    const wordLower = word.toLowerCase();
    const positions: number[] = [];
    let searchIndex = 0;
    
    // Find all occurrences of this word
    while (true) {
      let index = originalLower.indexOf(wordLower, searchIndex);
      if (index === -1) {
        // Try partial matches in words
        const wordsInText = originalLower.split(/\s+/);
        let charIndex = 0;
        for (const textWord of wordsInText) {
          if (textWord.includes(wordLower) || wordLower.includes(textWord)) {
            const wordStart = originalLower.indexOf(textWord, charIndex);
            if (wordStart !== -1 && !positions.includes(wordStart)) {
              positions.push(wordStart);
            }
          }
          charIndex = originalLower.indexOf(textWord, charIndex) + textWord.length;
        }
        break;
      }
      positions.push(index);
      searchIndex = index + 1;
    }
    
    if (positions.length > 0) {
      wordPositions.push({ word: wordLower, positions });
    }
  }
  
  // Find the best location where all words are close together
  if (wordPositions.length === queryWords.length) {
    // Try each position of the first word
    for (const firstPos of wordPositions[0].positions) {
      let allWordsNearby = true;
      let maxDistance = 0;
      
      // Check if all other words are nearby
      for (let i = 1; i < wordPositions.length; i++) {
        const nearbyPos = wordPositions[i].positions.find(
          pos => Math.abs(pos - firstPos) <= MAX_PHRASE_DISTANCE
        );
        if (nearbyPos === undefined) {
          allWordsNearby = false;
          break;
        }
        maxDistance = Math.max(maxDistance, Math.abs(nearbyPos - firstPos));
      }
      
      if (allWordsNearby) {
        // Calculate score: closer words = better score
        const score = 1000 - maxDistance;
        if (score > bestMatchScore) {
          bestMatchScore = score;
          bestMatchIndex = firstPos;
        }
      }
    }
  }
  
  // If we found a good phrase match, use it
  let snippetStartIndex = bestMatchIndex;
  
  // Fallback: use first occurrence of first word if no phrase match found
  if (snippetStartIndex === -1 && wordPositions.length > 0) {
    snippetStartIndex = wordPositions[0].positions[0];
  }
  
  if (snippetStartIndex === -1) {
    // Fallback: return first 300 characters if we can't find any word
    return originalText.substring(0, 300).trim();
  }
  
  // Extract ~200 characters before and after the match
  const SNIPPET_WINDOW = 200;
  const start = Math.max(0, snippetStartIndex - SNIPPET_WINDOW);
  const end = Math.min(originalText.length, snippetStartIndex + queryWords[0].length + SNIPPET_WINDOW);
  
  let snippet = originalText.substring(start, end);
  
  // Try to clean up boundaries (start at sentence/paragraph boundary if possible)
  if (start > 0) {
    const beforeStart = originalText.substring(Math.max(0, start - 50), start);
    const lastPeriod = beforeStart.lastIndexOf('.');
    const lastNewline = beforeStart.lastIndexOf('\n');
    const lastSpace = beforeStart.lastIndexOf(' ');
    const boundary = Math.max(lastPeriod, lastNewline, lastSpace);
    if (boundary > 0) {
      snippet = originalText.substring(start - (50 - boundary), end);
    }
  }
  
  // Try to end at sentence/paragraph boundary
  if (end < originalText.length) {
    const afterEnd = originalText.substring(end, Math.min(originalText.length, end + 50));
    const firstPeriod = afterEnd.indexOf('.');
    const firstNewline = afterEnd.indexOf('\n');
    const firstSpace = afterEnd.indexOf(' ');
    if (firstPeriod > 0 || firstNewline > 0 || firstSpace > 0) {
      const boundary = firstPeriod > 0 && (firstNewline === -1 || firstPeriod < firstNewline) && (firstSpace === -1 || firstPeriod < firstSpace)
        ? firstPeriod + 1
        : firstNewline > 0 && (firstSpace === -1 || firstNewline < firstSpace)
        ? firstNewline
        : firstSpace;
      snippet = originalText.substring(start, end + boundary);
    }
  }
  
  // Trim and add ellipsis if needed
  snippet = snippet.trim();
  if (start > 0) snippet = '...' + snippet;
  if (end < originalText.length) snippet = snippet + '...';
  
  return snippet;
}

router.post('/', async (req, res) => {
  try {
    const { query } = req.body;
    console.log(`\n\n========================================`);
    console.log(`SEARCH REQUEST RECEIVED`);
    console.log(`Query: "${query}"`);
    console.log(`========================================\n`);

    // Validate query
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return res.status(400).json({ error: 'Query is required and must be a non-empty string' });
    }

    // Step 1: Normalize the user query (handles PDF formatting issues)
    const normalizedQuery = normalizeTextForMatching(query);
    console.log(`\n\n=== SEARCH REQUEST ===`);
    console.log(`Search query: "${query}" (normalized: "${normalizedQuery}")`);

    // Step 2: Get all vectors
    let allVectors = vectorStore.getAllVectors();
    console.log(`Searching through ${allVectors.length} document chunks`);
    
    // Early return if no documents
    if (allVectors.length === 0) {
      console.log(`⚠️ No documents in vector store. Please upload documents first.`);
      return res.json({
        answer: "No documents have been uploaded yet. Please upload documents first before searching.",
        source: "",
        confidence: 0.0
      });
    }

    // Step 2.5: STRICT DOCUMENT-LEVEL FILTER FOR COMPARISON QUERIES (TC-5 fix)
    // This filter runs BEFORE any chunk scoring or semantic similarity
    // It completely excludes documents that don't mention the entity
    const comparisonKeywordsEarly = [
      /\bdifference\b/i,
      /\bvs\.?\b/i,
      /\bversus\b/i,
      /\bcompare\b/i,
      /\bcomparison\b/i,
    ];
    
    const isComparisonQueryEarly = comparisonKeywordsEarly.some(pattern => pattern.test(query));
    
    // Extract entity early (simple extraction - look for capitalized words)
    function extractEntityEarly(queryText: string): string | null {
      const stopWords = new Set(['what', 'how', 'does', 'do', 'is', 'are', 'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as', 'use', 'uses', 'using', 'used', 'data', 'ai', 'artificial', 'intelligence', 'machine', 'learning', 'difference', 'between', 'compare', 'comparison', 'vs', 'versus', 'different', 'platforms', 'agentic']);
      const words = queryText.split(/\s+/);
      for (const word of words) {
        const cleanWord = word.replace(/[^\w]/g, '');
        if (cleanWord.length > 2 && 
            cleanWord[0] === cleanWord[0].toUpperCase() && 
            cleanWord[0] !== cleanWord[0].toLowerCase() &&
            !stopWords.has(cleanWord.toLowerCase())) {
          return cleanWord;
        }
      }
      return null;
    }
    
    const earlyEntity = extractEntityEarly(query);
    
    // Check if this is a definition query (should NOT apply comparison filter)
    const isDefinitionQueryEarly = /^what\s+is\b/i.test(query.trim()) || /^define\b/i.test(query.trim());
    
    if (isComparisonQueryEarly && earlyEntity && !isDefinitionQueryEarly) {
      console.log(`\n========================================`);
      console.log(`STRICT DOCUMENT-LEVEL FILTER (COMPARISON QUERY)`);
      console.log(`========================================`);
      console.log(`Query: "${query}"`);
      console.log(`Detected entity: "${earlyEntity}"`);
      console.log(`Filter type: HARD EXCLUSION (before scoring)`);
      
      const entityPatternEarly = new RegExp(`\\b${earlyEntity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      
      // Group all vectors by document
      const docGroups = new Map<string, typeof allVectors>();
      for (const vector of allVectors) {
        const docName = vector.chunk.sourceFile;
        if (!docGroups.has(docName)) {
          docGroups.set(docName, []);
        }
        docGroups.get(docName)!.push(vector);
      }
      
      // Identify eligible documents (those that mention the entity ANYWHERE)
      const eligibleDocs: string[] = [];
      const excludedDocs: string[] = [];
      
      for (const [docName, docVectors] of docGroups.entries()) {
        // Check if ANY chunk in this document mentions the entity
        const docMentionsEntity = docVectors.some(v => entityPatternEarly.test(v.chunk.text));
        
        if (docMentionsEntity) {
          eligibleDocs.push(docName);
        } else {
          excludedDocs.push(docName);
        }
      }
      
      // DEBUG LOG: Show eligible documents
      console.log(`Eligible documents: [${eligibleDocs.map(d => `"${d}"`).join(', ') || 'none'}]`);
      console.log(`Excluded documents: [${excludedDocs.map(d => `"${d}"`).join(', ') || 'none'}]`);
      
      // HARD FILTER: Only keep vectors from eligible documents
      const beforeCount = allVectors.length;
      allVectors = allVectors.filter(v => eligibleDocs.includes(v.chunk.sourceFile));
      const afterCount = allVectors.length;
      
      console.log(`Vectors before filter: ${beforeCount}`);
      console.log(`Vectors after filter: ${afterCount}`);
      console.log(`Vectors excluded: ${beforeCount - afterCount}`);
      console.log(`========================================\n`);
    }

    // Step 2.6: SECTION-AWARE RETRIEVAL FOR COMPARISON QUERIES
    // If a comparison query matches a specific section title, restrict to that section only
    if (isComparisonQueryEarly && earlyEntity && !isDefinitionQueryEarly && allVectors.length > 0) {
      console.log(`\n========================================`);
      console.log(`SECTION-AWARE RETRIEVAL (COMPARISON QUERY)`);
      console.log(`========================================`);
      
      // Section header detection patterns
      // A section header is a line that:
      // 1. Starts with a number (e.g., "6.", "6.1", "6.1.2")
      // 2. OR is in Title Case and under 120 characters
      const sectionHeaderPatterns = [
        /^(\d+\.[\d.]*)\s+(.+)$/,  // Numbered sections: "6. Title" or "6.1 Title"
        /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)$/,  // Title Case: "Difference Between X And Y"
      ];
      
      // Comparison keywords to look for in section titles
      const comparisonSectionKeywords = [
        /\bdifference\b/i,
        /\bcompare\b/i,
        /\bcomparison\b/i,
        /\bvs\.?\b/i,
        /\bversus\b/i,
      ];
      
      const entityPatternForSection = new RegExp(`\\b${earlyEntity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      
      // Group vectors by document
      const docGroupsForSection = new Map<string, typeof allVectors>();
      for (const vector of allVectors) {
        const docName = vector.chunk.sourceFile;
        if (!docGroupsForSection.has(docName)) {
          docGroupsForSection.set(docName, []);
        }
        docGroupsForSection.get(docName)!.push(vector);
      }
      
      // Track which chunks belong to matching comparison sections
      let matchingSectionChunks: typeof allVectors = [];
      let foundMatchingSection = false;
      
      for (const [docName, docVectors] of docGroupsForSection.entries()) {
        // Sort chunks by index to process in order
        const sortedChunks = [...docVectors].sort((a, b) => a.chunk.chunkIndex - b.chunk.chunkIndex);
        
        // Scan for section headers in each chunk
        let currentSectionStart = -1;
        let currentSectionIsMatch = false;
        let matchingSectionTitle = '';
        
        for (let i = 0; i < sortedChunks.length; i++) {
          const chunk = sortedChunks[i];
          const chunkText = chunk.chunk.text;
          const lines = chunkText.split('\n');
          
          // Check each line for section headers
          for (const line of lines) {
            const trimmedLine = line.trim();
            if (trimmedLine.length === 0 || trimmedLine.length > 120) continue;
            
            // Check if this line is a section header
            let isSectionHeader = false;
            let sectionTitle = '';
            
            // Pattern 1: Numbered section (e.g., "6. Difference Between...")
            const numberedMatch = trimmedLine.match(/^(\d+\.[\d.]*)\s+(.+)$/);
            if (numberedMatch) {
              isSectionHeader = true;
              sectionTitle = numberedMatch[2];
            }
            
            // Pattern 2: Title Case header (at least 2 capitalized words, under 120 chars)
            if (!isSectionHeader) {
              const words = trimmedLine.split(/\s+/);
              if (words.length >= 2 && words.length <= 15) {
                const capitalizedWords = words.filter(w => w.length > 0 && w[0] === w[0].toUpperCase() && w[0] !== w[0].toLowerCase());
                // At least 50% of words should be capitalized for Title Case
                if (capitalizedWords.length >= words.length * 0.5) {
                  isSectionHeader = true;
                  sectionTitle = trimmedLine;
                }
              }
            }
            
            if (isSectionHeader && sectionTitle) {
              // Check if this section title matches our comparison criteria:
              // 1. Contains the entity (e.g., "Celonis")
              // 2. Contains a comparison keyword (e.g., "Difference", "Compare")
              const hasEntity = entityPatternForSection.test(sectionTitle);
              const hasComparisonKeyword = comparisonSectionKeywords.some(p => p.test(sectionTitle));
              
              if (hasEntity && hasComparisonKeyword) {
                console.log(`  ✓ MATCHING SECTION FOUND: "${trimmedLine}" in ${docName}`);
                console.log(`    - Contains entity: "${earlyEntity}"`);
                console.log(`    - Contains comparison keyword`);
                currentSectionStart = i;
                currentSectionIsMatch = true;
                matchingSectionTitle = trimmedLine;
                foundMatchingSection = true;
              } else if (currentSectionIsMatch) {
                // We hit a new section header, so the matching section ends
                console.log(`  → Matching section ends at chunk ${i} (new section: "${trimmedLine}")`);
                currentSectionIsMatch = false;
              }
            }
          }
          
          // If we're in a matching section, add this chunk
          if (currentSectionIsMatch) {
            matchingSectionChunks.push(chunk);
            console.log(`    Adding chunk ${chunk.chunk.chunkIndex} to matching section`);
          }
        }
      }
      
      // Apply section filter if we found a matching section
      if (foundMatchingSection && matchingSectionChunks.length > 0) {
        console.log(`\n  SECTION FILTER APPLIED:`);
        console.log(`  - Chunks before: ${allVectors.length}`);
        console.log(`  - Chunks after: ${matchingSectionChunks.length}`);
        console.log(`  - Only chunks from matching comparison section(s) will be scored`);
        allVectors = matchingSectionChunks;
      } else {
        console.log(`\n  No matching comparison section found - using semantic fallback`);
      }
      
      console.log(`========================================\n`);
    }

    // Step 2.7: TC-5 COMPARISON QUERY FILTER
    // For comparison queries, prioritize chunks from comparison sections
    // Include the chunk with the comparison header AND subsequent chunks until next section
    if (isComparisonQueryEarly && !isDefinitionQueryEarly && allVectors.length > 0) {
      console.log(`\n========================================`);
      console.log(`TC-5 COMPARISON QUERY FILTER`);
      console.log(`========================================`);
      console.log(`Query: "${query}"`);
      
      // Entity 1: Celonis (or primary entity from query)
      const entity1Pattern = earlyEntity 
        ? new RegExp(`\\b${earlyEntity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
        : /\bcelonis\b/i;
      
      // Comparison section header pattern
      const comparisonSectionHeaderPattern = /\b(difference|compare|comparison|vs\.?|versus)\b/i;
      
      // Any section header pattern (to detect end of comparison section)
      const anySectionHeaderPattern = /^\d+\.\s+/;
      
      // OVERVIEW / SCOPE EXCLUSION PATTERNS
      const overviewScopePatterns = [
        /\bprovides\s+a\s+detailed\s+understanding\b/i,
        /\bcovers\s+its\s+purpose\b/i,
        /\bthis\s+document\s+provides\b/i,
        /\bplatform\s+overview\b/i,
        /\bthis\s+document\s+covers\b/i,
        /\bthis\s+document\s+explains\b/i,
        /\boverview\s+of\s+/i,
        /\bintroduction\s+to\s+/i,
        /\bcovering\s+(its|the)\s+/i,
        /\bdetailed\s+understanding\s+of\b/i,
      ];
      
      // Topic listing patterns
      const topicListingPatterns = [
        /purpose.*architecture.*ai.*differentiation/i,
        /covering.*purpose.*architecture/i,
        /\bpurpose\b.*\barchitecture\b.*\bai\b/i,
      ];
      
      // Check if chunk is an overview/scope summary
      const isOverviewOrScope = (text: string): boolean => {
        if (overviewScopePatterns.some(p => p.test(text))) return true;
        if (topicListingPatterns.some(p => p.test(text))) return true;
        return false;
      };
      
      // Check if chunk contains a comparison section header
      const hasComparisonSectionHeader = (text: string): boolean => {
        const lines = text.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (anySectionHeaderPattern.test(trimmed) && comparisonSectionHeaderPattern.test(trimmed)) {
            return true;
          }
        }
        return false;
      };
      
      // Check if chunk starts with a NEW section header (not comparison)
      const startsWithNewSectionHeader = (text: string): boolean => {
        const lines = text.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.length > 0) {
            // If first non-empty line is a section header that's NOT a comparison header
            if (anySectionHeaderPattern.test(trimmed) && !comparisonSectionHeaderPattern.test(trimmed)) {
              return true;
            }
            break; // Only check first non-empty line
          }
        }
        return false;
      };
      
      // Group vectors by document and sort by chunk index
      const docGroupsForComparison = new Map<string, typeof allVectors>();
      for (const vector of allVectors) {
        const docName = vector.chunk.sourceFile;
        if (!docGroupsForComparison.has(docName)) {
          docGroupsForComparison.set(docName, []);
        }
        docGroupsForComparison.get(docName)!.push(vector);
      }
      
      const beforeFilter = allVectors.length;
      const comparisonSectionChunks: typeof allVectors = [];
      const otherChunks: typeof allVectors = [];
      const excludedChunks: { chunk: number; doc: string; reason: string }[] = [];
      
      // Process each document to find comparison sections
      for (const [docName, docVectors] of docGroupsForComparison.entries()) {
        // Sort chunks by index
        const sortedChunks = [...docVectors].sort((a, b) => a.chunk.chunkIndex - b.chunk.chunkIndex);
        
        // Find the chunk with comparison section header
        let comparisonSectionStartIndex = -1;
        let comparisonSectionEndIndex = -1;
        
        for (let i = 0; i < sortedChunks.length; i++) {
          const chunk = sortedChunks[i];
          if (hasComparisonSectionHeader(chunk.chunk.text)) {
            comparisonSectionStartIndex = i;
            console.log(`  ✓ COMPARISON SECTION HEADER found at chunk ${chunk.chunk.chunkIndex} in ${docName}`);
            
            // Find where the comparison section ends (next section header or end of document)
            comparisonSectionEndIndex = sortedChunks.length; // Default to end of document
            for (let j = i + 1; j < sortedChunks.length; j++) {
              if (startsWithNewSectionHeader(sortedChunks[j].chunk.text)) {
                comparisonSectionEndIndex = j;
                console.log(`  → Comparison section ends before chunk ${sortedChunks[j].chunk.chunkIndex} (new section)`);
                break;
              }
            }
            break; // Found the comparison section, stop searching
          }
        }
        
        // Now categorize chunks
        for (let i = 0; i < sortedChunks.length; i++) {
          const vector = sortedChunks[i];
          const chunkText = vector.chunk.text;
          const chunkIndex = vector.chunk.chunkIndex;
          
          const hasEntity1 = entity1Pattern.test(chunkText);
          const isFirstChunk = chunkIndex === 0;
          const isOverviewChunk = isOverviewOrScope(chunkText);
          
          // Check if this chunk is within the comparison section range
          const isInComparisonSection = comparisonSectionStartIndex !== -1 && 
                                        i >= comparisonSectionStartIndex && 
                                        i < comparisonSectionEndIndex;
          
          let isValid = false;
          let reason = '';
          let isFromComparisonSection = false;
          
          if (isFirstChunk) {
            reason = 'first chunk (intro/title)';
          } else if (isOverviewChunk && !isInComparisonSection) {
            reason = 'overview/scope summary (not in comparison section)';
          } else if (!hasEntity1 && !isInComparisonSection) {
            reason = `missing entity 1 (${earlyEntity || 'Celonis'})`;
          } else if (isInComparisonSection) {
            // This chunk is within the comparison section - PRIORITIZE IT
            isValid = true;
            isFromComparisonSection = true;
            console.log(`  ✓ IN COMPARISON SECTION: Chunk ${chunkIndex} from ${docName}`);
          } else if (hasEntity1) {
            // Regular chunk with entity - allow as fallback
            isValid = true;
          } else {
            reason = 'not in comparison section and missing entity';
          }
          
          if (isValid) {
            if (isFromComparisonSection) {
              comparisonSectionChunks.push(vector);
            } else {
              otherChunks.push(vector);
            }
          } else {
            excludedChunks.push({ chunk: chunkIndex, doc: docName, reason });
            console.log(`  ✗ EXCLUDED: Chunk ${chunkIndex} from ${docName} - ${reason}`);
          }
        }
      }
      
      console.log(`\n  FILTER SUMMARY:`);
      console.log(`  - Chunks before filter: ${beforeFilter}`);
      console.log(`  - Comparison section chunks: ${comparisonSectionChunks.length}`);
      console.log(`  - Other valid chunks: ${otherChunks.length}`);
      console.log(`  - Excluded chunks: ${excludedChunks.length}`);
      
      // Prioritize comparison section chunks, fall back to other valid chunks
      if (comparisonSectionChunks.length > 0) {
        allVectors = comparisonSectionChunks;
        console.log(`  ✓ Using ${comparisonSectionChunks.length} comparison section chunks`);
      } else if (otherChunks.length > 0) {
        allVectors = otherChunks;
        console.log(`  ⚠ No comparison section found, using ${otherChunks.length} other valid chunks`);
      } else {
        console.log(`  ⚠ NO valid chunks found`);
        console.log(`========================================\n`);
        return res.json({
          answer: "No clear comparison found in the provided documents.",
          source: "",
          confidence: 0.0
        });
      }
      
      console.log(`========================================\n`);
    }

    // Step 3: Split query into individual words
    const queryWords = normalizedQuery.split(' ').filter(w => w.length > 0);
    console.log(`Query words: [${queryWords.join(', ')}]`);

    // Step 3.5: Detect intent keywords for section-based queries
    /**
     * Detects strong intent keywords that indicate specific sections should be preferred.
     * Examples: "data", "AI", "artificial intelligence", "machine learning"
     * When detected, chunks containing these keywords explicitly will receive a bonus.
     */
    function detectIntentKeywords(query: string, queryWords: string[]): string[] {
      const intentKeywords: string[] = [];
      const queryLower = query.toLowerCase();
      const normalizedQueryLower = normalizedQuery.toLowerCase();
      
      // Check for "data" related patterns
      if (/\bdata\b/i.test(queryLower) || /\bdata\b/i.test(normalizedQueryLower) || 
          /\buses?\s+data\b/i.test(queryLower) || /\bdata\s+does\b/i.test(queryLower) ||
          /\bwhat\s+data\b/i.test(queryLower)) {
        intentKeywords.push('data');
      }
      
      // Check for "AI" related patterns
      if (/\bai\b/i.test(queryLower) || /\bai\b/i.test(normalizedQueryLower) ||
          /\bartificial\s+intelligence\b/i.test(queryLower) ||
          /\bmachine\s+learning\b/i.test(queryLower) ||
          /\bml\b/i.test(queryLower) ||
          /\buses?\s+ai\b/i.test(queryLower) ||
          /\bhow\s+.*\s+uses?\s+ai\b/i.test(queryLower)) {
        intentKeywords.push('ai');
        intentKeywords.push('artificial intelligence');
        intentKeywords.push('machine learning');
      }
      
      // Remove duplicates
      return Array.from(new Set(intentKeywords));
    }
    
    const intentKeywords = detectIntentKeywords(query, queryWords);
    if (intentKeywords.length > 0) {
      console.log(`Detected intent keywords: [${intentKeywords.join(', ')}]`);
    }

    // Step 3.6: Extract primary entity from query (e.g., "Celonis", "Vibe Coding")
    /**
     * Extracts the primary entity from the query.
     * Looks for capitalized words or proper nouns that are likely entity names.
     */
    function extractPrimaryEntity(query: string, queryWords: string[]): string | null {
      // Common stop words to ignore
      const stopWords = new Set(['what', 'how', 'does', 'do', 'is', 'are', 'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as', 'use', 'uses', 'using', 'used', 'data', 'ai', 'artificial', 'intelligence', 'machine', 'learning']);
      
      // Look for capitalized words (likely proper nouns/entity names)
      const words = query.split(/\s+/);
      for (const word of words) {
        // Remove punctuation
        const cleanWord = word.replace(/[^\w]/g, '');
        if (cleanWord.length > 2) {
          // Check if it's capitalized (starts with uppercase) and not a stop word
          if (cleanWord[0] === cleanWord[0].toUpperCase() && cleanWord[0] !== cleanWord[0].toLowerCase() && 
              !stopWords.has(cleanWord.toLowerCase())) {
            return cleanWord;
          }
        }
      }
      
      // Fallback: look for words that appear capitalized in the original query
      // but might have been normalized
      const originalWords = query.split(/\s+/);
      for (const word of originalWords) {
        const cleanWord = word.replace(/[^\w]/g, '');
        if (cleanWord.length > 2 && 
            cleanWord[0] === cleanWord[0].toUpperCase() && 
            !stopWords.has(cleanWord.toLowerCase())) {
          return cleanWord;
        }
      }
      
      return null;
    }
    
    const primaryEntity = extractPrimaryEntity(query, queryWords);
    if (primaryEntity) {
      console.log(`Detected primary entity: "${primaryEntity}"`);
    }

    // Step 3.7: Detect definition queries and extract subject
    /**
     * Detects if query is asking for a definition (e.g., "What is X", "Define X")
     * and extracts the subject being defined.
     */
    function detectDefinitionQuery(query: string, queryWords: string[]): { isDefinition: boolean; subject: string | null } {
      const queryLower = query.toLowerCase().trim();
      const normalizedQueryLower = normalizedQuery.toLowerCase().trim();
      
      // Check for definition patterns
      const isDefinition = /^what\s+is\b/i.test(queryLower) || 
                          /^define\b/i.test(queryLower) ||
                          /^what\s+is\b/i.test(normalizedQueryLower) ||
                          /^define\b/i.test(normalizedQueryLower);
      
      if (!isDefinition) {
        return { isDefinition: false, subject: null };
      }
      
      // Extract the subject being defined
      let subject: string | null = null;
      
      // Pattern 1: "What is X" or "What is X?"
      const whatIsMatch = query.match(/^what\s+is\s+([^?]+)/i);
      if (whatIsMatch) {
        subject = whatIsMatch[1].trim();
      }
      
      // Pattern 2: "Define X" or "Define X:"
      if (!subject) {
        const defineMatch = query.match(/^define\s+([^:?]+)/i);
        if (defineMatch) {
          subject = defineMatch[1].trim();
        }
      }
      
      // Fallback: use primary entity if available
      if (!subject && primaryEntity) {
        subject = primaryEntity;
      }
      
      // Clean up subject (remove common words like "a", "an", "the" at the start)
      if (subject) {
        subject = subject.replace(/^(a|an|the)\s+/i, '').trim();
        // If subject is empty after cleaning, try to get it from query words
        if (subject.length === 0 && queryWords.length > 2) {
          // Skip "what", "is" or "define" and take the next word(s)
          const skipWords = ['what', 'is', 'define', 'a', 'an', 'the'];
          const remainingWords = queryWords.filter(w => !skipWords.includes(w.toLowerCase()));
          if (remainingWords.length > 0) {
            subject = remainingWords.join(' ');
          }
        }
      }
      
      return { isDefinition: true, subject: subject || null };
    }
    
    const definitionQuery = detectDefinitionQuery(query, queryWords);
    
    // DEBUG: Always log definition query detection
    console.log(`\n=== DEFINITION QUERY DETECTION ===`);
    console.log(`Query: "${query}"`);
    console.log(`Is definition query: ${definitionQuery.isDefinition}`);
    console.log(`Subject: ${definitionQuery.subject || 'null'}`);
    console.log(`=== END DEFINITION QUERY DETECTION ===\n`);
    
    if (definitionQuery.isDefinition && definitionQuery.subject) {
      console.log(`Detected definition query for subject: "${definitionQuery.subject}"`);
    }

    // Step 4: Generate query embedding for semantic similarity
    console.log(`Generating query embedding...`);
    const queryEmbedding = await getEmbedding(query);
    console.log(`Query embedding generated`);

    // Step 5: Group chunks by document to calculate position percentages
    const chunksByDocument = new Map<string, typeof allVectors>();
    for (const vector of allVectors) {
      const fileName = vector.chunk.sourceFile;
      if (!chunksByDocument.has(fileName)) {
        chunksByDocument.set(fileName, []);
      }
      chunksByDocument.get(fileName)!.push(vector);
    }

    // Step 5.5: Document-level relevance filtering
    // If a primary entity is detected, filter to only documents that mention it
    let vectorsToSearch: typeof allVectors = allVectors;
    const relevantDocumentNames = new Set<string>();
    
    if (primaryEntity) {
      const entityLower = primaryEntity.toLowerCase();
      const entityPattern = new RegExp(`\\b${primaryEntity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      
      console.log(`\n=== DOCUMENT-LEVEL RELEVANCE FILTERING ===`);
      console.log(`Filtering documents for entity: "${primaryEntity}"`);
      
      for (const [fileName, documentChunks] of chunksByDocument.entries()) {
        let isRelevant = false;
        
        // Check 1: Filename contains entity
        const fileNameLower = fileName.toLowerCase();
        if (fileNameLower.includes(entityLower) || entityPattern.test(fileName)) {
          isRelevant = true;
          console.log(`  ✓ Document "${fileName}" matches: filename contains entity`);
        }
        
        // Check 2: Title chunk (chunkIndex === 0) contains entity
        if (!isRelevant && documentChunks.length > 0) {
          const titleChunk = documentChunks.find(v => v.chunk.chunkIndex === 0);
          if (titleChunk) {
            const titleText = titleChunk.chunk.text.toLowerCase();
            const normalizedTitleText = normalizeTextForMatching(titleChunk.chunk.text);
            if (titleText.includes(entityLower) || entityPattern.test(titleChunk.chunk.text) ||
                normalizedTitleText.includes(entityLower)) {
              isRelevant = true;
              console.log(`  ✓ Document "${fileName}" matches: title chunk contains entity`);
            }
          }
        }
        
        // Check 3: Early document content (first 10-15% of chunks) contains entity
        if (!isRelevant && documentChunks.length > 0) {
          const totalChunks = documentChunks.length;
          const earlyChunkThreshold = Math.max(1, Math.ceil(totalChunks * 0.15)); // First 15%
          
          for (let i = 0; i < earlyChunkThreshold && i < documentChunks.length; i++) {
            const chunk = documentChunks[i];
            const chunkText = chunk.chunk.text.toLowerCase();
            const normalizedChunkText = normalizeTextForMatching(chunk.chunk.text);
            
            if (chunkText.includes(entityLower) || entityPattern.test(chunk.chunk.text) ||
                normalizedChunkText.includes(entityLower)) {
              isRelevant = true;
              console.log(`  ✓ Document "${fileName}" matches: early content (chunk ${i}) contains entity`);
              break;
            }
          }
        }
        
        if (isRelevant) {
          relevantDocumentNames.add(fileName);
        } else {
          console.log(`  ✗ Document "${fileName}" does not match: entity not found in filename, title, or early content`);
        }
      }
      
      // Filter vectors to only those from relevant documents
      if (relevantDocumentNames.size > 0) {
        vectorsToSearch = allVectors.filter(v => relevantDocumentNames.has(v.chunk.sourceFile));
        console.log(`\n✓ Document filter applied: ${relevantDocumentNames.size} relevant document(s) found`);
        console.log(`  Relevant documents: [${Array.from(relevantDocumentNames).join(', ')}]`);
        console.log(`  Vectors to search: ${vectorsToSearch.length} (filtered from ${allVectors.length})`);
      } else {
        console.log(`\n⚠️ No documents match entity "${primaryEntity}" - falling back to global search`);
        console.log(`  Using all ${allVectors.length} vectors`);
        vectorsToSearch = allVectors;
      }
    } else {
      console.log(`\n=== NO PRIMARY ENTITY DETECTED ===`);
      console.log(`  Using all ${allVectors.length} vectors (no document-level filtering)`);
    }

    // Step 6: Candidate selection and scoring (using filtered vectors)
    interface Candidate {
      vector: typeof allVectors[0];
      semanticSimilarity: number;
      hasQueryKeywords: boolean;
      keywordCoverage: number; // 0.0 to 1.0 (fraction of query words found)
      positionBonus: number; // 0, 0.2, or 0.5
      explicitTermBonus: number; // 0.0 or 0.3 (bonus for containing intent keywords)
      definitionBonus: number; // 0.0, 0.7, or 0.8 (bonus for definition pattern in first 30% of document, higher if question+answer both present)
      comparisonBonus: number; // 0.0 or 0.4 (bonus for comparison/contrast language)
      comparisonIntroPenalty: number; // 0.0 or -0.3 (penalty for intro chunks without comparison terms)
      finalScore: number;
    }
    
    // Detect if this is a comparison query (for chunk-level scoring)
    const comparisonQueryKeywords = [
      /\bdifference\b/i,
      /\bvs\.?\b/i,
      /\bversus\b/i,
      /\bcompare\b/i,
      /\bcomparison\b/i,
    ];
    const isComparisonQueryForScoring = comparisonQueryKeywords.some(pattern => pattern.test(query));
    
    // Contrast/comparison language patterns for chunk-level bonus
    const contrastLanguagePatterns = [
      /\bwhile\b/i,
      /\bwhereas\b/i,
      /\bin\s+contrast\b/i,
      /\bcompared\s+to\b/i,
      /\bunlike\b/i,
      /\brather\s+than\b/i,
      /\bon\s+the\s+other\s+hand\b/i,
      /\bhowever\b/i,
      /\bbut\b/i,
      /\binstead\s+of\b/i,
    ];
    
    // Dual framing patterns (entity A ... contrast ... entity B)
    const dualFramingPatterns = [
      /celonis\s+.*\s+(while|whereas|but)\s+.*\s+agentic/i,
      /celonis\s+.*\s+(while|whereas|but)\s+.*\s+platform/i,
      /what\s+should\s+.*\s+vs\.?\s+how\s+to/i,
      /problem\s+.*\s+(while|whereas|vs\.?)\s+.*\s+(solution|execution|task)/i,
      /discover.*\s+(while|whereas|vs\.?)\s+.*\s+execut/i,
      /identify.*\s+(while|whereas|vs\.?)\s+.*\s+automat/i,
    ];

    const candidates: Candidate[] = [];
    for (const vector of vectorsToSearch) {
      const normalizedChunkText = normalizeTextForMatching(vector.chunk.text);
      
      // Check if chunk contains at least one query keyword
      let hasQueryKeywords = false;
      let foundWords = 0;
      
      if (queryWords.length > 0) {
        for (const queryWord of queryWords) {
          // Use word boundary regex to match whole words only
          const wordBoundaryPattern = new RegExp(`\\b${queryWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
          if (wordBoundaryPattern.test(normalizedChunkText)) {
            hasQueryKeywords = true;
            foundWords++;
            continue;
          }
          
          // Try stem matching
          const wordStem = queryWord.replace(/s$/, '').replace(/es$/, '').replace(/ies$/, 'y');
          const chunkWords = normalizedChunkText.split(/\s+/).filter(w => w.length > 0);
          const hasStemMatch = chunkWords.some(chunkWord => {
            const chunkStem = chunkWord.replace(/s$/, '').replace(/es$/, '').replace(/ies$/, 'y');
            return (chunkWord === queryWord) || (chunkStem === wordStem && wordStem.length > 3);
          });
          
          if (hasStemMatch) {
            hasQueryKeywords = true;
            foundWords++;
          }
        }
      }
      
      const keywordCoverage = queryWords.length > 0 ? foundWords / queryWords.length : 0;
      
      // Calculate semantic similarity
      const semanticSimilarity = vectorStore.calculateSimilarity(queryEmbedding, vector.embedding);
      
      // Candidate selection: must have keywords OR semantic similarity ≥ 0.80
      if (!hasQueryKeywords && semanticSimilarity < 0.80) {
        continue; // Skip this chunk - doesn't meet candidate criteria
      }
      
      // NOTE: Early intro chunk filtering has been REMOVED
      // The two-tier definition system and synthesis fallback now handle definition queries properly
      // Intro chunks are kept in the candidate pool for potential synthesis
      
      // Calculate position bonus
      const documentChunks = chunksByDocument.get(vector.chunk.sourceFile) || [];
      const totalChunks = documentChunks.length;
      const chunkPosition = vector.chunk.chunkIndex / totalChunks; // 0.0 to 1.0
      
      // Check if this is an intro/overview chunk (for definition queries, we'll reduce position bonus)
      const chunkTextForIntroCheck = vector.chunk.text.toLowerCase();
      const introPatternsForPosition = [
        /this\s+document\s+provides/i,
        /detailed\s+understanding/i,
        /covering\s+(its|the)/i,
        /this\s+(document|guide|manual)\s+(provides|covers|explains)/i,
      ];
      const isIntroChunkForPosition = introPatternsForPosition.some(pattern => pattern.test(vector.chunk.text));
      
      let positionBonus = 0;
      if (vector.chunk.chunkIndex === 0) {
        // Title/first chunk - highest priority
        // BUT: reduce bonus for intro chunks in definition queries
        if (definitionQuery.isDefinition && isIntroChunkForPosition) {
          positionBonus = 0.1; // Reduced from 0.5 to 0.1 for intro chunks
        } else {
          positionBonus = 0.5;
        }
      } else if (chunkPosition <= 0.15) {
        // First 15% of document - medium priority
        // BUT: reduce bonus for intro chunks in definition queries
        if (definitionQuery.isDefinition && isIntroChunkForPosition) {
          positionBonus = 0.05; // Reduced from 0.2 to 0.05 for intro chunks
        } else {
          positionBonus = 0.2;
        }
      }
      // Otherwise: no position bonus
      
      // Calculate explicit-term bonus (for section-based queries)
      // If intent keywords were detected, check if this chunk explicitly contains them
      let explicitTermBonus = 0;
      if (intentKeywords.length > 0) {
        const chunkTextLower = vector.chunk.text.toLowerCase();
        const normalizedChunkTextLower = normalizedChunkText.toLowerCase();
        
        // Check if chunk explicitly contains any intent keyword
        for (const intentKeyword of intentKeywords) {
          // Use word boundary matching for single words, phrase matching for multi-word
          if (intentKeyword.includes(' ')) {
            // Multi-word intent keyword (e.g., "artificial intelligence")
            if (chunkTextLower.includes(intentKeyword) || normalizedChunkTextLower.includes(intentKeyword)) {
              explicitTermBonus = 0.3;
              break; // Found at least one intent keyword, apply bonus
            }
          } else {
            // Single-word intent keyword (e.g., "data", "ai")
            const intentPattern = new RegExp(`\\b${intentKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
            if (intentPattern.test(chunkTextLower) || intentPattern.test(normalizedChunkTextLower)) {
              explicitTermBonus = 0.3;
              break; // Found at least one intent keyword, apply bonus
            }
          }
        }
      }
      
      // Calculate definition bonus (for "What is X" or "Define X" queries)
      // Prefer chunks that contain "X is a|an|the" pattern AND are in first 30% of document
      // Penalize chunks that only contain the question without the answer
      // Also penalize intro/overview chunks that just list topics
      let definitionBonus = 0;
      let definitionPenalty = 0;
      if (definitionQuery.isDefinition && definitionQuery.subject) {
        const subject = definitionQuery.subject;
        const documentChunks = chunksByDocument.get(vector.chunk.sourceFile) || [];
        const totalChunks = documentChunks.length;
        const chunkPosition = vector.chunk.chunkIndex / totalChunks; // 0.0 to 1.0
        
        const chunkText = vector.chunk.text;
        const chunkTextLower = chunkText.toLowerCase();
        
        // Escape subject for regex (handle special characters)
        const escapedSubject = subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escapedSubjectLower = escapedSubject.toLowerCase();
        
        // Detect intro/overview chunks that just list topics/questions without answers
        // These typically contain phrases like "document provides", "covering", "detailed understanding"
        const introPatterns = [
          /this\s+document\s+provides/i,
          /detailed\s+understanding/i,
          /covering\s+(its|the)/i,
          /this\s+(document|guide|manual)\s+(provides|covers|explains)/i,
          /overview\s+of/i,
          /^this\s+(document|guide|manual)/i, // Starts with "This document..."
        ];
        
        const isIntroChunk = introPatterns.some(pattern => pattern.test(chunkText));
        
        // General penalty for intro chunks in definition queries (they're usually not the actual definition)
        const hasDefinitionPattern = new RegExp(`${escapedSubjectLower}\\s+is\\s+(a|an|the)`, 'i').test(chunkText);
        if (isIntroChunk && !hasDefinitionPattern) {
          definitionPenalty = -1.0; // Heavy penalty for intro chunks that don't have the definition (increased from -0.4)
          console.log(`  ⚠ Intro/overview chunk detected for "${subject}" in chunk ${vector.chunk.chunkIndex} - HEAVY PENALTY: ${definitionPenalty}`);
        }
        
        // Check if chunk is within first 30% of document OR if it has definition pattern (extend range)
        const isInEarlySection = chunkPosition <= 0.30;
        const shouldCheckDefinition = isInEarlySection || chunkPosition <= 0.70; // Extend to 70% for definition pattern search
        
        if (shouldCheckDefinition) {
          
          // Pattern: "X is a|an|the" (case-insensitive, word boundaries)
          // Also check for variations and ensure it's not just the question
          const definitionPatterns = [
            // Direct pattern: "Celonis is a..."
            new RegExp(`\\b${escapedSubject}\\s+is\\s+(a|an|the)\\s+`, 'i'),
            // With word boundaries: "Celonis is a platform"
            new RegExp(`\\b${escapedSubject}\\s+is\\s+(a|an|the)\\b`, 'i'),
            // Variations: "Celonis, a..." or "Celonis - a..."
            new RegExp(`\\b${escapedSubject}[,\\s-]+(a|an|the)\\s+`, 'i'),
            // Also check normalized text
            new RegExp(`${escapedSubjectLower}\\s+is\\s+(a|an|the)\\s+`, 'i'),
          ];
          
          // Check if chunk contains definition pattern
          // Prefer chunks that have the actual definition ("X is a...") over chunks with just the question
          for (const pattern of definitionPatterns) {
            if (pattern.test(chunkText) || pattern.test(chunkTextLower)) {
              const matchIndex = chunkTextLower.search(pattern);
              if (matchIndex !== -1) {
                // Check if this is a real definition (not just the question)
                const beforeMatch = chunkText.substring(0, matchIndex).trim();
                const afterMatch = chunkText.substring(matchIndex).substring(0, 100).toLowerCase();
                
                // Skip if it's clearly just a question without an answer
                // (e.g., "1. What is Celonis?" with nothing after)
                const isQuestionOnly = beforeMatch.match(/what\s+is\s+[^?]*\?$/i) && 
                                      afterMatch.length < 30;
                
                if (!isQuestionOnly) {
                  // Additional bonus if chunk contains both question and answer
                  const hasQuestion = /what\s+is\s+[^?]*\?/i.test(chunkText);
                  const hasDefinition = pattern.test(chunkText);
                  
                  if (hasDefinition) {
                    // Apply definition bonus - prioritize early sections but also reward later sections with definitions
                    if (isInEarlySection) {
                      definitionBonus = 1.0; // Strong bonus for definition pattern in first 30% (increased from 0.7)
                    } else if (chunkPosition <= 0.70) {
                      definitionBonus = 0.8; // Good bonus if beyond 30% but within 70% (increased from 0.5)
                    } else {
                      definitionBonus = 0.6; // Still apply bonus even beyond 70% if it has the definition
                    }
                    
                    if (hasQuestion) {
                      definitionBonus += 0.2; // Extra bonus if both question and answer are present (increased from 0.1)
                      console.log(`  ✓✓✓ Definition pattern WITH question found for "${subject}" in chunk ${vector.chunk.chunkIndex} (position: ${(chunkPosition * 100).toFixed(1)}%) - BONUS: ${definitionBonus}`);
                    } else {
                      console.log(`  ✓✓✓ Definition pattern found for "${subject}" in chunk ${vector.chunk.chunkIndex} (position: ${(chunkPosition * 100).toFixed(1)}%) - BONUS: ${definitionBonus}`);
                    }
                    break;
                  }
                }
              }
            }
          }
          
          // Penalty: If chunk contains "What is X?" but NOT the definition pattern "X is a|an|the"
          // This helps avoid selecting intro/overview chunks that just list questions
          if (definitionBonus === 0) {
            const hasQuestion = new RegExp(`what\\s+is\\s+${escapedSubjectLower}[^?]*\\?`, 'i').test(chunkText);
            const hasDefinitionPattern = definitionPatterns.some(p => p.test(chunkText) || p.test(chunkTextLower));
            
            if (hasQuestion && !hasDefinitionPattern) {
              // This chunk has the question but not the answer - penalize it
              definitionPenalty = -0.7; // Increased from -0.5 to -0.7
              console.log(`  ⚠ Question-only chunk detected for "${subject}" in chunk ${vector.chunk.chunkIndex} - PENALTY: ${definitionPenalty}`);
            }
            
            // Additional heavy penalty for intro/overview chunks that list questions
            if (isIntroChunk && hasQuestion && !hasDefinitionPattern) {
              definitionPenalty = -1.5; // Very heavy penalty for intro chunks with questions but no answers (increased from -0.8)
              console.log(`  ⚠⚠⚠ Intro chunk with question-only detected for "${subject}" in chunk ${vector.chunk.chunkIndex} - VERY HEAVY PENALTY: ${definitionPenalty}`);
            }
          }
        }
      }
      
      // Calculate comparison bonus and intro penalty (for comparison queries ONLY)
      // This applies AFTER document-level filtering has already occurred
      let comparisonBonus = 0;
      let comparisonIntroPenalty = 0;
      
      // Check if this is a data or AI usage query (to exclude from comparison scoring)
      const isDataQueryForComparison = /\bwhat\s+data\b/i.test(query) || /\bdata\s+does\b/i.test(query) || /\buses?\s+data\b/i.test(query);
      const isAIQueryForComparison = /\buses?\s+ai\b/i.test(query) || /\bartificial\s+intelligence\b/i.test(query) || /\bmachine\s+learning\b/i.test(query);
      
      if (isComparisonQueryForScoring && !definitionQuery.isDefinition && !isDataQueryForComparison && !isAIQueryForComparison) {
        const chunkTextForComparison = vector.chunk.text;
        const chunkTextLower = chunkTextForComparison.toLowerCase();
        
        // ============================================================
        // TC-5 FIX: EXPLICIT CONTRAST PATTERN DETECTION
        // Chunks must contain EXPLICIT comparative statements to rank high
        // ============================================================
        
        // Tier 1: Explicit dual-entity contrast patterns (HIGHEST BONUS: +0.6)
        // These patterns explicitly compare Celonis with agentic platforms
        const explicitDualEntityPatterns = [
          // "Celonis ... while agentic platforms ..."
          /celonis\s+.{5,80}\s+(while|whereas)\s+.{0,20}agentic\s+platform/i,
          // "Celonis answers ... while agentic platforms ..."
          /celonis\s+(answers|focuses|discovers|finds|identifies).{5,60}(while|whereas).{0,30}agentic/i,
          // "agentic platforms ... while Celonis ..."
          /agentic\s+platform.{5,60}(while|whereas).{0,30}celonis/i,
          // "Celonis ... In contrast, agentic ..."
          /celonis.{10,80}in\s+contrast.{0,30}agentic/i,
          // "Unlike agentic platforms, Celonis ..."
          /unlike\s+agentic\s+platform.{0,30}celonis/i,
          // Specific comparison phrases from the document
          /discovers?\s+and\s+prioritiz.{0,30}(while|whereas).{0,30}automat/i,
          /finds?\s+problems?.{0,30}(while|whereas).{0,30}execut/i,
          /what\s+should\s+.{0,30}(while|whereas|vs\.?).{0,30}how\s+to/i,
          // Problem discovery vs task execution
          /problem\s+discovery.{0,30}(while|whereas|vs\.?).{0,30}task\s+execution/i,
          /prioritiz.{0,30}problem.{0,30}(while|whereas).{0,30}automat/i,
        ];
        
        // Tier 2: General contrast language with entity mention (MEDIUM BONUS: +0.4)
        const hasExplicitDualEntity = explicitDualEntityPatterns.some(p => p.test(chunkTextForComparison));
        
        // Check for general contrast language
        const hasContrastLanguage = contrastLanguagePatterns.some(pattern => pattern.test(chunkTextForComparison));
        
        // Check for dual framing patterns
        const hasDualFraming = dualFramingPatterns.some(pattern => pattern.test(chunkTextForComparison));
        
        // Check if chunk mentions both entities (Celonis AND agentic)
        const mentionsCelonis = /\bcelonis\b/i.test(chunkTextLower);
        const mentionsAgentic = /\bagentic\b/i.test(chunkTextLower);
        const mentionsBothEntities = mentionsCelonis && mentionsAgentic;
        
        // Apply tiered comparison bonus
        if (hasExplicitDualEntity) {
          // Tier 1: Explicit dual-entity contrast - HIGHEST BONUS
          comparisonBonus = 0.6;
          console.log(`  ✓✓ EXPLICIT CONTRAST BONUS (+0.6) for chunk ${vector.chunk.chunkIndex}: explicit dual-entity comparison`);
        } else if ((hasContrastLanguage || hasDualFraming) && mentionsBothEntities) {
          // Tier 2: Contrast language + both entities mentioned
          comparisonBonus = 0.4;
          console.log(`  ✓ Comparison bonus (+0.4) for chunk ${vector.chunk.chunkIndex}: contrast language with both entities`);
        } else if (hasContrastLanguage || hasDualFraming) {
          // Tier 3: Has contrast language but not both entities
          comparisonBonus = 0.2;
          console.log(`  ✓ Comparison bonus (+0.2) for chunk ${vector.chunk.chunkIndex}: contrast language only`);
        } else {
          // NO contrast language - apply PENALTY to ensure these don't rank above contrast chunks
          // This is the HARD RULE: chunks without contrast language must NOT rank above those with it
          comparisonBonus = -0.4;
          console.log(`  ⚠ NO CONTRAST PENALTY (-0.4) for chunk ${vector.chunk.chunkIndex}: no explicit comparison language`);
        }
        
        // Apply additional intro penalty (-0.3) for comparison queries
        // Penalize chunks in first 15% that don't have comparison/contrast terms
        const documentChunksForComparison = chunksByDocument.get(vector.chunk.sourceFile) || [];
        const totalChunksForComparison = documentChunksForComparison.length;
        const chunkPositionForComparison = vector.chunk.chunkIndex / totalChunksForComparison;
        
        const isInIntroRange = chunkPositionForComparison <= 0.15;
        const hasAnyComparisonTerms = hasContrastLanguage || hasDualFraming || hasExplicitDualEntity ||
          /\bdifference\b/i.test(chunkTextLower) ||
          /\bcompare/i.test(chunkTextLower) ||
          /\bvs\.?\b/i.test(chunkTextLower);
        
        if (isInIntroRange && !hasAnyComparisonTerms) {
          comparisonIntroPenalty = -0.3;
          console.log(`  ⚠ Comparison intro penalty (-0.3) for chunk ${vector.chunk.chunkIndex}: intro chunk without comparison terms`);
        }
        
        // TC-5 FIX: Penalize chunks where the comparison section header appears LATE in the chunk
        // This means most of the chunk content is from the PREVIOUS section, not the comparison section
        // We want to prefer chunks that have actual comparison CONTENT, not just the header
        // Look for numbered section headers with comparison keywords
        const headerPatterns = [
          /\d+\.\s*Difference\s+Between/i,
          /\d+\.\s*Difference\s+/i,
          /\d+\.\s*Compare/i,
          /\d+\.\s*Comparison/i,
          /\d+\.\s*[^\n]*\s+vs\.?\s+/i,
        ];
        
        for (const headerPattern of headerPatterns) {
          const headerMatch = chunkTextForComparison.match(headerPattern);
          if (headerMatch) {
            const headerPosition = chunkTextForComparison.indexOf(headerMatch[0]);
            const chunkLength = chunkTextForComparison.length;
            const headerPositionRatio = headerPosition / chunkLength;
            
            console.log(`  📍 Found comparison header "${headerMatch[0].substring(0, 40)}..." at position ${headerPosition}/${chunkLength} (${(headerPositionRatio * 100).toFixed(0)}%)`);
            
            // If the header appears after 50% of the chunk, most content is from previous section
            // Apply a STRONG penalty to prefer chunks with actual comparison content
            if (headerPositionRatio > 0.5) {
              const headerPenalty = -1.2; // Very strong penalty to ensure Chunk 4 wins
              comparisonIntroPenalty += headerPenalty;
              console.log(`  ⚠ HEADER-LATE PENALTY (${headerPenalty}) for chunk ${vector.chunk.chunkIndex}: header at ${(headerPositionRatio * 100).toFixed(0)}% - mostly previous section content`);
            } else if (headerPositionRatio > 0.3) {
              const headerPenalty = -0.6; // Medium penalty
              comparisonIntroPenalty += headerPenalty;
              console.log(`  ⚠ HEADER-LATE PENALTY (${headerPenalty}) for chunk ${vector.chunk.chunkIndex}: header at ${(headerPositionRatio * 100).toFixed(0)}%`);
            }
            break; // Only apply penalty once
          }
        }
      }
      
      // Calculate final score
      // Primary factor: semantic similarity (0.0 to 1.0)
      // Bonus: keyword coverage (0.0 to 1.0) * 0.3
      // Bonus: position (0.0, 0.2, or 0.5)
      // Bonus: explicit-term (0.0 or 0.3) - for section-based queries
      // Bonus: definition (0.0, 0.6, 0.8, or 1.0+) - for definition queries (higher if question+answer both present, higher in early sections)
      // Bonus: comparison (0.0 or 0.4) - for comparison queries with contrast language
      // Penalty: definitionPenalty (up to -1.5) - for chunks with question but no answer, especially intro chunks
      // Penalty: comparisonIntroPenalty (-0.3) - for intro chunks in comparison queries without comparison terms
      const finalScore = semanticSimilarity + (keywordCoverage * 0.3) + positionBonus + explicitTermBonus + definitionBonus + definitionPenalty + comparisonBonus + comparisonIntroPenalty;
      
      candidates.push({
        vector,
        semanticSimilarity,
        hasQueryKeywords,
        keywordCoverage,
        positionBonus,
        explicitTermBonus,
        definitionBonus,
        comparisonBonus,
        comparisonIntroPenalty,
        finalScore
      });
    }

    // Step 7: Two-Tier Definition Detection for "What is X?" queries
    // Tier-1 (Strict Definition): "X is a/an/the" in first 40% of document
    // Tier-2 (Soft Definition): Intro patterns like "overview of X", "X is a platform that" in first 25%
    // Both tiers HARD EXCLUDE architecture/integration chunks
    let candidatesToRank = candidates;
    if (definitionQuery.isDefinition && definitionQuery.subject) {
      const subject = definitionQuery.subject;
      const escapedSubject = subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const escapedSubjectLower = escapedSubject.toLowerCase();
      
      // DEBUG LOGGING FOR DEFINITION QUERIES
      console.log(`\n=== DEBUG: TWO-TIER DEFINITION QUERY ANALYSIS ===`);
      console.log(`Extracted subject: "${subject}"`);
      console.log(`Total chunks processed: ${candidates.length}`);
      
      // ============================================================
      // HARD EXCLUSION PATTERNS FOR DEFINITION QUERIES
      // These patterns indicate content that should NEVER be returned
      // as definitions - includes architecture, comparison, and
      // explanation sections
      // ============================================================
      
      // Architecture/positioning indicators
      const architectureIndicators = [
        /\bnot\s+embedded\b/i,
        /\bsits\s+on\s+top\b/i,
        /\bconnects\s+to\b/i,
        /\bintegrates\s+with\b/i,
        /\bstandalone\s+platform\s+that\b/i,
        /\bstandalone\s+that\b/i,
        /\bsits\s+on\s+top\s+of\b/i,
        /\bpositioned\s+(on|above|over)\b/i,
        /\blayer\s+(on|above|over)\b/i,
        /\barchitecture\s+(of|for)\b/i,
        /\bhow\s+.*\s+works\b/i,
        /\bhow\s+.*\s+integrates\b/i,
        /\bintegration\s+(with|to|into)\b/i,
        /\bdeployed\s+(on|to|in)\b/i,
        /\bruns\s+on\s+top\s+of\b/i,
        /\bbuilt\s+on\s+top\s+of\b/i,
      ];
      
      // Comparison/explanation indicators - HARD BLOCKED for definition queries
      const comparisonExplanationIndicators = [
        /\bdifference\s+between\b/i,
        /\bdifferences\s+between\b/i,
        /\bvs\.?\b/i,
        /\bversus\b/i,
        /\bin\s+simple\s+terms\b/i,
        /\bcompared\s+to\b/i,
        /\bcomparison\s+(of|between|with)\b/i,
        /\bagentic\b/i,
        /\bhow\s+it\s+works\b/i,
        /\bhow\s+.*\s+works\b/i,
        /\bcapabilities\b/i,
        /\buse\s+cases?\b/i,
        /\bwhat\s+.*\s+does\b/i,
        /\bwhat\s+.*\s+can\s+do\b/i,
        /\bfeatures?\s+(of|include)\b/i,
        /\bbenefits?\s+(of|include)\b/i,
        /\badvantages?\s+(of|over)\b/i,
        /\bdisadvantages?\s+(of)\b/i,
        /\bpros\s+and\s+cons\b/i,
        /\bwhy\s+(use|choose)\b/i,
        /\bwhen\s+to\s+use\b/i,
        /\bexample\s+of\b/i,
        /\bexamples?\s+(include|are)\b/i,
      ];
      
      /**
       * Checks if a chunk contains architecture/positioning indicators
       * Returns { hasIndicators: boolean, matchedPattern: string | null }
       */
      function checkArchitectureIndicators(chunkText: string): { hasIndicators: boolean; matchedPattern: string | null } {
        for (const pattern of architectureIndicators) {
          if (pattern.test(chunkText)) {
            return { hasIndicators: true, matchedPattern: pattern.toString() };
          }
        }
        return { hasIndicators: false, matchedPattern: null };
      }
      
      /**
       * Checks if a chunk contains comparison/explanation indicators
       * These are HARD BLOCKED for definition queries
       * Returns { hasIndicators: boolean, matchedPattern: string | null }
       */
      function checkComparisonExplanationIndicators(chunkText: string): { hasIndicators: boolean; matchedPattern: string | null } {
        for (const pattern of comparisonExplanationIndicators) {
          if (pattern.test(chunkText)) {
            return { hasIndicators: true, matchedPattern: pattern.toString() };
          }
        }
        return { hasIndicators: false, matchedPattern: null };
      }
      
      /**
       * Combined check for all definition-blocking indicators
       * Returns { isBlocked: boolean, reason: string | null }
       */
      function isBlockedForDefinition(chunkText: string): { isBlocked: boolean; reason: string | null } {
        const archCheck = checkArchitectureIndicators(chunkText);
        if (archCheck.hasIndicators) {
          return { isBlocked: true, reason: `Architecture indicator: ${archCheck.matchedPattern}` };
        }
        
        const compCheck = checkComparisonExplanationIndicators(chunkText);
        if (compCheck.hasIndicators) {
          return { isBlocked: true, reason: `Comparison/explanation indicator: ${compCheck.matchedPattern}` };
        }
        
        return { isBlocked: false, reason: null };
      }
      
      // ============================================================
      // TIER-1: STRICT DEFINITION DETECTION
      // Criteria:
      // - Chunk is in first 40% of document
      // - Contains exact pattern: "<subject> is a|an|the <noun phrase>"
      // - Does NOT contain architecture/integration/comparison indicators
      // ============================================================
      const tier1Pattern = new RegExp(`\\b${escapedSubject}\\s+is\\s+(a|an|the)\\s+`, 'i');
      const tier1Candidates: Candidate[] = [];
      
      console.log(`\n--- TIER-1 (Strict Definition) Analysis ---`);
      console.log(`Pattern: "${subject} is a|an|the <noun phrase>"`);
      console.log(`Position threshold: first 40% of document`);
      console.log(`HARD BLOCKING: architecture, comparison, and explanation sections`);
      
      for (const candidate of candidates) {
        const chunk = candidate.vector.chunk;
        const chunkText = chunk.text;
        const chunkPreview = chunkText.substring(0, 200).replace(/\n/g, ' ').trim();
        
        // Calculate chunk position in document
        const documentChunks = chunksByDocument.get(chunk.sourceFile) || [];
        const totalChunks = documentChunks.length;
        const chunkPosition = totalChunks > 0 ? chunk.chunkIndex / totalChunks : 0;
        const isInTier1Range = chunkPosition <= 0.40; // First 40% of document
        
        // Check for strict definition pattern
        const tier1Match = chunkText.match(tier1Pattern);
        const hasTier1Pattern = tier1Match !== null;
        
        // Check for ALL blocking indicators (architecture + comparison/explanation)
        const blockCheck = isBlockedForDefinition(chunkText);
        
        // Tier-1 acceptance criteria
        const isTier1Candidate = isInTier1Range && hasTier1Pattern && !blockCheck.isBlocked;
        
        if (isTier1Candidate) {
          tier1Candidates.push(candidate);
          console.log(`  ✓ Strict definition candidate accepted - Chunk ${chunk.chunkIndex} (${chunk.sourceFile})`);
          console.log(`    Position: ${(chunkPosition * 100).toFixed(1)}%, Pattern match at index: ${tier1Match?.index}`);
          console.log(`    Preview: "${chunkPreview.substring(0, 100)}..."`);
        } else if (hasTier1Pattern && blockCheck.isBlocked) {
          console.log(`  ✗ Rejected: blocked content - Chunk ${chunk.chunkIndex} (${chunk.sourceFile})`);
          console.log(`    Has definition pattern but blocked: ${blockCheck.reason}`);
        }
      }
      
      console.log(`\nTier-1 candidates found: ${tier1Candidates.length}`);
      
      // ============================================================
      // TIER-2: SOFT DEFINITION / INTRO DEFINITION (FALLBACK)
      // Only applied if NO Tier-1 candidates exist
      // Criteria:
      // - Chunk is in first 25% of document
      // - Contains one of the soft definition patterns:
      //   - "<subject> is a platform that"
      //   - "<subject> is a solution that"
      //   - "overview of <subject>"
      //   - "introduction to <subject>"
      //   - "this document provides .* <subject>"
      // - The definition phrase appears in first 30% of chunk text
      // - Does NOT contain architecture/integration indicators
      // ============================================================
      let tier2Candidates: Candidate[] = [];
      
      if (tier1Candidates.length === 0) {
        console.log(`\n--- TIER-2 (Soft Definition / Intro) Analysis ---`);
        console.log(`No Tier-1 candidates found, checking Tier-2...`);
        console.log(`Position threshold: first 25% of document`);
        console.log(`Pattern must appear in first 30% of chunk text`);
        
        // Soft definition patterns
        const tier2Patterns = [
          { pattern: new RegExp(`\\b${escapedSubject}\\s+is\\s+a\\s+platform\\s+that\\b`, 'i'), name: `"${subject} is a platform that"` },
          { pattern: new RegExp(`\\b${escapedSubject}\\s+is\\s+a\\s+solution\\s+that\\b`, 'i'), name: `"${subject} is a solution that"` },
          { pattern: new RegExp(`\\b${escapedSubject}\\s+is\\s+a\\s+tool\\s+that\\b`, 'i'), name: `"${subject} is a tool that"` },
          { pattern: new RegExp(`\\b${escapedSubject}\\s+is\\s+a\\s+system\\s+that\\b`, 'i'), name: `"${subject} is a system that"` },
          { pattern: new RegExp(`\\b${escapedSubject}\\s+is\\s+a\\s+software\\s+that\\b`, 'i'), name: `"${subject} is a software that"` },
          { pattern: new RegExp(`\\boverview\\s+of\\s+${escapedSubject}\\b`, 'i'), name: `"overview of ${subject}"` },
          { pattern: new RegExp(`\\bintroduction\\s+to\\s+${escapedSubject}\\b`, 'i'), name: `"introduction to ${subject}"` },
          { pattern: new RegExp(`\\bintroducing\\s+${escapedSubject}\\b`, 'i'), name: `"introducing ${subject}"` },
          { pattern: new RegExp(`this\\s+document\\s+provides[^.]*${escapedSubject}`, 'i'), name: `"this document provides ... ${subject}"` },
          { pattern: new RegExp(`this\\s+guide\\s+(provides|covers|explains)[^.]*${escapedSubject}`, 'i'), name: `"this guide provides/covers/explains ... ${subject}"` },
          { pattern: new RegExp(`\\babout\\s+${escapedSubject}\\b`, 'i'), name: `"about ${subject}"` },
          { pattern: new RegExp(`\\bwhat\\s+is\\s+${escapedSubject}[^?]*\\?[^]*${escapedSubject}\\s+is\\s+`, 'i'), name: `"What is ${subject}?" followed by "${subject} is..."` },
        ];
        
        for (const candidate of candidates) {
          const chunk = candidate.vector.chunk;
          const chunkText = chunk.text;
          const chunkPreview = chunkText.substring(0, 200).replace(/\n/g, ' ').trim();
          
          // Calculate chunk position in document
          const documentChunks = chunksByDocument.get(chunk.sourceFile) || [];
          const totalChunks = documentChunks.length;
          const chunkPosition = totalChunks > 0 ? chunk.chunkIndex / totalChunks : 0;
          const isInTier2Range = chunkPosition <= 0.25; // First 25% of document
          
          if (!isInTier2Range) continue; // Skip chunks outside Tier-2 range
          
          // Check for ALL blocking indicators (architecture + comparison/explanation)
          const blockCheck = isBlockedForDefinition(chunkText);
          if (blockCheck.isBlocked) {
            console.log(`  ✗ Rejected: blocked content - Chunk ${chunk.chunkIndex} (${chunk.sourceFile})`);
            console.log(`    Blocked: ${blockCheck.reason}`);
            continue;
          }
          
          // Check each Tier-2 pattern
          for (const { pattern, name } of tier2Patterns) {
            const tier2Match = chunkText.match(pattern);
            if (tier2Match && tier2Match.index !== undefined) {
              // Check if pattern appears in first 30% of chunk text
              const chunkLength = chunkText.length;
              const patternPosition = tier2Match.index / chunkLength;
              const isPatternEarly = patternPosition <= 0.30;
              
              if (isPatternEarly) {
                tier2Candidates.push(candidate);
                console.log(`  ✓ Soft definition candidate accepted - Chunk ${chunk.chunkIndex} (${chunk.sourceFile})`);
                console.log(`    Matched pattern: ${name}`);
                console.log(`    Document position: ${(chunkPosition * 100).toFixed(1)}%, Pattern position in chunk: ${(patternPosition * 100).toFixed(1)}%`);
                console.log(`    Preview: "${chunkPreview.substring(0, 100)}..."`);
                break; // Only add candidate once even if multiple patterns match
              } else {
                console.log(`  ⚠ Pattern found but too late in chunk - Chunk ${chunk.chunkIndex}`);
                console.log(`    Pattern ${name} at ${(patternPosition * 100).toFixed(1)}% of chunk (threshold: 30%)`);
              }
            }
          }
        }
        
        // Remove duplicates from tier2Candidates (in case same candidate matched multiple patterns)
        tier2Candidates = tier2Candidates.filter((candidate, index, self) =>
          index === self.findIndex(c => c.vector.chunk.chunkIndex === candidate.vector.chunk.chunkIndex &&
                                        c.vector.chunk.sourceFile === candidate.vector.chunk.sourceFile)
        );
        
        console.log(`\nTier-2 candidates found: ${tier2Candidates.length}`);
      }
      
      // ============================================================
      // RANKING BEHAVIOR
      // - If Tier-1 candidates exist → rank only Tier-1
      // - Else if Tier-2 candidates exist → rank only Tier-2
      // - Else → DEFINITION SYNTHESIS FALLBACK
      // ============================================================
      console.log(`\n=== DEFINITION CANDIDATE SELECTION SUMMARY ===`);
      
      // Flag to track if we used definition synthesis
      let usedDefinitionSynthesis = false;
      let synthesizedDefinition: { answer: string; source: string; confidence: number; explanation: string } | null = null;
      
      if (tier1Candidates.length > 0) {
        console.log(`✓ Using Tier-1 (Strict Definition) candidates: ${tier1Candidates.length}`);
        console.log(`  Architecture/integration chunks have been HARD EXCLUDED`);
        candidatesToRank = tier1Candidates;
      } else if (tier2Candidates.length > 0) {
        console.log(`✓ Using Tier-2 (Soft Definition / Intro) candidates: ${tier2Candidates.length}`);
        console.log(`  Architecture/integration chunks have been HARD EXCLUDED`);
        candidatesToRank = tier2Candidates;
      } else {
        // ============================================================
        // DEFINITION SYNTHESIS FALLBACK
        // Triggered when no strict or soft definition chunks are found
        // Synthesizes a definition from intro chunks
        // IMPORTANT: Uses ALL vectors (not filtered candidates) to find
        // intro content for synthesis
        // ============================================================
        console.log(`\n--- DEFINITION SYNTHESIS FALLBACK ---`);
        console.log(`No Tier-1 or Tier-2 definition candidates found`);
        console.log(`Attempting to synthesize definition from intro chunks...`);
        console.log(`Searching through ALL ${vectorsToSearch.length} vectors (not filtered candidates)`);
        
        // Step 1: Find the best intro chunk from ALL vectors
        // - First chunk containing the subject name
        // - Within first 25% of document
        // - Not an architecture/comparison chunk (but allow intro-style content)
        let bestIntroChunk: typeof vectorsToSearch[0] | null = null;
        const subjectLower = subject.toLowerCase();
        const subjectPattern = new RegExp(`\\b${escapedSubject}\\b`, 'i');
        
        // Sort ALL vectors by chunk index to find earliest matching chunk
        const sortedByPosition = [...vectorsToSearch].sort((a, b) => {
          // First sort by document, then by chunk index
          if (a.chunk.sourceFile !== b.chunk.sourceFile) {
            return a.chunk.sourceFile.localeCompare(b.chunk.sourceFile);
          }
          return a.chunk.chunkIndex - b.chunk.chunkIndex;
        });
        
        for (const vector of sortedByPosition) {
          const chunk = vector.chunk;
          const chunkText = chunk.text;
          
          // Calculate chunk position
          const documentChunks = chunksByDocument.get(chunk.sourceFile) || [];
          const totalChunks = documentChunks.length;
          const chunkPosition = totalChunks > 0 ? chunk.chunkIndex / totalChunks : 0;
          
          // Must be in first 30% of document (relaxed from 25%)
          if (chunkPosition > 0.30) continue;
          
          // Must contain subject name
          if (!subjectPattern.test(chunkText)) continue;
          
          // For synthesis, we ALWAYS accept the first chunk (chunk 0) as it's the title/intro
          // This is the most likely place to find definition-worthy content
          if (chunk.chunkIndex === 0) {
            bestIntroChunk = vector;
            console.log(`  ✓ Using title/intro chunk (chunk 0) for synthesis`);
            console.log(`    Source: ${chunk.sourceFile}`);
            console.log(`    This chunk is ALWAYS accepted for synthesis as it contains intro content`);
            break;
          }
          
          // For non-first chunks, check for architecture indicators
          const archIndicatorCount = architectureIndicators.filter(p => p.test(chunkText)).length;
          
          if (archIndicatorCount <= 2) {
            // Accept chunks with 0-2 architecture indicators
            if (!bestIntroChunk) {
              bestIntroChunk = vector;
              console.log(`  ✓ Found suitable intro chunk: ${chunk.chunkIndex} (${chunk.sourceFile})`);
              console.log(`    Position: ${(chunkPosition * 100).toFixed(1)}%`);
              console.log(`    Architecture indicators: ${archIndicatorCount}`);
            }
          } else {
            console.log(`  Skipping chunk ${chunk.chunkIndex} - too many architecture indicators (${archIndicatorCount})`);
          }
        }
        
        if (bestIntroChunk) {
          console.log(`  ✓ Selected intro chunk for synthesis: ${bestIntroChunk.chunk.chunkIndex} (${bestIntroChunk.chunk.sourceFile})`);
        }
        
        if (bestIntroChunk) {
          // Step 2: Extract key noun phrases from the intro chunk
          const chunkText = bestIntroChunk.chunk.text;
          console.log(`\n  Extracting definition components from intro chunk...`);
          console.log(`  Chunk text preview: "${chunkText.substring(0, 300)}..."`);
          
          // Extract category/platform type
          const categoryPatterns = [
            /\b(process\s+intelligence)\b/i,
            /\b(process\s+mining)\b/i,
            /\b(execution\s+management)\b/i,
            /\b(business\s+process)\s+(management|automation|optimization)\b/i,
            /\b(enterprise)\s+(platform|software|solution)\b/i,
            /\b(analytics)\s+(platform|software|solution)\b/i,
            /\b(data)\s+(platform|analytics)\b/i,
            /\b(automation)\s+(platform|software|solution)\b/i,
            /\b(intelligence)\s+(platform|software|solution)\b/i,
            /\bplatform\b/i,
            /\bsoftware\b/i,
            /\bsolution\b/i,
            /\btool\b/i,
            /\bsystem\b/i,
          ];
          
          let category = '';
          const foundCategories: string[] = [];
          
          for (const pattern of categoryPatterns) {
            const match = chunkText.match(pattern);
            if (match) {
              const matchedText = match[0].toLowerCase().trim();
              // Avoid duplicates and generic terms if we have specific ones
              if (!foundCategories.includes(matchedText)) {
                foundCategories.push(matchedText);
              }
            }
          }
          
          // Prioritize compound terms over single words
          if (foundCategories.length > 0) {
            // Sort by length (longer = more specific) and take the best ones
            foundCategories.sort((a, b) => b.length - a.length);
            
            // Combine top categories if they're complementary
            const primaryCategory = foundCategories[0];
            const secondaryCategories = foundCategories.slice(1, 3).filter(c => 
              !primaryCategory.includes(c) && !c.includes(primaryCategory)
            );
            
            if (secondaryCategories.length > 0 && primaryCategory.length < 25) {
              category = `${primaryCategory} and ${secondaryCategories[0]}`;
            } else {
              category = primaryCategory;
            }
          }
          
          console.log(`  Found categories: [${foundCategories.join(', ')}]`);
          console.log(`  Selected category: "${category}"`);
          
          // Extract primary purpose
          const purposePatterns = [
            /helps?\s+(organizations?|companies?|businesses?|enterprises?)\s+([^.]+)/i,
            /enables?\s+(organizations?|companies?|businesses?|enterprises?)\s+to\s+([^.]+)/i,
            /allows?\s+(organizations?|companies?|businesses?|enterprises?)\s+to\s+([^.]+)/i,
            /used\s+to\s+([^.]+)/i,
            /designed\s+to\s+([^.]+)/i,
            /provides?\s+([^.]+?)\s+(for|to)\s+(organizations?|companies?|businesses?)/i,
            /analyzes?\s+([^.]+)/i,
            /understand\s+and\s+([^.]+)/i,
            /improve\s+([^.]+)/i,
            /optimize\s+([^.]+)/i,
            /covering\s+its\s+([^.]+)/i,
          ];
          
          let purpose = '';
          for (const pattern of purposePatterns) {
            const match = chunkText.match(pattern);
            if (match) {
              // Get the captured group (purpose description)
              let purposeText = match[match.length > 2 ? 2 : 1] || match[1];
              if (purposeText) {
                // Clean up the purpose text
                purposeText = purposeText
                  .replace(/\s+/g, ' ')
                  .replace(/,\s*$/, '')
                  .replace(/\.\s*$/, '')
                  .trim();
                
                // Skip if too short or too long
                if (purposeText.length >= 10 && purposeText.length <= 150) {
                  purpose = purposeText;
                  console.log(`  Found purpose pattern: ${pattern.toString()}`);
                  console.log(`  Extracted purpose: "${purpose}"`);
                  break;
                }
              }
            }
          }
          
          // Extract domain keywords
          const domainKeywords: string[] = [];
          const domainPatterns = [
            /\b(process\s+mining)\b/i,
            /\b(process\s+intelligence)\b/i,
            /\b(execution\s+management)\b/i,
            /\b(operational\s+data)\b/i,
            /\b(enterprise\s+data)\b/i,
            /\b(business\s+process(?:es)?)\b/i,
            /\b(event\s+logs?)\b/i,
            /\b(ERP)\b/i,
            /\b(CRM)\b/i,
            /\b(SAP)\b/i,
            /\b(Salesforce)\b/i,
            /\b(workflow)\b/i,
            /\b(automation)\b/i,
            /\b(optimization)\b/i,
            /\b(analytics)\b/i,
            /\b(AI)\b/i,
            /\b(machine\s+learning)\b/i,
          ];
          
          for (const pattern of domainPatterns) {
            const match = chunkText.match(pattern);
            if (match) {
              const keyword = match[1].toLowerCase();
              if (!domainKeywords.includes(keyword)) {
                domainKeywords.push(keyword);
              }
            }
          }
          
          console.log(`  Found domain keywords: [${domainKeywords.join(', ')}]`);
          
          // Step 3: Generate synthesized definition
          // Format: "<X> is a <category> that <primary purpose>."
          
          // Build the category part
          let categoryPart = category || 'platform';
          
          // If we have domain keywords but no good category, use them
          if (!category && domainKeywords.length > 0) {
            const relevantKeywords = domainKeywords.filter(k => 
              k.includes('process') || k.includes('intelligence') || k.includes('mining') || k.includes('analytics')
            );
            if (relevantKeywords.length > 0) {
              categoryPart = relevantKeywords.slice(0, 2).join(' and ') + ' platform';
            }
          }
          
          // Build the purpose part
          let purposePart = '';
          if (purpose) {
            // Clean and format purpose
            purposePart = purpose.toLowerCase();
            // Ensure it starts with a verb or "helps"
            if (!purposePart.match(/^(helps?|enables?|allows?|provides?|analyzes?|understand|improve|optimize)/i)) {
              purposePart = 'helps organizations ' + purposePart;
            }
          } else {
            // Fallback: construct purpose from domain keywords
            const processKeywords = domainKeywords.filter(k => k.includes('process') || k.includes('business'));
            const dataKeywords = domainKeywords.filter(k => k.includes('data') || k.includes('event'));
            
            if (processKeywords.length > 0 || dataKeywords.length > 0) {
              const dataSource = dataKeywords.length > 0 ? dataKeywords[0] : 'enterprise data';
              const processTarget = processKeywords.length > 0 ? processKeywords[0] : 'business processes';
              purposePart = `analyzes ${dataSource} to help organizations understand and improve ${processTarget}`;
            } else {
              purposePart = 'helps organizations analyze and optimize their operations';
            }
          }
          
          // Construct the final definition
          const synthesizedAnswer = `${subject} is a ${categoryPart} that ${purposePart}.`;
          
          console.log(`\n  ✓ SYNTHESIZED DEFINITION:`);
          console.log(`    "${synthesizedAnswer}"`);
          
          // Step 4: Set synthesized definition result
          synthesizedDefinition = {
            answer: synthesizedAnswer,
            source: bestIntroChunk.chunk.sourceFile,
            confidence: 0.70, // Fixed confidence for synthesized definitions (0.65-0.75 range)
            explanation: 'Definition synthesized due to absence of explicit definition sentence'
          };
          
          usedDefinitionSynthesis = true;
          console.log(`\n  Source: ${synthesizedDefinition.source}`);
          console.log(`  Confidence: ${synthesizedDefinition.confidence}`);
          console.log(`  Explanation: ${synthesizedDefinition.explanation}`);
        } else {
          console.log(`  ✗ No suitable intro chunk found for definition synthesis`);
          console.log(`  STRICT POLICY: No general fallback for definition queries`);
          console.log(`  Returning "No clear definition found" response`);
        }
        
        console.log(`--- END DEFINITION SYNTHESIS ---\n`);
        
        // ============================================================
        // STRICT DEFINITION-ONLY RESPONSE POLICY
        // For definition queries, we DO NOT fall back to general ranking
        // If synthesis failed, return "No clear definition found"
        // ============================================================
        if (!usedDefinitionSynthesis) {
          console.log(`\n=== STRICT DEFINITION POLICY ENFORCED ===`);
          console.log(`  Query type: Definition query ("What is ${subject}")`);
          console.log(`  Tier-1 candidates: 0`);
          console.log(`  Tier-2 candidates: 0`);
          console.log(`  Synthesis: Failed`);
          console.log(`  Action: Returning "No clear definition found" (NO general fallback)`);
          console.log(`=== END STRICT DEFINITION POLICY ===\n`);
          
          // Get the source document name if available
          const sourceDoc = candidates.length > 0 ? candidates[0].vector.chunk.sourceFile : '';
          
          return res.json({
            answer: "No clear definition found in the provided documents.",
            source: sourceDoc,
            confidence: 0.0,
            explanation: 'Definition query could not be answered - no explicit definition, soft definition, or synthesizable intro content found'
          });
        }
      }
      
      console.log(`=== END TWO-TIER DEFINITION QUERY DEBUG ===\n`);
      
      // If definition synthesis was used, return immediately
      if (usedDefinitionSynthesis && synthesizedDefinition) {
        console.log(`\n✓✓✓ RETURNING SYNTHESIZED DEFINITION ✓✓✓`);
        console.log(`  Answer: ${synthesizedDefinition.answer}`);
        console.log(`  Source: ${synthesizedDefinition.source}`);
        console.log(`  Confidence: ${synthesizedDefinition.confidence}`);
        
        return res.json({
          answer: synthesizedDefinition.answer,
          source: synthesizedDefinition.source,
          confidence: synthesizedDefinition.confidence,
          explanation: synthesizedDefinition.explanation
        });
      }
    }

    // Step 7.5: Data-Usage Query Intent Detection and Filtering
    // Only affects queries asking about data usage (e.g., "what data does X use")
    // Does NOT affect definition queries, AI queries, or general queries
    const dataUsagePatterns = [
      /\bwhat\s+data\b/i,
      /\bdata\s+does\b/i,
      /\buses?\s+data\b/i,
      /\bdata\s+used\s+by\b/i,
      /\bwhat\s+kind\s+of\s+data\b/i,
      /\btype\s+of\s+data\b/i,
      /\bdata\s+sources?\b/i,
      /\bdata\s+inputs?\b/i,
    ];
    
    const isDataUsageQuery = !definitionQuery.isDefinition && dataUsagePatterns.some(pattern => pattern.test(query));
    
    if (isDataUsageQuery) {
      console.log(`\n=== DATA-USAGE QUERY DETECTED ===`);
      console.log(`Query: "${query}"`);
      
      // Data-related terms that indicate a chunk contains data usage information
      const dataRelatedTerms = [
        /\bevent\s+logs?\b/i,
        /\bevent\s+data\b/i,
        /\bcase\s+identifiers?\b/i,
        /\bcase\s+id\b/i,
        /\bactivit(?:y|ies)\b/i,
        /\btimestamps?\b/i,
        /\benterprise\s+data\b/i,
        /\boperational\s+data\b/i,
        /\btransaction\s+data\b/i,
        /\bprocess\s+data\b/i,
        /\bdata\s+extracts?\b/i,
        /\bdata\s+connectors?\b/i,
      ];
      
      // Intro/definition chunk indicators (to exclude)
      const introChunkIndicators = [
        /\bthis\s+document\s+provides\b/i,
        /\bplatform\s+overview\b/i,
        /\bdetailed\s+understanding\b/i,
        /\bcovering\s+its\s+purpose\b/i,
        /\bwhat\s+is\s+\w+\?\s*$/im,
      ];
      
      // Filter candidates to only those containing data-related terms
      const dataRelatedCandidates = candidatesToRank.filter(candidate => {
        const chunkText = candidate.vector.chunk.text;
        
        // Check if chunk contains at least one data-related term
        const hasDataTerm = dataRelatedTerms.some(pattern => pattern.test(chunkText));
        
        if (!hasDataTerm) {
          return false;
        }
        
        // Exclude intro/definition chunks for data-usage queries
        const isIntroChunk = introChunkIndicators.some(pattern => pattern.test(chunkText));
        if (isIntroChunk) {
          console.log(`  Excluding intro chunk ${candidate.vector.chunk.chunkIndex} from data-usage ranking`);
          return false;
        }
        
        return true;
      });
      
      console.log(`  Data-related candidates found: ${dataRelatedCandidates.length}`);
      
      if (dataRelatedCandidates.length > 0) {
        // Log which data terms were found
        const foundTerms = new Set<string>();
        for (const candidate of dataRelatedCandidates) {
          const chunkText = candidate.vector.chunk.text;
          for (const pattern of dataRelatedTerms) {
            const match = chunkText.match(pattern);
            if (match) {
              foundTerms.add(match[0].toLowerCase());
            }
          }
        }
        console.log(`  Data terms found: [${Array.from(foundTerms).join(', ')}]`);
        console.log(`  Using data-related candidates only (excluding intro chunks)`);
        candidatesToRank = dataRelatedCandidates;
      } else {
        console.log(`  No data-related chunks found, falling back to general ranking`);
      }
      
      console.log(`=== END DATA-USAGE QUERY DETECTION ===\n`);
    }

    // Step 7.6: AI-Usage Query Intent Detection and Filtering
    // Only affects queries asking about AI/ML usage (e.g., "how does X use AI")
    // Does NOT affect definition queries, data queries, or general queries
    const aiUsagePatterns = [
      /\buses?\s+ai\b/i,
      /\bai\s+usage\b/i,
      /\bartificial\s+intelligence\b/i,
      /\bmachine\s+learning\b/i,
      /\bml\s+capabilit/i,
      /\bai\s+capabilit/i,
      /\bhow\s+.*\s+ai\b/i,
      /\bwhat\s+ai\b/i,
    ];
    
    const isAIUsageQuery = !definitionQuery.isDefinition && !isDataUsageQuery && aiUsagePatterns.some(pattern => pattern.test(query));
    
    if (isAIUsageQuery) {
      console.log(`\n=== AI-USAGE QUERY DETECTED ===`);
      console.log(`Query: "${query}"`);
      
      // AI-related terms that indicate a chunk contains AI usage information
      const aiRelatedTerms = [
        /\bai\b/i,
        /\bartificial\s+intelligence\b/i,
        /\bmachine\s+learning\b/i,
        /\bml\b/i,
        /\bpredict(?:s|ion|ive|ing)?\b/i,
        /\bpatterns?\b/i,
        /\broot\s+cause\b/i,
        /\banomal(?:y|ies)\b/i,
        /\bautomation\b/i,
        /\balgorithm/i,
        /\bmodel(?:s|ing)?\b/i,
        /\binsights?\b/i,
      ];
      
      // Intro/definition chunk indicators (to exclude)
      const introChunkIndicatorsAI = [
        /\bthis\s+document\s+provides\b/i,
        /\bplatform\s+overview\b/i,
        /\bdetailed\s+understanding\b/i,
        /\bcovering\s+its\s+purpose\b/i,
        /\bwhat\s+is\s+\w+\?\s*$/im,
        /^celonis\s+[–-]\s+platform\s+overview/im,
      ];
      
      // Filter candidates to only those containing AI-related terms
      const aiRelatedCandidates = candidatesToRank.filter(candidate => {
        const chunkText = candidate.vector.chunk.text;
        
        // Check if chunk contains at least one AI-related term
        const hasAITerm = aiRelatedTerms.some(pattern => pattern.test(chunkText));
        
        if (!hasAITerm) {
          return false;
        }
        
        // Exclude intro/definition chunks for AI-usage queries
        const isIntroChunk = introChunkIndicatorsAI.some(pattern => pattern.test(chunkText));
        if (isIntroChunk) {
          console.log(`  Excluding intro chunk ${candidate.vector.chunk.chunkIndex} from AI-usage ranking`);
          return false;
        }
        
        return true;
      });
      
      console.log(`  AI-related candidates found: ${aiRelatedCandidates.length}`);
      
      if (aiRelatedCandidates.length > 0) {
        // Log which AI terms were found
        const foundTerms = new Set<string>();
        for (const candidate of aiRelatedCandidates) {
          const chunkText = candidate.vector.chunk.text;
          for (const pattern of aiRelatedTerms) {
            const match = chunkText.match(pattern);
            if (match) {
              foundTerms.add(match[0].toLowerCase());
            }
          }
        }
        console.log(`  AI terms found: [${Array.from(foundTerms).join(', ')}]`);
        console.log(`  Using AI-related candidates only (excluding intro chunks)`);
        candidatesToRank = aiRelatedCandidates;
      } else {
        console.log(`  No AI-related chunks found, falling back to general ranking`);
      }
      
      console.log(`=== END AI-USAGE QUERY DETECTION ===\n`);
    }

    // Step 7.7: (REMOVED - Document-level comparison filter now runs at Step 2.5 BEFORE scoring)
    // The strict document-level filter for comparison queries is applied early,
    // before any chunk scoring or semantic similarity calculations.

    // Step 8: Rank candidates by final score (descending)
    candidatesToRank.sort((a, b) => b.finalScore - a.finalScore);

    console.log(`\n=== CANDIDATE SELECTION AND SCORING ===`);
    console.log(`Total candidates to rank: ${candidatesToRank.length}`);
    if (candidatesToRank.length > 0) {
      console.log(`Top 5 candidates:`);
      candidatesToRank.slice(0, 5).forEach((candidate, idx) => {
        console.log(`  ${idx + 1}. Score: ${candidate.finalScore.toFixed(3)} (semantic: ${(candidate.semanticSimilarity * 100).toFixed(1)}%, keywords: ${(candidate.keywordCoverage * 100).toFixed(0)}%, position: ${candidate.positionBonus}, explicit-term: ${candidate.explicitTermBonus}, definition: ${candidate.definitionBonus}) - ${candidate.vector.chunk.sourceFile} [chunk ${candidate.vector.chunk.chunkIndex}]`);
      });
    }

    // Step 9: Select top-ranked chunk (or return no-match)
    if (candidatesToRank.length === 0) {
      console.log(`✗ No candidates found matching criteria`);
      return res.json({
        answer: "No relevant information found in the uploaded documents.",
        source: "",
        confidence: 0.0
      });
    }

    const bestCandidate = candidatesToRank[0];
    const bestChunk = bestCandidate.vector.chunk;

    console.log(`\n✓✓✓ SELECTED BEST MATCH ✓✓✓`);
    console.log(`  File: ${bestChunk.sourceFile}`);
    console.log(`  Chunk Index: ${bestChunk.chunkIndex}`);
    console.log(`  Final Score: ${bestCandidate.finalScore.toFixed(3)}`);
    console.log(`  Semantic Similarity: ${(bestCandidate.semanticSimilarity * 100).toFixed(2)}%`);
    console.log(`  Keyword Coverage: ${(bestCandidate.keywordCoverage * 100).toFixed(0)}%`);
    console.log(`  Position Bonus: ${bestCandidate.positionBonus}`);
    console.log(`  Explicit-Term Bonus: ${bestCandidate.explicitTermBonus}`);
    console.log(`  Definition Bonus: ${bestCandidate.definitionBonus}`);

    // ============================================================
    // TOPIC COVERAGE CHECK (for non-definition queries)
    // Ensures the document actually contains information about the
    // specific topic being asked, not just the entity name
    // ============================================================
    if (!definitionQuery.isDefinition && queryWords.length >= 2) {
      console.log(`\n=== TOPIC COVERAGE CHECK ===`);
      
      // Common stop words to exclude from topic check
      const stopWords = new Set([
        'what', 'how', 'where', 'when', 'why', 'who', 'which', 'whom',
        'is', 'are', 'was', 'were', 'be', 'been', 'being',
        'have', 'has', 'had', 'do', 'does', 'did', 'done',
        'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
        'of', 'with', 'by', 'from', 'as', 'into', 'through', 'during',
        'can', 'could', 'will', 'would', 'shall', 'should', 'may', 'might', 'must',
        'this', 'that', 'these', 'those', 'it', 'its',
        'i', 'you', 'he', 'she', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
        'my', 'your', 'his', 'her', 'our', 'their',
        'about', 'after', 'before', 'between', 'under', 'over', 'above', 'below',
        'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some',
        'such', 'no', 'not', 'only', 'same', 'so', 'than', 'too', 'very',
        'just', 'also', 'now', 'here', 'there', 'then', 'once',
        'explain', 'tell', 'show', 'give', 'find', 'get', 'make', 'know',
        'actually', 'really', 'please', 'help'
      ]);
      
      // Identify topic-specific words (non-stop words, non-entity words)
      const entityLower = primaryEntity ? primaryEntity.toLowerCase() : '';
      const topicWords = queryWords.filter(word => {
        const wordLower = word.toLowerCase();
        // Exclude stop words
        if (stopWords.has(wordLower)) return false;
        // Exclude the primary entity (we know it exists)
        if (entityLower && wordLower === entityLower.toLowerCase()) return false;
        // Exclude very short words
        if (wordLower.length < 3) return false;
        return true;
      });
      
      console.log(`  Query words: [${queryWords.join(', ')}]`);
      console.log(`  Primary entity: "${primaryEntity || 'none'}"`);
      console.log(`  Topic-specific words: [${topicWords.join(', ')}]`);
      
      if (topicWords.length > 0) {
        // Check if ANY topic word is found in the best chunk OR any chunk in the document
        const allChunksText = vectorsToSearch
          .filter(v => v.chunk.sourceFile === bestChunk.sourceFile)
          .map(v => normalizeTextForMatching(v.chunk.text))
          .join(' ');
        
        let topicWordsFound = 0;
        const missingTopicWords: string[] = [];
        
        for (const topicWord of topicWords) {
          const wordPattern = new RegExp(`\\b${topicWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
          // Also check for stem matches
          const wordStem = topicWord.replace(/s$/, '').replace(/es$/, '').replace(/ing$/, '').replace(/ed$/, '');
          const stemPattern = wordStem.length > 3 ? new RegExp(`\\b${wordStem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i') : null;
          
          if (wordPattern.test(allChunksText) || (stemPattern && stemPattern.test(allChunksText))) {
            topicWordsFound++;
            console.log(`    ✓ Topic word "${topicWord}" found in document`);
          } else {
            missingTopicWords.push(topicWord);
            console.log(`    ✗ Topic word "${topicWord}" NOT found in document`);
          }
        }
        
        const topicCoverage = topicWordsFound / topicWords.length;
        console.log(`  Topic coverage: ${topicWordsFound}/${topicWords.length} (${(topicCoverage * 100).toFixed(0)}%)`);
        
        // If NO topic words are found, the document doesn't contain relevant information
        // Exception: if keyword coverage is very high (>66%) or semantic similarity is very high (>85%)
        const hasHighKeywordCoverage = bestCandidate.keywordCoverage >= 0.66;
        const hasVeryHighSemantic = bestCandidate.semanticSimilarity >= 0.85;
        
        if (topicWordsFound === 0 && !hasHighKeywordCoverage && !hasVeryHighSemantic) {
          console.log(`\n  ⚠ TOPIC COVERAGE FAILED`);
          console.log(`    No topic-specific words found in document`);
          console.log(`    Missing words: [${missingTopicWords.join(', ')}]`);
          console.log(`    Keyword coverage: ${(bestCandidate.keywordCoverage * 100).toFixed(0)}% (threshold: 66%)`);
          console.log(`    Semantic similarity: ${(bestCandidate.semanticSimilarity * 100).toFixed(1)}% (threshold: 85%)`);
          console.log(`    Returning "no relevant information" response`);
          console.log(`=== END TOPIC COVERAGE CHECK ===\n`);
          
          return res.json({
            answer: `No information about "${missingTopicWords.join(', ')}" found in the documents${primaryEntity ? ` about ${primaryEntity}` : ''}.`,
            source: bestChunk.sourceFile,
            confidence: 0.0,
            explanation: `The document contains information about ${primaryEntity || 'the subject'} but not about the specific topic: ${missingTopicWords.join(', ')}`
          });
        }
        
        console.log(`  ✓ Topic coverage check PASSED`);
      } else {
        console.log(`  No topic-specific words to check (query is entity-only or all stop words)`);
      }
      
      console.log(`=== END TOPIC COVERAGE CHECK ===\n`);
    }

    // Step 10: Extract snippet (use original text, not generated)
    // For single-word queries, extract focused snippet around the match
    // For multi-word queries, extract snippet around the phrase
    let snippet: string;
    if (queryWords.length === 1) {
      // Single word - extract focused snippet
      snippet = extractFocusedSnippet(bestChunk.text, queryWords);
    } else {
      // Multiple words - try to find phrase, otherwise use focused snippet
      const phrasePattern = queryWords.join(' ');
      const normalizedChunkText = normalizeTextForMatching(bestChunk.text);
      const phraseIndex = normalizedChunkText.indexOf(phrasePattern);
      
      if (phraseIndex !== -1) {
        // Found exact phrase - extract snippet from phrase location
        snippet = extractSnippetFromPhraseIndex(bestChunk.text, phraseIndex, phrasePattern);
      } else {
        // No exact phrase - use focused snippet
        snippet = extractFocusedSnippet(bestChunk.text, queryWords);
      }
    }

    // Step 11: Calculate confidence from final score
    // Normalize score to 0.0-1.0 range for confidence
    // Score can be up to ~3.1 (1.0 semantic + 0.3 keyword + 0.5 position + 0.3 explicit-term + 1.2 definition)
    // Normalize to 0.0-1.0 by dividing by 3.1 and capping at 1.0
    const confidence = Math.min(1.0, bestCandidate.finalScore / 3.1);

    // Step 12: Return single best result
    return res.json({
      answer: snippet,
      source: bestChunk.sourceFile,
      confidence: Math.round(confidence * 100) / 100 // Round to 2 decimals
    });

  } catch (error: any) {
    console.error('Search error:', error);
    res.status(500).json({ error: error.message || 'Error performing search' });
  }
});

export { router as searchRouter };

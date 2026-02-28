/**
 * Semantic Search Service for Oceangram
 * Provides TF-IDF based semantic search across chat messages
 * 
 * TASK-035: No external APIs or heavy dependencies - simple local TF-IDF implementation
 */

import * as vscode from 'vscode';
import { MessageInfo } from './telegram';

interface SearchDocument {
  id: string;           // messageId or unique identifier
  dialogId: string;     // chat ID 
  text: string;         // message text content
  timestamp: number;    // message timestamp
  senderName?: string;  // sender name for context
}

interface TFIDFVector {
  [term: string]: number;
}

interface DocumentVector {
  documentId: string;
  vector: TFIDFVector;
}

interface SearchIndex {
  documents: SearchDocument[];
  termFrequency: Map<string, Map<string, number>>; // term -> docId -> frequency
  documentFrequency: Map<string, number>; // term -> number of docs containing it
  totalDocuments: number;
  lastUpdated: number;
  version: string;
}

interface SearchResult {
  document: SearchDocument;
  score: number;
  matchedTerms: string[];
}

export class SemanticSearchService {
  private static readonly STORAGE_KEY = 'oceangram.semanticSearch.index';
  private static readonly INDEX_VERSION = '1.0.0';
  private static readonly MIN_TERM_LENGTH = 3;
  private static readonly MAX_RESULTS = 50;
  
  private context: vscode.ExtensionContext;
  private index: SearchIndex | null = null;
  
  // Common stop words to filter out
  private static readonly STOP_WORDS = new Set([
    'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by',
    'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
    'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must',
    'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they',
    'me', 'him', 'her', 'us', 'them', 'my', 'your', 'his', 'its', 'our', 'their'
  ]);
  
  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }
  
  /**
   * Load existing search index from storage
   */
  private async loadIndex(): Promise<void> {
    try {
      const stored = await this.context.globalState.get<SearchIndex>(SemanticSearchService.STORAGE_KEY);
      if (stored && stored.version === SemanticSearchService.INDEX_VERSION) {
        // Convert Maps back from plain objects (JSON doesn't preserve Map structure)
        this.index = {
          ...stored,
          termFrequency: new Map(Object.entries(stored.termFrequency as any).map(([term, docMap]) => 
            [term, new Map(Object.entries(docMap))])),
          documentFrequency: new Map(Object.entries(stored.documentFrequency as any))
        };
      } else {
        this.index = this.createEmptyIndex();
      }
    } catch (error) {
      console.warn('[SemanticSearch] Failed to load index:', error);
      this.index = this.createEmptyIndex();
    }
  }
  
  /**
   * Save search index to storage
   */
  private async saveIndex(): Promise<void> {
    if (!this.index) return;
    
    try {
      // Convert Maps to plain objects for JSON storage
      const toSave: any = {
        ...this.index,
        termFrequency: Object.fromEntries(
          Array.from(this.index.termFrequency.entries()).map(([term, docMap]) => 
            [term, Object.fromEntries(docMap)])),
        documentFrequency: Object.fromEntries(this.index.documentFrequency)
      };
      
      await this.context.globalState.update(SemanticSearchService.STORAGE_KEY, toSave);
    } catch (error) {
      console.warn('[SemanticSearch] Failed to save index:', error);
    }
  }
  
  /**
   * Create empty search index
   */
  private createEmptyIndex(): SearchIndex {
    return {
      documents: [],
      termFrequency: new Map(),
      documentFrequency: new Map(),
      totalDocuments: 0,
      lastUpdated: Date.now(),
      version: SemanticSearchService.INDEX_VERSION
    };
  }
  
  /**
   * Tokenize and normalize text for indexing
   */
  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ') // Replace punctuation with spaces
      .split(/\s+/)
      .filter(term => 
        term.length >= SemanticSearchService.MIN_TERM_LENGTH && 
        !SemanticSearchService.STOP_WORDS.has(term) &&
        !term.match(/^\d+$/) // Filter out pure numbers
      );
  }
  
  /**
   * Add documents to the search index
   */
  async indexMessages(messages: MessageInfo[], dialogId: string): Promise<void> {
    if (!this.index) {
      await this.loadIndex();
    }
    
    if (!this.index) return;
    
    const newDocuments: SearchDocument[] = [];
    
    for (const msg of messages) {
      // Skip messages without meaningful text content
      if (!msg.text || msg.text.trim().length < 10) continue;
      
      const document: SearchDocument = {
        id: `${dialogId}:${msg.id}`,
        dialogId,
        text: msg.text,
        timestamp: msg.timestamp,
        senderName: msg.senderName
      };
      
      // Check if document already exists
      const existingIndex = this.index.documents.findIndex(d => d.id === document.id);
      if (existingIndex !== -1) {
        // Update existing document
        this.index.documents[existingIndex] = document;
        this.reindexDocument(document);
      } else {
        // Add new document
        newDocuments.push(document);
        this.index.documents.push(document);
        this.indexDocument(document);
      }
    }
    
    this.index.totalDocuments = this.index.documents.length;
    this.index.lastUpdated = Date.now();
    
    if (newDocuments.length > 0) {
      console.log(`[SemanticSearch] Indexed ${newDocuments.length} new messages for dialog ${dialogId}`);
      await this.saveIndex();
    }
  }
  
  /**
   * Index a single document
   */
  private indexDocument(document: SearchDocument): void {
    if (!this.index) return;
    
    const terms = this.tokenize(document.text);
    const termCounts = new Map<string, number>();
    
    // Count term frequencies in this document
    for (const term of terms) {
      termCounts.set(term, (termCounts.get(term) || 0) + 1);
    }
    
    // Update global term frequency and document frequency maps
    for (const [term, count] of termCounts) {
      // Update term frequency
      if (!this.index.termFrequency.has(term)) {
        this.index.termFrequency.set(term, new Map());
      }
      this.index.termFrequency.get(term)!.set(document.id, count);
      
      // Update document frequency
      this.index.documentFrequency.set(term, (this.index.documentFrequency.get(term) || 0) + 1);
    }
  }
  
  /**
   * Re-index an existing document (for updates)
   */
  private reindexDocument(document: SearchDocument): void {
    if (!this.index) return;
    
    // Remove old term frequencies for this document
    for (const [term, docMap] of this.index.termFrequency) {
      if (docMap.has(document.id)) {
        docMap.delete(document.id);
        
        // Update document frequency
        const docFreq = this.index.documentFrequency.get(term) || 0;
        if (docFreq <= 1) {
          this.index.documentFrequency.delete(term);
          this.index.termFrequency.delete(term);
        } else {
          this.index.documentFrequency.set(term, docFreq - 1);
        }
      }
    }
    
    // Re-index the document with new content
    this.indexDocument(document);
  }
  
  /**
   * Calculate TF-IDF vector for a document
   */
  private calculateTFIDF(document: SearchDocument): TFIDFVector {
    if (!this.index) return {};
    
    const terms = this.tokenize(document.text);
    const termCounts = new Map<string, number>();
    
    // Count term frequencies
    for (const term of terms) {
      termCounts.set(term, (termCounts.get(term) || 0) + 1);
    }
    
    const vector: TFIDFVector = {};
    const totalTerms = terms.length;
    
    for (const [term, count] of termCounts) {
      const tf = count / totalTerms; // Term frequency
      const docFreq = this.index.documentFrequency.get(term) || 1;
      const idf = Math.log(this.index.totalDocuments / docFreq); // Inverse document frequency
      vector[term] = tf * idf;
    }
    
    return vector;
  }
  
  /**
   * Calculate TF-IDF vector for a query
   */
  private calculateQueryTFIDF(query: string): TFIDFVector {
    if (!this.index) return {};
    
    const terms = this.tokenize(query);
    const termCounts = new Map<string, number>();
    
    // Count term frequencies in query
    for (const term of terms) {
      termCounts.set(term, (termCounts.get(term) || 0) + 1);
    }
    
    const vector: TFIDFVector = {};
    const totalTerms = terms.length;
    
    for (const [term, count] of termCounts) {
      const tf = count / totalTerms;
      const docFreq = this.index.documentFrequency.get(term) || 1;
      const idf = Math.log(this.index.totalDocuments / docFreq);
      vector[term] = tf * idf;
    }
    
    return vector;
  }
  
  /**
   * Calculate cosine similarity between two TF-IDF vectors
   */
  private calculateCosineSimilarity(vec1: TFIDFVector, vec2: TFIDFVector): number {
    const terms1 = new Set(Object.keys(vec1));
    const terms2 = new Set(Object.keys(vec2));
    const commonTerms = new Set([...terms1].filter(term => terms2.has(term)));
    
    if (commonTerms.size === 0) return 0;
    
    let dotProduct = 0;
    let magnitude1 = 0;
    let magnitude2 = 0;
    
    // Calculate dot product and magnitudes
    for (const term of new Set([...terms1, ...terms2])) {
      const val1 = vec1[term] || 0;
      const val2 = vec2[term] || 0;
      
      dotProduct += val1 * val2;
      magnitude1 += val1 * val1;
      magnitude2 += val2 * val2;
    }
    
    const magnitude = Math.sqrt(magnitude1) * Math.sqrt(magnitude2);
    return magnitude === 0 ? 0 : dotProduct / magnitude;
  }
  
  /**
   * Perform semantic search across indexed messages
   */
  async searchSemantic(query: string, dialogId?: string, limit = 20): Promise<SearchResult[]> {
    if (!this.index) {
      await this.loadIndex();
    }
    
    if (!this.index || query.trim().length < 2) {
      return [];
    }
    
    const queryVector = this.calculateQueryTFIDF(query);
    const queryTerms = this.tokenize(query);
    const results: SearchResult[] = [];
    
    // Filter documents by dialog if specified
    const documentsToSearch = dialogId 
      ? this.index.documents.filter(doc => doc.dialogId === dialogId)
      : this.index.documents;
    
    for (const document of documentsToSearch) {
      const documentVector = this.calculateTFIDF(document);
      const similarity = this.calculateCosineSimilarity(queryVector, documentVector);
      
      if (similarity > 0) {
        // Find which query terms matched in this document
        const documentTerms = new Set(this.tokenize(document.text));
        const matchedTerms = queryTerms.filter(term => documentTerms.has(term));
        
        results.push({
          document,
          score: similarity,
          matchedTerms
        });
      }
    }
    
    // Sort by similarity score (descending) and limit results
    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(limit, SemanticSearchService.MAX_RESULTS));
  }
  
  /**
   * Get indexing statistics
   */
  async getIndexStats(): Promise<{
    totalDocuments: number;
    totalTerms: number;
    lastUpdated: Date;
    version: string;
    dialogCounts: { [dialogId: string]: number };
  }> {
    if (!this.index) {
      await this.loadIndex();
    }
    
    if (!this.index) {
      return {
        totalDocuments: 0,
        totalTerms: 0,
        lastUpdated: new Date(),
        version: SemanticSearchService.INDEX_VERSION,
        dialogCounts: {}
      };
    }
    
    const dialogCounts: { [dialogId: string]: number } = {};
    for (const doc of this.index.documents) {
      dialogCounts[doc.dialogId] = (dialogCounts[doc.dialogId] || 0) + 1;
    }
    
    return {
      totalDocuments: this.index.totalDocuments,
      totalTerms: this.index.termFrequency.size,
      lastUpdated: new Date(this.index.lastUpdated),
      version: this.index.version,
      dialogCounts
    };
  }
  
  /**
   * Clear the search index
   */
  async clearIndex(): Promise<void> {
    this.index = this.createEmptyIndex();
    await this.saveIndex();
  }
  
  /**
   * Check if index is available and has content
   */
  async isIndexAvailable(): Promise<boolean> {
    if (!this.index) {
      await this.loadIndex();
    }
    return !!(this.index && this.index.totalDocuments > 0);
  }
}
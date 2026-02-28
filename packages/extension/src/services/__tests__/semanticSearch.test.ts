/**
 * Test file for Semantic Search Service
 * TASK-035: Semantic Chat Search
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SemanticSearchService } from '../semanticSearch';

// Mock VS Code extension context
const mockContext = {
  globalState: {
    data: new Map(),
    get<T>(key: string): T | undefined {
      return this.data.get(key) as T | undefined;
    },
    update(key: string, value: any): Thenable<void> {
      this.data.set(key, value);
      return Promise.resolve();
    }
  }
} as any;

// Sample message data
const sampleMessages = [
  {
    id: '1',
    text: 'I need to fix the authentication bug in the login system',
    timestamp: 1640995200,
    senderName: 'Alice',
    isOutgoing: false,
    entities: []
  },
  {
    id: '2', 
    text: 'Let me review the database connection issue',
    timestamp: 1640995260,
    senderName: 'Bob',
    isOutgoing: true,
    entities: []
  },
  {
    id: '3',
    text: 'The deployment to production went smoothly yesterday',
    timestamp: 1640995320,
    senderName: 'Charlie',
    isOutgoing: false,
    entities: []
  },
  {
    id: '4',
    text: 'Can you check the API endpoint for user registration?',
    timestamp: 1640995380,
    senderName: 'David',
    isOutgoing: false,
    entities: []
  },
  {
    id: '5',
    text: 'Meeting scheduled for tomorrow morning at 9 AM',
    timestamp: 1640995440,
    senderName: 'Eve',
    isOutgoing: true,
    entities: []
  }
];

describe('SemanticSearchService', () => {
  let service: SemanticSearchService;

  beforeEach(() => {
    mockContext.globalState.data.clear();
    service = new SemanticSearchService(mockContext);
  });

  describe('indexing', () => {
    it('should index messages and make search available', async () => {
      const isAvailableBefore = await service.isIndexAvailable();
      expect(isAvailableBefore).toBe(false);

      await service.indexMessages(sampleMessages, 'test-chat-1');

      const isAvailableAfter = await service.isIndexAvailable();
      expect(isAvailableAfter).toBe(true);

      const stats = await service.getIndexStats();
      expect(stats.totalDocuments).toBe(5);
      expect(stats.dialogCounts['test-chat-1']).toBe(5);
    });

    it('should handle empty message arrays', async () => {
      await service.indexMessages([], 'empty-chat');

      const stats = await service.getIndexStats();
      expect(stats.totalDocuments).toBe(0);
      expect(stats.dialogCounts['empty-chat']).toBeUndefined(); // Empty arrays don't create entries
    });

    it('should skip messages with insufficient content', async () => {
      const shortMessages = [
        { ...sampleMessages[0], text: 'hi' },
        { ...sampleMessages[1], text: '' },
        { ...sampleMessages[2], text: 'ok' }
      ];

      await service.indexMessages(shortMessages, 'short-chat');

      const stats = await service.getIndexStats();
      expect(stats.totalDocuments).toBe(0); // All should be filtered out
    });
  });

  describe('search functionality', () => {
    beforeEach(async () => {
      await service.indexMessages(sampleMessages, 'test-chat');
    });

    it('should find semantically related messages for "authentication"', async () => {
      const results = await service.searchSemantic('authentication login', 'test-chat');
      
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].document.text).toContain('authentication');
      expect(results[0].score).toBeGreaterThan(0);
    });

    it('should find semantically related messages for "database"', async () => {
      const results = await service.searchSemantic('database connection', 'test-chat');
      
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].document.text).toContain('database');
    });

    it('should find deployment-related messages', async () => {
      const results = await service.searchSemantic('production deployment', 'test-chat');
      
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].document.text).toContain('production');
    });

    it('should return results sorted by relevance score', async () => {
      const results = await service.searchSemantic('authentication bug fix', 'test-chat');
      
      if (results.length > 1) {
        expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
      }
    });

    it('should return empty results for irrelevant queries', async () => {
      const results = await service.searchSemantic('cooking recipes', 'test-chat');
      
      expect(results.length).toBe(0);
    });

    it('should limit results correctly', async () => {
      await service.indexMessages([...sampleMessages, ...sampleMessages, ...sampleMessages], 'big-chat');
      
      const results = await service.searchSemantic('system', 'big-chat', 3);
      
      expect(results.length).toBeLessThanOrEqual(3);
    });

    it('should search across all dialogs when no dialogId specified', async () => {
      await service.indexMessages(sampleMessages.slice(0, 2), 'chat1');
      await service.indexMessages(sampleMessages.slice(2, 4), 'chat2');
      
      const results = await service.searchSemantic('bug system');
      
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('term processing', () => {
    beforeEach(async () => {
      await service.indexMessages(sampleMessages, 'test-chat');
    });

    it('should handle queries with stop words', async () => {
      const results1 = await service.searchSemantic('the authentication bug', 'test-chat');
      const results2 = await service.searchSemantic('authentication bug', 'test-chat');
      
      expect(results1.length).toBe(results2.length);
    });

    it('should handle case-insensitive queries', async () => {
      const results1 = await service.searchSemantic('AUTHENTICATION', 'test-chat');
      const results2 = await service.searchSemantic('authentication', 'test-chat');
      
      expect(results1.length).toBe(results2.length);
    });

    it('should handle queries with punctuation', async () => {
      const results = await service.searchSemantic('authentication, bug!', 'test-chat');
      
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('index persistence', () => {
    it('should persist index to storage and reload', async () => {
      await service.indexMessages(sampleMessages, 'test-chat');
      
      const stats1 = await service.getIndexStats();
      expect(stats1.totalDocuments).toBe(5);

      // Create new service instance with same context
      const newService = new SemanticSearchService(mockContext);
      
      const stats2 = await newService.getIndexStats();
      expect(stats2.totalDocuments).toBe(5);
      expect(stats2.dialogCounts['test-chat']).toBe(5);

      const results = await newService.searchSemantic('authentication', 'test-chat');
      expect(results.length).toBeGreaterThan(0);
    });

    it('should handle corrupted storage gracefully', async () => {
      // Corrupt the storage
      await mockContext.globalState.update('oceangram.semanticSearch.index', { invalid: 'data' });
      
      const newService = new SemanticSearchService(mockContext);
      const stats = await newService.getIndexStats();
      
      expect(stats.totalDocuments).toBe(0);
    });
  });

  describe('incremental updates', () => {
    it('should update existing documents', async () => {
      await service.indexMessages(sampleMessages.slice(0, 2), 'test-chat');
      
      const modifiedMessage = { ...sampleMessages[0], text: 'Updated authentication bug report' };
      await service.indexMessages([modifiedMessage], 'test-chat');
      
      const results = await service.searchSemantic('authentication', 'test-chat');
      expect(results[0].document.text).toContain('Updated authentication');
    });

    it('should add new messages to existing index', async () => {
      await service.indexMessages(sampleMessages.slice(0, 2), 'test-chat');
      
      const stats1 = await service.getIndexStats();
      expect(stats1.totalDocuments).toBe(2);

      await service.indexMessages(sampleMessages.slice(2), 'test-chat');
      
      const stats2 = await service.getIndexStats();
      expect(stats2.totalDocuments).toBe(5);
    });
  });

  describe('index management', () => {
    it('should clear index completely', async () => {
      await service.indexMessages(sampleMessages, 'test-chat');
      
      const statsBefore = await service.getIndexStats();
      expect(statsBefore.totalDocuments).toBe(5);

      await service.clearIndex();
      
      const statsAfter = await service.getIndexStats();
      expect(statsAfter.totalDocuments).toBe(0);
      expect(Object.keys(statsAfter.dialogCounts)).toHaveLength(0);
    });

    it('should return correct index statistics', async () => {
      await service.indexMessages(sampleMessages.slice(0, 3), 'chat1');
      await service.indexMessages(sampleMessages.slice(3), 'chat2');
      
      const stats = await service.getIndexStats();
      
      expect(stats.totalDocuments).toBe(5);
      expect(stats.dialogCounts['chat1']).toBe(3);
      expect(stats.dialogCounts['chat2']).toBe(2);
      expect(stats.version).toBe('1.0.0');
      expect(stats.totalTerms).toBeGreaterThan(0);
    });
  });
});
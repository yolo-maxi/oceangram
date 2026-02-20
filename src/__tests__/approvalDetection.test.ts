import { describe, it, expect } from 'vitest';
import { isApprovalSeeking } from '../approvalDetection';

describe('isApprovalSeeking', () => {
  describe('true positives — should detect approval patterns', () => {
    it.each([
      'Should I deploy this to production?',
      'Want me to send the email?',
      'Should I proceed with the merge?',
      'Ready to deploy?',
      'Shall I delete those files?',
      'Do you want me to restart the server?',
      'Should I push this to main?',
      'Go ahead and publish?',
      'Can I execute the migration?',
      'Deploy to staging?',
      'Send email to the client?',
      'Merge this PR?',
      'Delete the old backups?',
      'Should I continue with the rollback?',
      'Want me to overwrite the config?',
    ])('detects: "%s"', (text) => {
      expect(isApprovalSeeking(text)).toBe(true);
    });
  });

  describe('true negatives — regular questions should NOT get buttons', () => {
    it.each([
      'How are you doing today?',
      'What time is it?',
      'Where is the config file?',
      'Why did the test fail?',
      'Which database are we using?',
      'Can you explain how this works?',
      'What do you think about the design?',
      'Is this the right approach?',
      'Have you seen the latest commit?',
      'Who wrote this code?',
      '',
      'This is not a question',
      'deploy this now',  // no question mark
    ])('rejects: "%s"', (text) => {
      expect(isApprovalSeeking(text)).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('handles null/undefined gracefully', () => {
      expect(isApprovalSeeking('')).toBe(false);
      expect(isApprovalSeeking(null as any)).toBe(false);
      expect(isApprovalSeeking(undefined as any)).toBe(false);
    });

    it('handles multiline messages (checks last line)', () => {
      const msg = 'I analyzed the code and found 3 issues.\nShould I proceed with the fix?';
      expect(isApprovalSeeking(msg)).toBe(true);
    });

    it('handles trailing whitespace', () => {
      expect(isApprovalSeeking('Deploy?  ')).toBe(true);
    });
  });
});

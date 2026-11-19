// Message parts as the engine's log records them.
import { describe, expect, it } from 'vitest';
import { parsePart } from '../src/engine/events';

describe('parsePart', () => {
  it('keeps the durable image reference from the log', () => {
    const p = parsePart({ type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/jpeg', bytes: 1200, width: 640, height: 480, name: 'cat.jpg' } });
    expect(p).toMatchObject({ type: 'image', mimeType: 'image/jpeg', name: 'cat.jpg', width: 640, height: 480, attachment: { attachmentId: 'a1' } });
  });
  it('still reads an inline image (a prompt before it reaches the log)', () => {
    expect(parsePart({ type: 'image', mediaType: 'image/png', data: 'AAAA' })).toMatchObject({ type: 'image', mimeType: 'image/png', data: 'AAAA' });
    expect(parsePart({ type: 'image', mediaType: 'image/png', data: 'AAAA' })).not.toHaveProperty('attachment');
  });
  it('names a file from its reference', () => {
    expect(parsePart({ type: 'file', attachment: { name: 'report.pdf', mediaType: 'application/pdf', bytes: 9 } })).toMatchObject({
      type: 'file',
      name: 'report.pdf',
      mimeType: 'application/pdf',
      size: 9,
    });
  });
});

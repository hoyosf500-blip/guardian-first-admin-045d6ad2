import { describe, it, expect } from 'vitest';
import { sanitizeText, sanitizeNote, sanitizeAction } from './sanitize';

describe('sanitizeText', () => {
  it('strips HTML tags but preserves inner text', () => {
    // Tags are removed but text content between them stays (harmless in React JSX)
    expect(sanitizeText('Hello <b>Bold</b> World')).toBe('Hello Bold World');
    expect(sanitizeText('<script>alert("xss")</script>')).toBe('alert("xss")');
  });

  it('strips self-closing tags', () => {
    expect(sanitizeText('Text <img src=x onerror=alert(1)/> here')).toBe('Text here');
  });

  it('strips HTML entities', () => {
    expect(sanitizeText('Hello &amp; World')).toBe('Hello World');
  });

  it('collapses whitespace', () => {
    expect(sanitizeText('  Hello   World  ')).toBe('Hello World');
  });

  it('handles newlines', () => {
    expect(sanitizeText('Line1\n\n  Line2')).toBe('Line1 Line2');
  });

  it('returns empty string for empty input', () => {
    expect(sanitizeText('')).toBe('');
  });

  it('handles normal text unchanged', () => {
    expect(sanitizeText('Pedido confirmado por telefono')).toBe('Pedido confirmado por telefono');
  });

  it('preserves accented characters', () => {
    expect(sanitizeText('Dirección incorrecta — solución aplicada')).toBe('Dirección incorrecta — solución aplicada');
  });
});

describe('sanitizeNote', () => {
  it('trims and sanitizes', () => {
    expect(sanitizeNote('  <b>Nota</b>  ')).toBe('Nota');
  });

  it('enforces default max length of 500', () => {
    const long = 'a'.repeat(600);
    expect(sanitizeNote(long).length).toBe(500);
  });

  it('accepts custom max length', () => {
    const text = 'a'.repeat(50);
    expect(sanitizeNote(text, 20).length).toBe(20);
  });
});

describe('sanitizeAction', () => {
  it('sanitizes touchpoint actions', () => {
    expect(sanitizeAction('CALL: <b>Llamada</b>')).toBe('CALL: Llamada');
  });

  it('enforces default max length of 200', () => {
    const long = 'X'.repeat(300);
    expect(sanitizeAction(long).length).toBe(200);
  });
});

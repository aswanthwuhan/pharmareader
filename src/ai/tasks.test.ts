import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../core/db';
import { setSetting } from '../core/settings';
import { AiError } from './client';
import { MAX_CARDS, MAX_INPUT_CHARS, generateCards, parseCards, summarize } from './tasks';

function response(content: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => '',
  } as unknown as Response;
}

/** Stub fetch with one model answer and return the request bodies it saw. */
function stubModel(content: string) {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => response(content));
  vi.stubGlobal('fetch', fetchMock);
  const bodies = () =>
    fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init.body)) as Record<string, unknown>);
  return { fetchMock, bodies };
}

async function failure(promise: Promise<unknown>): Promise<AiError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof AiError) return err;
    throw err;
  }
  throw new Error('expected the call to fail');
}

beforeEach(async () => {
  await db.settings.clear();
  await setSetting('ai.enabled', true);
  await setSetting('ai.baseUrl', 'https://api.test/v1');
  await setSetting('ai.apiKey', 'sk-test');
  await setSetting('ai.model', 'test-model');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseCards', () => {
  it('reads JSON fenced in markdown and trims the text', () => {
    const cards = parseCards(
      '```json\n{"cards":[{"kind":"qa","front":"  What does aspirin do?  ","back":" Irreversibly inhibits COX-1 "},' +
        '{"kind":"cloze","front":"Warfarin inhibits ____ epoxide reductase.","back":"vitamin K"}]}\n```',
    );
    expect(cards).toEqual([
      { kind: 'qa', front: 'What does aspirin do?', back: 'Irreversibly inhibits COX-1' },
      { kind: 'cloze', front: 'Warfarin inhibits ____ epoxide reductase.', back: 'vitamin K' },
    ]);
  });

  it('drops malformed cards and keeps the good ones', () => {
    const cards = parseCards(
      JSON.stringify({
        cards: [
          { kind: 'qa', front: 'Good?', back: 'Yes' },
          { kind: 'essay', front: 'Bad kind', back: 'x' },
          { kind: 'qa', front: '', back: 'empty front' },
          { kind: 'qa', front: 'no back' },
          'not an object',
          null,
          { kind: 'cloze', front: 'Second ____ one', back: 'good' },
        ],
      }),
    );
    expect(cards).toHaveLength(2);
    expect(cards[1]).toEqual({ kind: 'cloze', front: 'Second ____ one', back: 'good' });
  });

  it('finds the JSON when the model adds prose around it', () => {
    const cards = parseCards('Sure! Here are your cards:\n{"cards":[{"kind":"qa","front":"Q","back":"A"}]}\nHope that helps.');
    expect(cards).toHaveLength(1);
  });

  it('caps the list at MAX_CARDS', () => {
    const many = Array.from({ length: MAX_CARDS + 5 }, (_, i) => ({ kind: 'qa', front: `f${i}`, back: `b${i}` }));
    expect(parseCards(JSON.stringify({ cards: many }))).toHaveLength(MAX_CARDS);
  });

  it('throws when the answer is not JSON', () => {
    expect(() => parseCards('I cannot help with that.')).toThrow(AiError);
  });

  it('throws when nothing usable survives', () => {
    expect(() => parseCards('{"cards":[{"kind":"qa","front":"","back":""}]}')).toThrow(AiError);
  });
});

describe('generateCards', () => {
  it('returns validated cards from the model', async () => {
    stubModel('{"cards":[{"kind":"qa","front":"Q1","back":"A1"}]}');
    await expect(generateCards('Some pharmacology text')).resolves.toEqual([{ kind: 'qa', front: 'Q1', back: 'A1' }]);
  });

  it('asks for JSON and sends the topic hint', async () => {
    const { bodies } = stubModel('{"cards":[{"kind":"qa","front":"Q","back":"A"}]}');
    await generateCards('Text', { count: 3, topicHint: 'Pharmacokinetics' });

    const body = bodies()[0] as { response_format?: unknown; messages: { content: string }[] };
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[1].content).toContain('Pharmacokinetics');
    expect(body.messages[1].content).toContain('Make 3 flashcards');
  });

  it('truncates very long input', async () => {
    const { bodies } = stubModel('{"cards":[{"kind":"qa","front":"Q","back":"A"}]}');
    await generateCards('a'.repeat(MAX_INPUT_CHARS) + 'TAIL-MARKER');

    const body = bodies()[0] as { messages: { content: string }[] };
    expect(body.messages[1].content).not.toContain('TAIL-MARKER');
  });

  it('surfaces a non-JSON model answer as an AiError', async () => {
    stubModel('Sorry, I can only answer questions.');
    const err = await failure(generateCards('Text'));
    expect(err.name).toBe('AiError');
  });

  it('rejects empty input without calling the provider', async () => {
    const { fetchMock } = stubModel('{}');
    await expect(generateCards('   ')).rejects.toThrow(/Select some text/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('summarize', () => {
  it('returns the markdown bullets and strips a fence', async () => {
    stubModel('```markdown\n- Mechanism: blocks COX\n- Uses: pain\n```');
    await expect(summarize('Aspirin text')).resolves.toBe('- Mechanism: blocks COX\n- Uses: pain');
  });

  it('does not force JSON mode', async () => {
    const { bodies } = stubModel('- something');
    await summarize('Text');
    expect((bodies()[0] as { response_format?: unknown }).response_format).toBeUndefined();
  });
});

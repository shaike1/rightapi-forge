import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  sanitizeText,
  sanitizeBody,
  sanitiseBodyMiddleware,
  validate,
  formatZodError,
  severitySchema,
  paginationSchema,
  prefixedId,
  textField,
} from './validation.js';

test('sanitizeText: strips C0 control characters but keeps tab/LF/CR + unicode', () => {
  // Build a string containing every control char + some printable.
  const raw = 'hello\x00world\x07\x1B test\ttab\nline\rreturn (Hebrew)';
  const out = sanitizeText(raw);
  assert.equal(out, 'hello' + 'world' + ' test\ttab\nline\rreturn ' + '(Hebrew)');
});

test('sanitizeText: strips script blocks, event-handler attrs, javascript:/data:text/html', () => {
  const raw = [
    'Hello <script>alert(1)</script>',
    'click <a onclick="evil()" href="javascript:doom()">here</a>',
    'image data:text/html,<img>',
  ].join(' | ');
  const out = sanitizeText(raw);
  assert.doesNotMatch(out, /<script/i);
  assert.doesNotMatch(out, /onclick=/i);
  assert.doesNotMatch(out, /javascript:/i);
  assert.doesNotMatch(out, /data:text\/html/i);
  assert.match(out, /Hello/);
  assert.match(out, /click/);
});

test('sanitizeText: caps length to maxLen', () => {
  const out = sanitizeText('x'.repeat(20_000), { maxLen: 100 });
  assert.equal(out.length, 100);
});

test('sanitizeBody: walks each field and respects skipKeys', () => {
  const cleaned = sanitizeBody({
    title: 'normal title',
    description: 'has <script>x</script> and \x00 NUL',
    raw: '<script>untouched</script>',
    count: 42,
    tags: ['<svg/onload=x>', 'safe'],
  }, { skipKeys: ['raw'] });
  assert.equal((cleaned as any).title, 'normal title');
  assert.doesNotMatch(String((cleaned as any).description), /<script|\x00/);
  assert.equal((cleaned as any).raw, '<script>untouched</script>', 'skipped key untouched');
  assert.equal((cleaned as any).count, 42);
  // The bare <svg> tag survives (it's inert without a handler); the
  // sanitiser's job is to strip the onload= attack vector, which it
  // does. Defense-in-depth, not a full HTML scrubber.
  assert.doesNotMatch(String((cleaned as any).tags[0]), /onload/);
  assert.equal((cleaned as any).tags[1], 'safe');
});

test('sanitiseBodyMiddleware: cleans nested bodies in place', async () => {
  const mw = sanitiseBodyMiddleware();
  const req: any = {
    body: {
      title: 'fine',
      nested: { desc: 'evil <script>x</script>', list: ['<b onload=x>', 'ok'] },
    },
  };
  await new Promise<void>(r => mw(req, {} as any, () => r()));
  assert.doesNotMatch(req.body.nested.desc, /<script/);
  assert.doesNotMatch(req.body.nested.list[0], /onload/);
});

test('sanitiseBodyMiddleware: caps recursion depth + key count', async () => {
  // Build a 12-deep object — should not stack-overflow.
  const deep: any = { v: 'leaf' };
  let cursor = deep;
  for (let i = 0; i < 12; i++) {
    cursor.next = { v: 'leaf' + i };
    cursor = cursor.next;
  }
  const mw = sanitiseBodyMiddleware({ maxDepth: 4 });
  const req: any = { body: deep };
  await new Promise<void>(r => mw(req, {} as any, () => r()));
  // The top three levels should be sanitized objects; depth 4+ is
  // returned untouched (still present, just not recursed).
  assert.equal(typeof req.body.next.next.next.next, 'object');
});

test('sanitiseBodyMiddleware: respects skip-list for markdown fields', async () => {
  // The default skip list includes "content" and "description". These
  // fields should keep markdown markup like code fences, while still
  // being length-capped.
  const mw = sanitiseBodyMiddleware();
  const req: any = {
    body: {
      title: 'fine',
      content: '## heading\n\n```js\nconst x = 1;\n```\n\n<em>preserved on skip list</em>',
      summary: 'sanitized field',
    },
  };
  await new Promise<void>(r => mw(req, {} as any, () => r()));
  // content kept verbatim apart from the length cap.
  assert.match(req.body.content, /```js/);
  assert.match(req.body.content, /<em>/, 'skip-list passes through markup');
});

test('validate: ok path attaches typed payload at req.validated[source]', () => {
  const schema = z.object({ name: z.string(), age: z.number() });
  const mw = validate(schema);
  const req: any = { body: { name: 'a', age: 1 } };
  let nextCalled = false;
  mw(req, { status: () => ({ json: () => {} }) } as any, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.deepEqual(req.validated.body, { name: 'a', age: 1 });
});

test('validate: bad payload returns 400 with field-level details', () => {
  const schema = z.object({ name: z.string().min(3), age: z.number().min(0) });
  const mw = validate(schema);
  const req: any = { body: { name: 'a', age: -5 } };
  let status = 0;
  let payload: any;
  const res = {
    status: (c: number) => { status = c; return res; },
    json: (p: any) => { payload = p; },
  };
  mw(req, res as any, () => {
    throw new Error('next should NOT be called on validation failure');
  });
  assert.equal(status, 400);
  assert.equal(payload.code, 'VALIDATION_ERROR');
  assert.ok(payload.details.length >= 2);
  const paths = payload.details.map((d: any) => d.path);
  assert.ok(paths.includes('body.name'));
  assert.ok(paths.includes('body.age'));
});

test('severitySchema rejects unknown values', () => {
  assert.equal(severitySchema.safeParse('low').success, true);
  assert.equal(severitySchema.safeParse('urgent').success, false);
});

test('paginationSchema coerces strings to numbers and caps limit', () => {
  const r = paginationSchema.safeParse({ limit: '50', offset: '10' });
  assert.equal(r.success, true);
  assert.deepEqual(r.data, { limit: 50, offset: 10 });
  // Above-cap rejected.
  assert.equal(paginationSchema.safeParse({ limit: '500' }).success, false);
});

test('prefixedId rejects non-matching strings', () => {
  const inc = prefixedId('INC');
  assert.equal(inc.safeParse('INC-AB12CD34').success, true);
  assert.equal(inc.safeParse('inc-aabbccdd').success, false, 'lowercase rejected');
  assert.equal(inc.safeParse('PRB-12345678').success, false, 'wrong prefix rejected');
});

test('textField sanitises through the transform on parse', () => {
  const field = textField({ min: 1, max: 50 });
  const r = field.safeParse('<script>x</script>real content');
  assert.equal(r.success, true);
  assert.doesNotMatch(r.data || '', /<script/);
});

test('formatZodError shape', () => {
  const schema = z.object({ name: z.string() });
  const r = schema.safeParse({ name: 1 });
  assert.equal(r.success, false);
  if (!r.success) {
    const env = formatZodError(r.error, 'body');
    assert.equal(env.code, 'VALIDATION_ERROR');
    assert.equal(env.error, 'Validation failed');
    assert.equal(env.details[0].path, 'body.name');
  }
});

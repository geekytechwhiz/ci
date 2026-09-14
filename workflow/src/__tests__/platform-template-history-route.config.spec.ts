/**
 * Locks the platform workflow template history route.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../..');

describe('platform workflow template history route config', () => {
  const serverless = readFileSync(join(ROOT, 'serverless.yml'), 'utf8').replace(
    /\r\n/g,
    '\n',
  );

  it('declares GET /v1/platform/workflow-templates/{templateId}/history on the api Lambda', () => {
    const start = serverless.indexOf('\n  api:\n');
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = serverless.slice(start + 1);
    const next = rest.search(/\n  [a-zA-Z][a-zA-Z0-9]*:\n/);
    const block = next < 0 ? rest : rest.slice(0, next);
    expect(block).toContain('handler: src/handlers/http/api.main');
    expect(block).toContain(
      'path: v1/platform/workflow-templates/{templateId}/history',
    );
    expect(block).toContain('method: get');
    expect(block).not.toContain('authorizer:');
  });
});

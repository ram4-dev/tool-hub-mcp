import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb } from '../../src/telemetry/init.js';
import { Catalog } from '../../src/catalog/index.js';
import type Database from 'better-sqlite3';

describe('Catalog', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = initDb({ inMemory: true });
  });
  afterEach(() => {
    db.close();
  });

  it('add persists in SQLite and map', () => {
    const cat = new Catalog(db);
    cat.add({
      tool_id: 'x.foo',
      mcp_name: 'x',
      tool_name: 'foo',
      short_description: 'Foo tool',
      full_schema_json: '{"type":"object"}',
      schema_tokens: 10,
    });
    expect(cat.size()).toBe(1);
    const row = db.prepare('SELECT * FROM tools WHERE tool_id=?').get('x.foo') as any;
    expect(row.tool_name).toBe('foo');
  });

  it('reloads existing tools from SQLite', () => {
    const cat1 = new Catalog(db);
    cat1.add({
      tool_id: 'a.b',
      mcp_name: 'a',
      tool_name: 'b',
      short_description: 'desc',
      full_schema_json: '{}',
      schema_tokens: 5,
    });
    const cat2 = new Catalog(db);
    expect(cat2.get('a.b')?.tool_name).toBe('b');
  });

  it('setEnabled/removeByMcp propagate', () => {
    const cat = new Catalog(db);
    cat.add({
      tool_id: 'g.pr',
      mcp_name: 'g',
      tool_name: 'pr',
      short_description: '',
      full_schema_json: '{}',
      schema_tokens: 1,
    });
    cat.setEnabled('g.pr', false);
    expect(cat.get('g.pr')?.enabled).toBe(false);
    const removed = cat.removeByMcp('g');
    expect(removed).toBe(1);
    expect(cat.size()).toBe(0);
  });
});

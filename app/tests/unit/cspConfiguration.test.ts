import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function directives(csp: string): Map<string, string[]> {
  return new Map(csp
    .split(';')
    .map((directive) => directive.trim())
    .filter(Boolean)
    .map((directive) => {
      const [name, ...values] = directive.split(/\s+/);
      return [name, values];
    }));
}

describe('production WebView content security policy', () => {
  const configPath = resolve(process.cwd(), 'src-tauri/tauri.conf.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
    app: { security: { csp: string } };
  };
  const policy = directives(config.app.security.csp);

  it('does not permit inline or evaluated scripts', () => {
    const scriptSources = policy.get('script-src');
    expect(scriptSources).toBeDefined();
    expect(scriptSources).toContain("'self'");
    expect(scriptSources).not.toContain("'unsafe-inline'");
    expect(scriptSources).not.toContain("'unsafe-eval'");
  });

  it('retains defense-in-depth restrictions for executable document surfaces', () => {
    expect(policy.get('object-src')).toEqual(["'none'"]);
    expect(policy.get('base-uri')).toEqual(["'self'"]);
    expect(policy.get('form-action')).toEqual(["'self'"]);
  });

  it('loads the application entrypoint from an external module', () => {
    const entrypointPath = resolve(process.cwd(), 'index.html');
    const entrypoint = readFileSync(entrypointPath, 'utf8');
    const scripts = [...entrypoint.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];

    expect(scripts).not.toHaveLength(0);
    for (const [, attributes, body] of scripts) {
      expect(attributes).toMatch(/\bsrc\s*=/i);
      expect(body.trim()).toBe('');
    }
  });
});

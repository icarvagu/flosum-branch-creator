'use strict';

jest.mock('child_process', () => ({
  execSync: jest.fn(),
}));

const { execSync } = require('child_process');
const {
  extractMetadata,
  generateBranchName,
  toKebab,
  getGitChanges,
  stripMetaExtension,
} = require('../utils');

// ─── helpers ─────────────────────────────────────────────────────────────────
const ch = (file, status = 'M') => ({ status, file });
const sf = (type, name) => `force-app/main/default/${type}/${name}`;

// ─── stripMetaExtension ───────────────────────────────────────────────────────
describe('stripMetaExtension', () => {
  test('strips .cls extension', () => {
    expect(stripMetaExtension('AccountTrigger.cls')).toBe('AccountTrigger');
  });

  test('strips -meta.xml from companion file', () => {
    expect(stripMetaExtension('AccountTrigger.cls-meta.xml')).toBe('AccountTrigger');
  });

  test('strips layout companion file (bug regression)', () => {
    // Bug: used to return "Quote-Cotação Comerc.layout" instead of "Quote-Cotação Comerc"
    expect(stripMetaExtension('Quote-Cotação Comerc.layout-meta.xml')).toBe('Quote-Cotação Comerc');
  });

  test('strips flow companion file', () => {
    expect(stripMetaExtension('MyFlow.flow-meta.xml')).toBe('MyFlow');
  });

  test('strips permissionset companion file', () => {
    expect(stripMetaExtension('Irec.permissionset-meta.xml')).toBe('Irec');
  });

  test('strips trigger companion file', () => {
    expect(stripMetaExtension('AccountTrigger.trigger-meta.xml')).toBe('AccountTrigger');
  });

  test('handles plain filename without extension', () => {
    expect(stripMetaExtension('MyClass')).toBe('MyClass');
  });
});

// ─── extractMetadata ─────────────────────────────────────────────────────────
describe('extractMetadata', () => {
  test('detects Apex class', () => {
    const result = extractMetadata([ch(sf('classes', 'AccountTrigger.cls'))]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: 'AccountTrigger', type: 'classes' });
  });

  test('groups .cls and -meta.xml into same item', () => {
    const changes = [
      ch(sf('classes', 'AccountTrigger.cls')),
      ch(sf('classes', 'AccountTrigger.cls-meta.xml')),
    ];
    const result = extractMetadata(changes);
    expect(result).toHaveLength(1);
    expect(result[0].files).toHaveLength(2);
  });

  test('detects LWC component (subdirectory)', () => {
    const result = extractMetadata([
      ch('force-app/main/default/lwc/riskAssessment/riskAssessment.js'),
      ch('force-app/main/default/lwc/riskAssessment/riskAssessment.html'),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: 'riskAssessment', type: 'lwc' });
    expect(result[0].files).toHaveLength(2);
  });

  test('detects layout with spaces and accents (bug regression)', () => {
    const result = extractMetadata([
      ch(sf('layouts', 'Quote-Cotação Comerc.layout-meta.xml')),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: 'Quote-Cotação Comerc', type: 'layouts' });
  });

  test('detects layout with spaces in filename', () => {
    const result = extractMetadata([
      ch(sf('layouts', 'Proposta_Trading__c-Layout Atacado Usuários Comuns.layout-meta.xml')),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Proposta_Trading__c-Layout Atacado Usuários Comuns');
  });

  test('filters out test classes', () => {
    const result = extractMetadata([
      ch(sf('classes', 'AccountTrigger.cls')),
      ch(sf('classes', 'AccountTriggerTest.cls')),
      ch(sf('classes', 'AccountTriggerTests.cls')),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('AccountTrigger');
  });

  test('ignores non-SF files', () => {
    const result = extractMetadata([
      ch('package.json'),
      ch('.gitignore'),
      ch('README.md'),
    ]);
    expect(result).toHaveLength(0);
  });

  test('handles multiple metadata types', () => {
    const result = extractMetadata([
      ch(sf('classes', 'AccountDAO.cls')),
      ch(sf('triggers', 'AccountTrigger.trigger')),
      ch(sf('lwc', 'myComponent/myComponent.js')),
    ]);
    expect(result).toHaveLength(3);
    const types = result.map(r => r.type).sort();
    expect(types).toEqual(['classes', 'lwc', 'triggers']);
  });

  test('detects object field', () => {
    const result = extractMetadata([
      ch('force-app/main/default/objects/Account/fields/Name__c.field-meta.xml'),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: 'Account', type: 'objects' });
  });

  test('returns files array with all related files', () => {
    const files = [
      sf('classes', 'MyClass.cls'),
      sf('classes', 'MyClass.cls-meta.xml'),
    ];
    const result = extractMetadata(files.map(f => ch(f)));
    expect(result[0].files).toEqual(expect.arrayContaining(files));
  });

  test('handles empty changes array', () => {
    expect(extractMetadata([])).toEqual([]);
  });
});

// ─── toKebab ─────────────────────────────────────────────────────────────────
describe('toKebab', () => {
  test('converts camelCase', () => {
    expect(toKebab('AccountTrigger')).toBe('account-trigger');
  });

  test('converts PascalCase', () => {
    expect(toKebab('RiskAssessmentService')).toBe('risk-assessment-service');
  });

  test('already lowercase passes through', () => {
    expect(toKebab('myclass')).toBe('myclass');
  });

  test('handles single word', () => {
    expect(toKebab('Account')).toBe('account');
  });

  test('handles consecutive capitals', () => {
    expect(toKebab('AccountDAO')).toBe('account-d-a-o');
  });

  test('does not add leading hyphen', () => {
    expect(toKebab('Account').startsWith('-')).toBe(false);
  });
});

// ─── generateBranchName ──────────────────────────────────────────────────────
describe('generateBranchName', () => {
  test('returns date-based name for empty metadata', () => {
    const name = generateBranchName([]);
    expect(name).toMatch(/^feature\/changes-\d{8}$/);
  });

  test('single item → feature/<kebab>', () => {
    const result = generateBranchName([{ name: 'AccountTrigger', type: 'classes', files: [] }]);
    expect(result).toBe('feature/account-trigger');
  });

  test('two items → combined', () => {
    const result = generateBranchName([
      { name: 'AccountTrigger', type: 'classes', files: [] },
      { name: 'AccountDAO', type: 'classes', files: [] },
    ]);
    expect(result).toBe('feature/account-trigger-account-d-a-o');
  });

  test('caps at 3 items', () => {
    const meta = ['Alpha', 'Beta', 'Gamma', 'Delta'].map(n => ({ name: n, type: 'classes', files: [] }));
    const result = generateBranchName(meta);
    expect(result.split('/')[1].split('-').filter(s => s).length).toBeLessThanOrEqual(6);
    expect(result).not.toContain('delta');
  });

  test('deduplicates slugs', () => {
    const meta = [
      { name: 'Account', type: 'classes', files: [] },
      { name: 'Account', type: 'triggers', files: [] },
    ];
    const result = generateBranchName(meta);
    expect(result).toBe('feature/account');
  });
});

// ─── getGitChanges ────────────────────────────────────────────────────────────
describe('getGitChanges', () => {
  beforeEach(() => execSync.mockReset());

  test('parses modified file', () => {
    execSync.mockReturnValue(' M force-app/main/default/classes/AccountTrigger.cls\n');
    const result = getGitChanges('/project');
    expect(result).toEqual([{ status: 'M', file: 'force-app/main/default/classes/AccountTrigger.cls' }]);
  });

  test('parses untracked file (??)', () => {
    execSync.mockReturnValue('?? force-app/main/default/classes/NewClass.cls\n');
    const result = getGitChanges('/project');
    expect(result).toEqual([{ status: '??', file: 'force-app/main/default/classes/NewClass.cls' }]);
  });

  test('strips surrounding quotes from filenames with spaces', () => {
    execSync.mockReturnValue(' M "force-app/main/default/layouts/Quote-Cotação Comerc.layout-meta.xml"\n');
    const result = getGitChanges('/project');
    expect(result[0].file).toBe('force-app/main/default/layouts/Quote-Cotação Comerc.layout-meta.xml');
    expect(result[0].file[0]).not.toBe('"');
  });

  test('ignores empty lines', () => {
    execSync.mockReturnValue(' M file.cls\n\n\n');
    const result = getGitChanges('/project');
    expect(result).toHaveLength(1);
  });

  test('handles multiple files', () => {
    execSync.mockReturnValue(
      ' M force-app/main/default/classes/A.cls\n M force-app/main/default/triggers/B.trigger\n'
    );
    const result = getGitChanges('/project');
    expect(result).toHaveLength(2);
  });

  test('passes core.quotepath=false to git', () => {
    execSync.mockReturnValue('');
    getGitChanges('/project');
    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining('core.quotepath=false'),
      expect.anything()
    );
  });
});

import { evaluatePasswordChecklist } from '../passwordChecklist';

function metIds(password: string, email = '', displayName = ''): string[] {
  return evaluatePasswordChecklist(password, email, displayName)
    .filter((item) => item.met)
    .map((item) => item.id);
}

describe('evaluatePasswordChecklist', () => {
  it('marks every item unmet for an empty password', () => {
    const items = evaluatePasswordChecklist('', '', '');
    expect(items.every((item) => !item.met)).toBe(true);
  });

  it('marks every item met for a strong, unrelated password', () => {
    const items = evaluatePasswordChecklist('Xq7!vTr9zLmP#4word', 'user@example.com', 'Ada Lovelace');
    expect(items.every((item) => item.met)).toBe(true);
  });

  it('length item requires at least 12 characters', () => {
    expect(metIds('Aa1!Aa1!Aa1')).not.toContain('length'); // 11 chars
    expect(metIds('Aa1!Aa1!Aa1!')).toContain('length'); // 12 chars
  });

  it('checks uppercase/lowercase/number/symbol independently', () => {
    expect(metIds('alllowercase123!')).not.toContain('uppercase');
    expect(metIds('ALLUPPERCASE123!')).not.toContain('lowercase');
    expect(metIds('NoDigitsHereAtAll!')).not.toContain('number');
    expect(metIds('NoSymbolsHere1234')).not.toContain('symbol');
  });

  it('flags a common password as not meeting not_common', () => {
    expect(metIds('password123')).not.toContain('not_common');
  });

  it('flags a password containing the full email as not meeting not_identity', () => {
    expect(metIds('Str0ng!user@example.com', 'user@example.com')).not.toContain('not_identity');
  });

  it('flags a password containing a long-enough email local part', () => {
    expect(metIds('MyPasswordIsJdoe123!', 'jdoe@example.com')).not.toContain('not_identity');
  });

  it('does not false-positive on a short email local part', () => {
    expect(metIds('Xq7!vTr9zLmP#4word', 'jo@example.com')).toContain('not_identity');
  });

  it('flags a password containing the display name', () => {
    expect(metIds('MySecretJennifer1!', '', 'Jennifer Smith')).not.toContain('not_identity');
  });
});

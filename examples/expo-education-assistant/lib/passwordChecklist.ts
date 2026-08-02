/**
 * Live, client-side approximation of app/core/password_policy.py's rules
 * — UX sugar only. The backend remains the sole source of truth (see
 * that module's own docstring): this never replaces server-side
 * validation, it just gives immediate feedback while typing. The
 * "commonly used password" check here is a small illustrative subset of
 * the backend's real denylist, not a full mirror of it — an unusual
 * common password this list misses is still caught by the backend.
 */

const COMMON_PASSWORDS = new Set([
  '12345678',
  '123456789',
  'password',
  'password1',
  'password123',
  'password123!',
  'qwerty123',
  'letmein',
  'admin123',
  'welcome123',
  'abcdefgh',
  'iloveyou',
  'monkey123',
  'dragon123',
  'trustno1',
]);

const MIN_SUBSTRING_LENGTH = 4;

export interface PasswordChecklistItem {
  id: string;
  label: string;
  met: boolean;
}

export function evaluatePasswordChecklist(
  password: string,
  email: string,
  displayName: string
): PasswordChecklistItem[] {
  const normalizedPassword = password.toLowerCase();
  const normalizedEmail = email.trim().toLowerCase();
  const emailLocalPart = normalizedEmail.split('@')[0] ?? '';
  const nameParts = displayName
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((part) => part.length >= 3);

  const containsIdentity =
    (normalizedEmail.length > 0 && normalizedPassword.includes(normalizedEmail)) ||
    (emailLocalPart.length >= MIN_SUBSTRING_LENGTH &&
      normalizedPassword.includes(emailLocalPart)) ||
    nameParts.some((part) => normalizedPassword.includes(part));

  return [
    { id: 'length', label: 'At least 12 characters', met: password.length >= 12 },
    { id: 'uppercase', label: 'One uppercase letter', met: /[A-Z]/.test(password) },
    { id: 'lowercase', label: 'One lowercase letter', met: /[a-z]/.test(password) },
    { id: 'number', label: 'One number', met: /[0-9]/.test(password) },
    { id: 'symbol', label: 'One special character', met: /[^A-Za-z0-9]/.test(password) },
    {
      id: 'not_common',
      label: 'Not a commonly used password',
      met: password.length > 0 && !COMMON_PASSWORDS.has(normalizedPassword),
    },
    {
      id: 'not_identity',
      label: "Doesn't contain your email address or name",
      met: password.length > 0 && !containsIdentity,
    },
  ];
}

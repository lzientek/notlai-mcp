export function validateEmail(input: string): boolean {
  if (!input || typeof input !== 'string') {
    return false;
  }

  const atIndex = input.indexOf('@');
  const lastAtIndex = input.lastIndexOf('@');

  if (atIndex === -1 || atIndex !== lastAtIndex) {
    return false;
  }

  const localPart = input.slice(0, atIndex);
  const domain = input.slice(atIndex + 1);

  if (localPart.length === 0 || domain.length === 0) {
    return false;
  }

  const dotIndex = domain.indexOf('.');
  if (dotIndex === -1 || dotIndex === 0 || dotIndex === domain.length - 1) {
    return false;
  }

  return true;
}

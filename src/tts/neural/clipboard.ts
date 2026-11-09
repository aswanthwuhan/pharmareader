/**
 * Copy text to the clipboard, reporting whether it actually worked.
 *
 * The Clipboard API needs a secure context and permission — in an Android WebView
 * it can be missing or rejected even though the page is https://localhost. The
 * old textarea + execCommand path still works there, so try it as a fallback and
 * tell the caller the truth instead of showing a fake "Copied".
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied / not focused — fall through to the legacy path.
  }
  if (typeof document === 'undefined') return false;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  try {
    return document.execCommand('copy') === true;
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

// Detekce nové verze bez service workeru: porovná zabudované build id
// se serverovým ./version.json a nabídne tlačítko k obnovení stránky.
// Řeší i tablet/PWA, kde není Ctrl+F5, a stálou edge cache index.html.

export function initUpdateCheck(): void {
  // V devu version.json neexistuje a build id se nemění — přeskoč.
  if (import.meta.env.DEV) return;

  const current = __BUILD_ID__;
  let shown = false;

  async function check(): Promise<void> {
    if (shown) return;
    try {
      const res = await fetch(`./version.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const { buildId } = (await res.json()) as { buildId?: string };
      if (buildId && buildId !== current) show();
    } catch {
      // offline nebo chyba sítě — ignoruj, zkusíme příště
    }
  }

  function show(): void {
    if (shown) return;
    shown = true;
    const bar = document.createElement('button');
    bar.className = 'update-banner';
    bar.textContent = '🔄 Nová verze je k dispozici — klepni pro obnovení';
    bar.addEventListener('click', () => location.reload());
    document.body.appendChild(bar);
  }

  check();
  // Při návratu na záložku a pravidelně na pozadí.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) check();
  });
  window.setInterval(check, 5 * 60 * 1000);
}

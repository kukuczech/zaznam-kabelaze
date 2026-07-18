// Tisková stránka všech stěn s trasami — implementace v M5.
export async function renderPrint(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <header class="bar">
      <button onclick="location.hash='#/'">←</button>
      <h1>Tisk</h1>
    </header>
    <main class="page"><div class="muted">Tisková sestava (M5)</div></main>`;
}

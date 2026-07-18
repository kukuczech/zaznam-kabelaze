// Elevation editor stěny (SVG) — implementace v M2.
export async function renderElevation(root: HTMLElement, wallId: string): Promise<void> {
  root.innerHTML = `
    <header class="bar">
      <button onclick="history.back()">←</button>
      <h1>Stěna</h1>
    </header>
    <main class="page"><div class="muted">Elevation editor (M2) — stěna ${wallId}</div></main>`;
}

// 3D pohled podlaží (Three.js) — implementace v M1.
export async function renderViewer3d(root: HTMLElement, storeyId: string): Promise<void> {
  root.innerHTML = `
    <header class="bar">
      <button onclick="location.hash='#/'">←</button>
      <h1>3D pohled</h1>
    </header>
    <main class="page"><div class="muted">3D viewer (M1) — podlaží ${storeyId}</div></main>`;
}

# Záznam kabeláže

Osobní jednoúčelový nástroj pro dokumentaci šliců a rozvodů (elektro, voda, Loxone…) na stěnách rozestavěného domu — aby se v budoucnu nic nepřevrtalo.

- Import 3D modelu domu z **magicplan** (IFC4, jedno podlaží na soubor)
- 3D pohled podlaží → tap na stěnu → čelní pohled (elevation)
- Kreslení tras šliců klikáním (pravé úhly i šikmo), šířka šlicu, kategorie s barvami
- Délky segmentů a kóty plněné přímo z laseru **Leica DISTO D2** přes Web Bluetooth
- Fotky stěn, kótování k stropu/rohům, tisk pohledů všech stěn (PDF)
- Data lokálně v prohlížeči (IndexedDB), záloha jako ZIP

## Provoz

- **PC:** Chrome/Edge (Web Bluetooth funguje)
- **iPhone/iPad:** prohlížeč [Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055) (Safari Web Bluetooth neumí)
- Hosting: GitHub Pages (HTTPS je pro Web Bluetooth povinné)

## Vývoj

```bash
npm install
npm run dev
```

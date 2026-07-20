# Plán: LiDAR náčrt + laserové přeměření → parametrický model místnosti

> Cíl: nahradit magicplan vlastním tokem, kde **LiDAR (iPhone Pro) dá základní tvar
> místnosti včetně šikmin**, a pak se **každá stěna přeměří laserem (DISTO) a model
> se podle naměřených hodnot překresluje**. Naměřená hodnota je vždy pravda, LiDAR
> je jen počáteční odhad.

## Proč a kontext

- **magicplan i Apple RoomPlan jsou parametrické skenery** — dávají čisté stěny, ale
  strop ignorují a šikminy zjednodušují na kvádry. Šikmá střecha se v nich nedá udržet.
- **Mesh skenery (Polycam, Scaniverse)** zachytí skutečnou geometrii vč. šikmin, ale
  jako „syrový" mesh — čištění a extrakce rovin je na nás.
- **Doménová hodnota projektu je dokumentace kabeláže**, ne skenování. Skenování
  „koupíme" (mesh skener), naše práce je z náčrtu udělat čistý parametrický model
  a nechat ho doladit laserem.
- ⚠️ **LiDAR má jen iPhone Pro / Pro Max**, ne základní iPhone 16 / 16 Plus.

## Klíčový princip: `axis` zůstává, jen se stane odvozeným cache

Skoro celý kód čte geometrii přes helpery v `geometry.ts` (`axisDir`, `axisLen`,
`projectToAxis`, `wallNormal`); přímý `wall.axis` je jen ve 3 souborech
(`geometry.ts`, `db.ts`, `viewer3d.ts`).

> **Zdroj pravdy = graf rohů. `axis` = dopočítané pole, přegenerované po každém solve.**

Downstream (editor, elevace, exporty, 3D) se **nemění** — dál čte `wall.axis`, jen ho
teď plní solver.

## Datový model (`src/model/types.ts`)

```ts
/** Uzel půdorysu — sdílený roh, kde se potkává víc stěn. */
export interface Corner {
  id: string;
  x: number; y: number;   // mm, aktuální (po solve) poloha
  lidar?: XY;             // původní odhad z LiDARu — kotva pro solver
}

export interface Storey {
  // …stávající pole…
  corners?: Corner[];      // NOVÉ (undefined = starý projekt → migrace)
}

export interface Wall {
  axis: [XY, XY];          // DOPOČÍTANÉ z a/b, needituje se ručně

  a?: string;              // id rohu (start) → axis[0]
  b?: string;              // id rohu (konec) → axis[1]

  measuredLengthMm?: number;   // DISTO; solver drží |a−b| = tato hodnota
  dirLocked?: boolean;         // úhel zafixován (90° osnap / naměřeno)
}
```

Prvky, trasy, kóty, faces = beze změny. Kreslicí plochy podlahy/stropu
(`planOutline` ≠ undefined) do grafu **nepatří**, solver je přeskočí.

Princip „naměřená > geometrická" už v modelu je: `Dimension.valueMm`,
`Route.segLengthsMm`, komentář u `Room.clearPolygon`.

## `rebuildAxes` — dopočítání `axis` z grafu (`src/model/geometry.ts`)

```ts
export function rebuildAxes(storey: Storey): void {
  const byId = new Map(storey.corners?.map((c) => [c.id, c]));
  for (const w of storey.walls) {
    if (w.planOutline) continue;           // podlaha/strop se neřeší
    const a = w.a && byId.get(w.a), b = w.b && byId.get(w.b);
    if (a && b) w.axis = [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];
  }
}
```

Pořadí přepočtu po JAKÉKOLI změně (import, naměření, tažení rohu):

```
solve(storey) → rebuildAxes(storey) → computeFaceTrims(walls) → computeRoomClearPolygons(walls, rooms)
```

(poslední dvě už existují)

## Migrace: graf ze současných dat přes `JOINT_TOL`

```ts
export function buildCornerGraph(storey: Storey): void {
  const corners: Corner[] = [];
  const weld = (p: XY): string => {
    const hit = corners.find((c) => Math.hypot(c.x - p.x, c.y - p.y) <= JOINT_TOL);
    if (hit) return hit.id;
    const c = { id: newId(), x: p.x, y: p.y, lidar: { ...p } };
    corners.push(c); return c.id;
  };
  for (const w of storey.walls) {
    if (w.planOutline) continue;
    w.a = weld(w.axis[0]); w.b = weld(w.axis[1]);
  }
  storey.corners = corners;
}
```

Formalizuje to, co dnes `computeFaceTrims` a `viewer3d` hádají pokaždé znovu podle
blízkosti koncových bodů (`JOINT_TOL = 60 mm`).

## Nejjednodušší ortogonální solver (start)

Trik: **v pravoúhlé místnosti se X a Y rozpadnou na dvě nezávislé 1D úlohy.**

1. **Globální rotace θ** z převažujícího směru stěn → každá stěna je ~H nebo ~V.
2. **Osnap směrů** — klasifikace H/V (`dirLocked`).
3. **Rozpad na 1D:**
   - vodorovná stěna ⇒ oba rohy stejné Y; `measuredLengthMm` = známá mezera v X,
   - svislá stěna ⇒ stejné X; naměřená délka = známá mezera v Y.
4. **1D least-squares** zvlášť pro X a Y: ukotvit jeden roh, naměřené vazby velká
   váha, LiDAR malá (aby nepřeměřené rohy neuletěly).
5. **Rotace zpět** → `rebuildAxes`.

Zkosené stěny a podkroví později řeší obecný least-squares (Gauss–Newton) na polohy rohů.

## Šikmina — samostatná vrstva

Není součástí 2D solveru. Per-stěna svislá parametrizace:

```ts
export interface SlopePlane {
  baseWallId: string;
  kneeHeightMm: number;    // výška nadezdívky (kolenní stěny)
  ridgeHeightMm?: number;
  runMm?: number;          // vodorovný běh, nebo:
  angleDeg?: number;       // sklon
}
```

LiDAR odhad → laser přebíjí → rovina se přepočte. Napojení do elevace přes stávající
`displayU` mašinerii.

## Rozfázování

| Fáze | Obsah | Přínos |
|---|---|---|
| **0 — de-risk** | `Corner` graf + `rebuildAxes` + migrace, **solver = identita** | Bez změny chování; data mají topologii; zpřesní `faceTrim`. |
| **1 — jádro** | Ortogonální solver + `measuredLengthMm` UI + plnění z DISTO + stav „odhad/potvrzeno" + ukazatel pokrytí | LiDAR náčrt → laser doladí → překreslí. |
| **2 — zkosené** | Obecný least-squares solver | Neortogonální místnosti. |
| **3 — podkroví** | `SlopePlane` + elevace šikmin | Šikmina střechy. |
| **4 — import meshe** | Parser OBJ/PLY + extrakce a klasifikace rovin (stěna/šikmina/podlaha) | Náhrada magicplan importu skenem z Polycam/Scaniverse. |

---

# Prompty pro spouštění jednotlivých fází

Každý prompt je samostatný — dá se vložit do nové session jako zadání.

## Fáze 0 — Graf rohů (de-risk, bez změny chování)

```
Refaktor: zaveď topologický graf rohů jako zdroj pravdy pro půdorys, `axis` udělej
odvozeným cache. Podle docs/plan-lidar-laser-mereni.md, fáze 0.

1. src/model/types.ts: přidej interface Corner { id; x; y; lidar? }, do Storey přidej
   corners?: Corner[], do Wall přidej a?: string, b?: string (id rohů). axis zůstává.
2. src/model/geometry.ts: napiš buildCornerGraph(storey) — sváří koncové body stěn do
   sdílených Corner podle JOINT_TOL (přeskoč stěny s planOutline); a rebuildAxes(storey)
   — přepíše axis z poloh rohů dle a/b.
3. src/db.ts: v migraci projektu po načtení zavolej buildCornerGraph na každé podlaží
   (idempotentně — jen když storey.corners chybí). Zachovej pořadí přepočtů: po
   buildCornerGraph nech doběhnout computeFaceTrims a computeRoomClearPolygons.

AKCEPTAČNÍ KRITÉRIUM: solver zatím NEEXISTUJE (identita). Po migraci se axis nesmí
změnit — ověř, že rebuildAxes(storey) vyprodukuje bit-identické axis jako před migrací
na existujícím testovacím projektu. Editor, elevace, exporty i 3D viewer se chovají
stejně jako předtím. Nic vizuálně nemění.
```

## Fáze 1 — Ortogonální solver + laserové přeměření (jádro)

```
Postav jádro: LiDAR náčrt → laserové přeměření → překreslení. Vyžaduje hotovou fázi 0
(graf rohů). Podle docs/plan-lidar-laser-mereni.md, fáze 1.

1. src/model/types.ts: do Wall přidej measuredLengthMm?: number a dirLocked?: boolean.
2. src/model/geometry.ts: napiš solveOrthogonal(storey):
   - urči globální rotaci θ z převažujícího směru stěn, otoč rohy do rámce,
   - klasifikuj stěny na H/V (osnap směru), nastav dirLocked,
   - rozpad na dvě 1D least-squares úlohy (X, Y): naměřené délky = tvrdé vazby (velká
     váha), LiDAR polohy = měkké kotvy (malá váha); ukotvi jeden roh,
   - rotace zpět.
   Po solve volej rebuildAxes → computeFaceTrims → computeRoomClearPolygons.
3. UI (editor stěny / půdorys): pole pro zadání naměřené délky stěny, plnění z DISTO
   (BLE už v projektu je). Po zadání se model přesolví a překreslí.
4. Vizuální stav stěny: „odhad" (čárkovaně/šedě) vs. „potvrzeno" (plně) podle toho,
   zda má measuredLengthMm. Ukazatel pokrytí „N/M stěn přeměřeno".

AKCEPTAČNÍ KRITÉRIUM: na pravoúhlé místnosti (obdélník i tvar L) zadání naměřených
délek posune sdílené rohy tak, že se sousední stěny pohnou konzistentně (žádné mezery
/ přesahy v rozích). Nepřeměřené stěny zůstanou u LiDAR odhadu. Ověř v editoru i 3D.
```

## Fáze 2 — Obecný solver pro zkosené místnosti

```
Rozšiř solver o neortogonální (zkosené) místnosti. Vyžaduje fázi 1.
Podle docs/plan-lidar-laser-mereni.md, fáze 2.

1. src/model/geometry.ts: napiš solveGeneral(storey) — Gauss–Newton least-squares na
   polohy rohů. Rezidua: naměřené délky stěn (|a−b| = measuredLengthMm), zafixované
   úhly (dirLocked / naměřené), plus slabé kotvy na LiDAR polohy rohů. Start z LiDAR
   poloh. Umožni měřit i úhel/úhlopříčku pro zaškvárování.
2. Rozhodni per-podlaží nebo per-místnost, zda použít solveOrthogonal (vše H/V) nebo
   solveGeneral (existuje zkosená stěna).

AKCEPTAČNÍ KRITÉRIUM: místnost se zkosenou stěnou (např. podkroví v půdorysu, arkýř)
se po zadání naměřených délek + jedné úhlopříčky/úhlu překreslí konzistentně a
rohy se zavřou. Ortogonální místnosti dávají stejný výsledek jako fáze 1.
```

## Fáze 3 — Šikmina střechy (podkroví)

```
Přidej podporu šikmé roviny (podkroví) do modelu a elevace. Vyžaduje fázi 1.
Podle docs/plan-lidar-laser-mereni.md, fáze 3.

1. src/model/types.ts: přidej interface SlopePlane { baseWallId; kneeHeightMm;
   ridgeHeightMm?; runMm?; angleDeg? }. Umísti kolekci šikmin na Storey nebo Room
   (rozhodni dle stávající struktury místností).
2. Geometrie: z měřitelných parametrů (výška kolenní stěny, běh/sklon, výška hřebene)
   spočti šikmou rovinu; LiDAR dá odhad, naměřené hodnoty přebijí.
3. Elevace (src/ui/elevation.ts): vykresli líc stěny ukončený šikminou (ne obdélník)
   — napoj na stávající displayU mašinerii. Trasy/prvky nad šikminou ořízni na rovinu.
4. 3D viewer: zobraz šikmou rovinu místo rovného stropu tam, kde je definována.

AKCEPTAČNÍ KRITÉRIUM: podkrovní místnost s kolenní stěnou a šikminou se v elevaci i 3D
zobrazí se skloněným lícem; zadání naměřené výšky kolenní stěny + sklonu rovinu
přepočte. Kabeláž jde vést a kótovat po šikmině.
```

## Fáze 4 — Import meshe ze skeneru (náhrada magicplanu)

```
Přidej import 3D meshe z mesh skeneru (Polycam / Scaniverse) jako alternativu k
magicplan importu. Vyžaduje fáze 1 a 3. Podle docs/plan-lidar-laser-mereni.md, fáze 4.

1. Parser meshe: OBJ a PLY (v metrech). Nový soubor src/model/mesh-import.ts.
2. Extrakce rovin: z trojúhelníků nafituj velké roviny (RANSAC / region-growing).
3. Klasifikace rovin: vodorovná dole = podlaha, nahoře = strop, svislá = stěna,
   nakloněná = šikmina (SlopePlane z fáze 3).
4. Převod na model: z rovin postav graf rohů (fáze 0) + stěny + šikminy; napoj na
   solver (rohy dostanou lidar odhad, čekají na laserové přeměření).
5. Slícování víc místností podle sdílené reference (společná stěna / ruční zarovnání).

AKCEPTAČNÍ KRITÉRIUM: testovací sken jedné podkrovní místnosti (OBJ/PLY) se naimportuje
jako čistá parametrická místnost se stěnami A/B a šikminou, připravená k laserovému
přeměření. Výstup je srovnatelný nebo lepší než dnešní magicplan import.
```

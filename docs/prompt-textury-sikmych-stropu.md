# Zadání: promítání fotek (textur) na šikmé stropy ve 3D

## Cíl
Ve 3D pohledu podlaží (`src/ui/viewer3d.ts`) promítnout narovnané fotky (podklady)
také na **šikmé stropy** místnosti — stejně, jako se dnes promítají na rovný strop,
podlahu a líc A stěny. Dnes se textura šikminy nezobrazí, i když má plocha šikmého
stropu nafocený podklad.

## Kontext modelu (hotovo, viz paměť „vice-stropu-sikma-plocha")
- Místnost má víc stropů: `Room.ceiling` (rovná část) + `Room.slopeCeilings?: { slopeId, surface: Wall }[]`
  (jedna kreslicí plocha za každou šikminu). Fotky jsou na `surface.faces.A.backgrounds`.
- Plocha šikminy (`slopeCeilingSurface` v `src/model/geometry.ts`) je obdélník:
  **šířka `u` = délka kolenní stěny** (`axisLen(base)`), **výška `v` = skutečná délka po
  sklonu** `slopeTrueLength` = √(běh² + převýšení²). Uloženo shodně jako u stěny:
  fotka v souřadnicích `(u, v)`, strana A.
- 3D už dělí strop na klikatelné kusy: `buildCeilingCaps(storey, room, capH)` vrací pole
  `{ slopeId?, geo, sloped }` — **geometrie kusu šikminy už existuje** a má baked výšky
  vrcholů. Rovná část má `slopeId === undefined`.

## Jak se dnes dělají textury (vzor k napodobení)
V `viewer3d.ts`:
- Smyčka kolem ř. 682: pro `kind ∈ ['floor','ceiling']` vezme `room[kind]`, přes
  `resolveBackgrounds(surf.faces.A, phaseId, true)` získá podklady, `buildRoomTexture` je
  složí do `CanvasTexture` (přes `drawTiles(..., surf, 'A', w, h, ...)`) a `addRoomTexMesh`
  vytvoří plochu ve tvaru půdorysu s vlastním UV a odsazením proti z-fightingu.
- `roomTexMeshes: { mesh, kind }[]` + `setCeilVisible` řídí viditelnost (strop default skrytý).

## Co udělat
1. **Geometrie plochy šikminy pro texturu.** Použij přímo `geo` z `buildCeilingCaps` pro
   daný `slopeId` (už má správný tvar i sklon), NEBO postav vlastní z těžišťové tesselace.
   Doporučení: rozšiř smyčku textur tak, že pro každou místnost projdeš `slopeCeilings`
   a pro každou získáš odpovídající kus z `buildCeilingCaps` (napáruj přes `slopeId`).
2. **UV mapování 3D → (u, v) plochy šikminy.** Pro vrchol na šikmině spočítej:
   - `u` = průmět půdorysného bodu na **osu kolenní stěny** (od `base.axis[0]`), tj.
     `projectToAxis(base, p).u`. Normalizuj `u / surfaceWidth`.
   - `v` = **vzdálenost po sklonu od kolenní stěny** = (kolmá vzdálenost bodu od osy base
     dovnitř) × √(1+grad²) = `planDistInward × slopeTrueLength/slopePlanRun`. Normalizuj
     `v / surfaceHeight`. (Pomůcky: `slopeGradient`, `slopePlanRun`, `slopeTrueLength`,
     `wallNormal`, orientace „dovnitř" jako v `slopeHeightAt`.)
   - Pozor na zrcadlení: strop se dívá zdola (u rovného stropu se dělá `u = 1 − u`).
     U šikminy ověř orientaci proti editoru (strana A, `toDisplay`) tak, aby fotka nebyla
     zrcadlená/vzhůru nohama. Nejlíp empiricky proti reálnému podkladu.
3. **Skládání textury.** Znovupoužij `drawTiles(g, bgs, surf, 'A', w, h, texW, texH, token)`
   s `w = surface.axis[1].x` (šířka) a `h = surface.heightMm` (délka po sklonu) — ne bbox
   místnosti. `buildRoomTexture` je psané na bbox místnosti; udělej variantu/parametr pro
   rozměry plochy.
4. **Mesh + viditelnost + úklid.** Přidej mesh do `roomTexMeshes` s `kind: 'ceiling'`
   (aby ho řídil `setCeilVisible`), materiál `MeshBasicMaterial({ map, side: DoubleSide })`,
   malé odsazení proti z-fightingu (posun podél normály roviny, ne jen `y`, protože je
   skloněná). Textury i geometrie zahrň do `texObjs` / cleanup, ať se uvolní při přerenderu.
5. **Fáze a token.** Respektuj `activePhaseId` (`resolveBackgrounds(..., phaseId, true)`) a
   `token` proti závodění (early `return 'abort'`), stejně jako stávající cesta.

## Okrajové případy
- Šikmina bez podkladu → nic nekreslit (jako dnes `if (!bgs.length) continue`).
- Rovná část stropu už texturu má — neduplikovat.
- Kolenní stěna nenalezena (`baseWallId` neexistuje) → přeskoč.
- `slopeCeilings` je lazy: plocha existuje jen, když ji uživatel aspoň jednou otevřel.
  Bez plochy fotka není → není co promítat (OK).

## Volitelně (navazuje)
- Textura na **seříznutém líci stěny** pod šikminou: mesh stěny má nahoře diagonální ořez
  (`faceCeilingProfile` / `wallTopProfile`), ale nasazená fotka (`addTexPlane`) je obdélník.
  Sjednotit UV/ořez, aby fotka nekoukala nad seříznutou hranu. (Samostatný, menší úkol.)

## Ověření
- `npx tsc --noEmit` čistý.
- Dev server (`.claude/launch.json`, např. `dev4` = port 5477), v konzoli `devAtticRoom()`
  → místnost „Podkroví" se šikminou na stěně aw0. Otevři šikmý strop, nahraj/narovnej
  fotku, ve 3D zapni „🔓 Stropy" a zkontroluj, že fotka sedí na skloněné rovině bez
  zrcadlení, ve správné fázi, a mizí/objeví se s přepínačem stropů.
- Zkontroluj `read_console_messages` (bez chyb) a screenshot skloněné plochy s texturou.

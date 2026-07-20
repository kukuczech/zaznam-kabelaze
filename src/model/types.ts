// Datový model projektu. Všechny délky v milimetrech, souřadnice stěny v (u, v):
// u = vzdálenost podél osy stěny od bodu axis[0], v = výška ode dna podlaží.

export interface XY {
  x: number;
  y: number;
}

/**
 * Uzel půdorysu — sdílený roh, kde se potkává víc stěn. Zdroj pravdy pro polohu
 * konců stěn; `Wall.axis` se z rohů dopočítává (rebuildAxes). `lidar` je původní
 * odhad (kotva pro pozdější solver); v současné fázi (identita) se osy nepřepisují.
 */
export interface Corner {
  id: string;
  /** mm, aktuální (po solve) poloha. */
  x: number;
  y: number;
  /** Původní odhad z LiDARu / importu — kotva pro solver. */
  lidar?: XY;
}

/**
 * Naměřená úhlopříčka (mm) mezi dvěma rohy — tvrdá vazba pro obecný solver (fáze 2).
 * Fixuje tvar zkosené / neortogonální místnosti: samotné délky stěn nechávají
 * čtyřúhelník „viklat se", jedna změřená úhlopříčka ho zaškvárkuje. `lengthMm` je
 * naměřená pravda (laserem), LiDAR jen počáteční odhad polohy rohů.
 */
export interface Diagonal {
  id: string;
  /** id rohu (Storey.corners). */
  a: string;
  b: string;
  lengthMm: number;
}

/**
 * Šikmá střešní rovina (podkroví) navázaná na kolenní (nadezdívkovou) stěnu.
 * U osy `baseWall` je strop ve výšce `kneeHeightMm`; kolmo DOVNITŘ místnosti rovina
 * stoupá sklonem `angleDeg` (nebo během `runMm` k `ridgeHeightMm`) až po hřeben,
 * kde se zastropí na `ridgeHeightMm`. Není součástí 2D solveru — samostatná svislá
 * parametrizace (viz docs/plan-lidar-laser-mereni.md, fáze 3). LiDAR dá počáteční
 * odhad, naměřené hodnoty (laser) přebíjí.
 */
export interface SlopePlane {
  id: string;
  /** Kolenní (nadezdívková) stěna, od jejíž osy šikmina stoupá (Wall.id). */
  baseWallId: string;
  /** Výška nadezdívky / kolenní stěny (mm) — výška stropu u base stěny. */
  kneeHeightMm: number;
  /** Výška hřebene (mm) — strop se výš než sem nezvedne. Chybí = stoupá bez zastropení. */
  ridgeHeightMm?: number;
  /** Vodorovný běh od base stěny k hřebeni (mm) — s ridgeHeightMm určuje stoupání. */
  runMm?: number;
  /** Sklon roviny (°) od vodorovné — alternativa k runMm+ridgeHeightMm; má přednost. */
  angleDeg?: number;
}

/** Strana stěny: A = kanonická (proti normále), B = protilehlý líc. */
export type WallSide = 'A' | 'B';

export interface Project {
  id: string;
  name: string;
  storeys: Storey[];
  categories: Category[];
  /** Fáze fotografování stěn (neomítnuté / omítnuté / …) — číselník pro třídění podkladů. */
  photoPhases: PhotoPhase[];
  /** Aktivně zvolená fáze pro vizualizaci (3D textury, náhledy). undefined = automaticky (aktivní podklad). */
  activePhaseId?: string;
  /** Vlastní pořadí typů prvků v paletě (globální seznam); chybějící typy se doplní na konec. */
  fixtureOrder?: FixtureKind[];
  /**
   * Id stavebních (built-in) vrstev, které projekt už někdy dostal migrací — aby se
   * nově zavedená výchozí vrstva doplnila právě jednou a ručně smazaná se nevracela.
   */
  builtInCatsSeen?: string[];
}

/** Fáze stavby, do které patří fotka stěny — umožní hromadně přepnout, co se ukazuje. */
export interface PhotoPhase {
  id: string;
  name: string;
}

export const DEFAULT_PHOTO_PHASES: PhotoPhase[] = [
  { id: 'neomitnute', name: 'Neomítnuté' },
  { id: 'omitnute', name: 'Omítnuté' },
  { id: 'hotove', name: 'Hotové' },
];

export interface Storey {
  id: string;
  name: string;
  /** Výchozí výška stěn podlaží (mm) — fallback, každá stěna má vlastní. */
  wallHeightMm: number;
  walls: Wall[];
  /** Místnosti podlaží (z IFCSLAB) — půdorysná plocha, ve 3D podlaha i strop. */
  rooms?: Room[];
  /**
   * Topologický graf rohů půdorysu (zdroj pravdy pro polohu konců stěn).
   * undefined = starý projekt před migrací; buildCornerGraph ho dopočítá.
   */
  corners?: Corner[];
  /**
   * Naměřené úhlopříčky mezi rohy — zaškvárkují tvar zkosené místnosti pro obecný
   * solver (fáze 2). undefined / prázdné = žádná; u pravoúhlých místností se nepoužije.
   */
  diagonals?: Diagonal[];
  /**
   * Šikmé střešní roviny podkroví (fáze 3) — každá navázaná na kolenní stěnu.
   * undefined / prázdné = rovný strop ve výšce wallHeightMm.
   */
  slopes?: SlopePlane[];
  /**
   * Sběrné podlaží pro FOTOSTĚNY — samostatně vyfocené stěny bez 3D modelu
   * (rychlý zákres, když není čas na sken). Nemá půdorys ani rohy, ve 3D se
   * neotvírá; na titulce má vlastní kartu a klik vede rovnou do elevace.
   */
  photoWalls?: boolean;
}

/** ID sběrného podlaží fotostěn — pevné, aby se v projektu nikdy nezaložilo dvakrát. */
export const PHOTO_STOREY_ID = 'fotosteny';

/** Místnost podlaží: půdorysný polygon (podlaha), ve 3D se z něj kreslí podlaha i strop. */
export interface Room {
  id: string;
  /** Lidský název, např. „Obývák". */
  name: string;
  /** Volitelná poznámka k místnosti. */
  note?: string;
  /** Půdorysný obrys podlahy (mm), z IFCSLAB — vnější (líce vnějších stěn). */
  polygon: XY[];
  /**
   * Světlý (vnitřní) obrys místnosti — slab nasunutý dovnitř o tloušťku stěn.
   * Rozměry sedí s naměřenými (světlá míra). Používá ho kreslicí plocha podlahy/
   * stropu (roomSurface). Dopočítá computeRoomClearPolygons; chybí-li, bere polygon.
   */
  clearPolygon?: XY[];
  /** Kreslicí plocha podlahy (trasy/kóty/prvky) — vzniká na vyžádání při otevření. */
  floor?: Wall;
  /**
   * Kreslicí plocha ROVNÉHO stropu (vodorovná část ve výšce podlaží) — samostatná
   * od podlahy, vzniká na vyžádání. Šikmé části mají vlastní plochy v slopeCeilings.
   */
  ceiling?: Wall;
  /**
   * Šikmé stropy podkroví jako samostatné kreslicí plochy — jedna za každou šikminu
   * (SlopePlane) nad místností. Místnost tak může mít víc stropů: rovnou část +
   * plochu na každou šikminu. Vzniká na vyžádání; slopeId váže na Storey.slopes.
   */
  slopeCeilings?: RoomSlopeCeiling[];
}

/** Kreslicí plocha jednoho šikmého stropu místnosti, navázaná na šikminu podlaží. */
export interface RoomSlopeCeiling {
  /** SlopePlane.id, ke kterému plocha patří. */
  slopeId: string;
  /** Kreslicí plocha (obdélník: šířka = délka kolenní stěny, výška = délka po sklonu). */
  surface: Wall;
}

/**
 * Jeden líc stěny (strana A nebo B). Fyzická stěna mezi dvěma místnostmi má dvě
 * nezávislé tváře — na každou se šlicuje, kótuje a osazuje zvlášť. Souřadnice
 * (u, v) jsou vždy kanonické (u od axis[0]); zobrazení strany B zrcadlí toDisplay.
 */
export interface WallFace {
  photoIds: string[];
  routes: Route[];
  dims: Dimension[];
  /** Osazené prvky (zásuvky, vypínače, čidla…) umístěné na této straně. */
  fixtures: Fixture[];
  /** Plošné konstrukce na této straně — výdřevy (nosné desky v SDK) jako obdélníky. */
  areas: WallArea[];
  /**
   * Perspektivně narovnané fotky této strany položené jako podklad čelního pohledu.
   * Víc fotek (např. různé fáze stavby) — přepíná se activeBackgroundId.
   */
  backgrounds: WallBackground[];
  /** ID zobrazeného podkladu z backgrounds; když chybí, bere se první. */
  activeBackgroundId?: string;
}

/** Prázdná tvář stěny (bez tras, kót, prvků…). */
export function emptyFace(): WallFace {
  return { photoIds: [], routes: [], dims: [], fixtures: [], areas: [], backgrounds: [] };
}

export interface Wall {
  id: string;
  ifcGuid: string;
  /** Lidský název, např. „Stěna 12". */
  name: string;
  /** Volitelná poznámka ke stěně. */
  note?: string;
  /**
   * Osa stěny v půdorysu podlaží (mm). Kanonický pohled: osa zleva doprava, díváme
   * se ze strany levotočivé normály. Od fáze grafu rohů je to DOPOČÍTANÉ pole
   * (rebuildAxes z rohů a/b); ručně se needituje. Dokud solver = identita, drží
   * původní hodnotu z importu.
   */
  axis: [XY, XY];
  /** ID rohu na konci axis[0] (Storey.corners). undefined u starých dat / kreslicích ploch. */
  a?: string;
  /** ID rohu na konci axis[1] (Storey.corners). */
  b?: string;
  /**
   * Naměřená délka stěny (mm) laserem (DISTO) — tvrdá vazba pro solver: |a−b| se
   * drží na této hodnotě. undefined = jen LiDAR odhad („odhad"); vyplněno = „potvrzeno".
   * Naměřená hodnota je vždy pravda, LiDAR jen počáteční odhad.
   */
  measuredLengthMm?: number;
  /** Směr osy zafixován (90° osnap nebo naměřeno) — solver úhel nemění. */
  dirLocked?: boolean;
  thicknessMm: number;
  heightMm: number;
  /**
   * Ořez viditelného líce [konec u axis[0], konec u axis[1]] v mm, ZVLÁŠŤ pro
   * stranu A a B. V rohu je líc zazděný sousední kolmou stěnou o ½ její tloušťky;
   * u konvexního rohu se líc zkracuje (kladné), u reflexního (výklenek) prodlužuje
   * (záporné) — a znaménko se liší podle strany, proto per-líc. `axis` zůstává
   * střednicí (kvůli 3D a otvorům); editor/exporty kreslí jen viditelný líc.
   * Dopočítá computeFaceTrims; chybí-li, bere se 0 (= celá střednice).
   */
  faceTrim?: Record<WallSide, [number, number]>;
  /** Otvory (dveře/okna) — sdílené, procházejí oběma líci stěny. */
  openings: Opening[];
  /**
   * Jen u kreslicích ploch místnosti (podlaha/strop): obrys místnosti v lokálních
   * souřadnicích (u, v) — kreslí se jako vodítko, protože plocha sama je obdélník
   * ohraničení půdorysu. U běžných stěn undefined.
   */
  planOutline?: XY[];
  /**
   * Plocha BEZ MĚŘÍTKA — fotostěna. Rozměry (`axis`, `heightMm`) jsou jen poměr
   * stran fotky, ne skutečné milimetry. Kóta je proto pouhý POPISEK naměřené
   * hodnoty: nic neposouvá a nehlásí rozpor s geometrií (viz applyDimValue
   * v elevation.ts a `conflict` ve wall-svg.ts). Kreslí se jen líc A.
   */
  freeScale?: boolean;
  /** Dva nezávislé líce stěny — obsah (trasy, kóty, prvky, podklady) je pro každý zvlášť. */
  faces: Record<WallSide, WallFace>;
}

export interface WallBackground {
  /** Vlastní ID podkladu (stabilní i při doladění perspektivy). */
  id: string;
  /** Uživatelský popisek, např. „před omítkou". */
  label?: string;
  /** Fáze stavby, do níž fotka patří (Project.photoPhases). Umožní hromadné přepnutí zobrazení. */
  phaseId?: string;
  /** ID narovnaného obrázku v úložišti fotek (savePhoto/getPhoto). */
  photoId: string;
  /** Průhlednost podkladu 0–1. */
  opacity: number;
  /** ID původní (nenarovnané) fotky — umožňuje pozdější doladění perspektivy. */
  sourcePhotoId?: string;
  /**
   * Body označené ve zdrojové fotce (px zdroje, po případném otočení dle `rotDeg`).
   * Stěna: 4 rohy líce v pořadí TL,TR,BR,BL. Podlaha/strop: rohy místnosti
   * v pořadí `planOutline` (least-squares homografie) — umožní pozdější doladění.
   */
  corners?: XY[];
  /** Otočení zdrojové fotky (0/90/180/270°) použité před označením bodů. */
  rotDeg?: number;
  /** Vodorovné zrcadlení zdrojové fotky při pasování. */
  mirror?: boolean;
  /** Jak dlaždice vznikla (pro „🔧 Doladit"): rect = narovnat podle obdélníku, crop = oříznout mnohoúhelníkem. */
  fitMode?: 'rect' | 'crop';
  /**
   * Oblast líce (u, v mm), kterou tato fotka pokrývá — dlaždice. Chybí = celá zeď.
   * Střed + rozměry (jako WallArea). Umožní na velkou zeď nalepit víc fotek vedle
   * sebe, každou na svůj výřez. Fotka se do obdélníku regionu roztáhne. `rotDeg` =
   * volné otočení dlaždice kolem středu v zobrazovacích souřadnicích (po směru hodin)
   * — pro ruční skládání víc fotek podlahy/stropu nafocených z různých úhlů.
   */
  region?: { uMm: number; vMm: number; widthMm: number; heightMm: number; rotDeg?: number };
  /**
   * Volné rohy dlaždice (corner‑pin) — 4 body líce (u, v mm) v pořadí TL,TR,BR,BL
   * (zobrazovací orientace). Fotka se do tohoto čtyřúhelníku vykreslí PERSPEKTIVNĚ
   * (přes 2 trojúhelníky). Umožní slícovat partial fotky s reziduální perspektivou.
   * Když je zadán, má přednost před `region`. Chybí = obdélníková dlaždice.
   */
  quad?: XY[];
  /**
   * Síťová deformace (mesh) — mnohoúhelník s typovanými vrcholy pro ořez i
   * perspektivu zároveň. `src` = vrcholy v [0,1] normovaně na (orientovaný) zdroj
   * (tvar výřezu); `dst` = tytéž vrcholy v (u,v) mm na líci (kam se promítnou);
   * `anchor[i]` = true → roh/kotva (táhne se na skutečný roh, řídí zkosení), false →
   * jen ořezový bod (volný, tvaruje masku). Fotka se promítne trojúhelníkově
   * (per‑triangle afinně) a ořízne na tvar. Má přednost před quad/region.
   */
  mesh?: { src: XY[]; dst: XY[]; anchor: boolean[] };
}

/**
 * Vybere podklad líce stěny pro vizualizaci (3D, exporty):
 * 1) když je zadaná fáze a líc v ní podklad má → ten,
 * 2) při `strict` a zvolené fázi bez shody → undefined (nezobrazí cizí fázi),
 * 3) jinak ručně zvolený activeBackgroundId,
 * 4) jinak první dostupný. Vrací undefined, když líc žádný podklad nemá.
 */
export function resolveBackground(face: WallFace, phaseId?: string, strict = false): WallBackground | undefined {
  if (!face.backgrounds?.length) return undefined;
  if (phaseId) {
    const inPhase = face.backgrounds.find((b) => b.phaseId === phaseId);
    if (inPhase) return inPhase;
    if (strict) return undefined; // zvolená fáze, ale líc v ní fotku nemá → nic
  }
  return face.backgrounds.find((b) => b.id === face.activeBackgroundId) ?? face.backgrounds[0];
}

/**
 * Podklady líce ke SLOŽENÍ v pořadí odspodu nahoru. V jedné vrstvě (fázi) jsou
 * všechny textury rovnocenné — žádný „primární" — a skládají se dohromady:
 *   1) zvolená fáze → všechny podklady té fáze (strict + žádná shoda = nic),
 *   2) jinak všechny podklady STEJNÉ fáze jako aktivní/první (aby se nemíchaly
 *      různé fáze). Každý se pak vykreslí přes celou zeď, nebo na svůj `region`.
 * Prázdné pole = líc žádný podklad nemá.
 */
export function resolveBackgrounds(face: WallFace, phaseId?: string, strict = false): WallBackground[] {
  const bgs = face.backgrounds;
  if (!bgs?.length) return [];
  if (phaseId) {
    const inPhase = bgs.filter((b) => b.phaseId === phaseId);
    if (inPhase.length) return inPhase;
    if (strict) return []; // zvolená fáze, ale líc v ní fotku nemá → nic
  }
  const active = bgs.find((b) => b.id === face.activeBackgroundId) ?? bgs[0];
  return bgs.filter((b) => b.phaseId === active.phaseId);
}

/** Otvor ve stěně; (uMm, vMm) je STŘED otvoru v souřadnicích stěny. */
export interface Opening {
  kind: 'door' | 'window';
  uMm: number;
  vMm: number;
  widthMm: number;
  heightMm: number;
}

export interface Route {
  id: string;
  categoryId: string;
  /** Šířka šlicu — koridor, kde se nesmí vrtat. */
  widthMm: number;
  note: string;
  points: XY[]; // v souřadnicích (u, v) — XY.x = u, XY.y = v
  /** Naměřená délka segmentu i (points[i] → points[i+1]); null = jen klikaná geometrie. */
  segLengthsMm: (number | null)[];
}

/**
 * Plošná konstrukce na stěně (výdřeva = nosná deska zapuštěná do SDK, aby na ni
 * šlo pověsit polici/TV). Obdélník zarovnaný s osami; (uMm, vMm) je jeho STŘED.
 */
export interface WallArea {
  id: string;
  /** Vrstva (kategorie) — řídí viditelnost i barvu. Výchozí „vydreva“. */
  categoryId: string;
  /** Střed desky v souřadnicích stěny (mm). */
  uMm: number;
  vMm: number;
  widthMm: number;
  heightMm: number;
  /** Volitelný popisek (např. „pod TV“). */
  note?: string;
  /**
   * Vazba nosníku do bloku vloženého wizardem (stropní / SDK nosníky). Chybí =
   * samostatná výdřeva. Nosníky jednoho bloku sdílejí `beamGroupId`; hýbou se jako
   * celek a kóta k jednomu z nich přebíjí rozteč (viz reflowBeamGroup v elevation).
   */
  beamGroupId?: string;
  /** Pořadí nosníku v bloku podél osy skladu (0..n−1). */
  beamIndex?: number;
  /**
   * Osa skladu bloku: 'u' = nosníky běží svisle (délka ve v), stohované vodorovně;
   * 'v' = nosníky běží vodorovně (délka v u), stohované svisle. Délka běží kolmo
   * na tuto osu, přes celé plátno. Rozteč (beamSpacingMm) platí podél této osy.
   */
  beamAxis?: 'u' | 'v';
  /**
   * Osová rozteč sousedních nosníků bloku (mm) jako ZNAMÉNKOVÝ krok v ose skladu na
   * +1 beamIndex — záporná, když je index srovnaný proti orientaci osy (kvůli
   * zrcadlení displayU), aby index rostl v pořadí na obrazovce. |hodnota| = rozteč.
   */
  beamSpacingMm?: number;
  /** Nosník má vlastní kótu → je pevný, reflow ho nehýbe (kóta má přednost před roztečí). */
  beamPinned?: boolean;
}

export type Anchor =
  | { kind: 'routePoint'; routeId: string; index: number }
  /** Bod na úsečce trasy: segment index → index+1, t ∈ ⟨0,1⟩ podél něj. Drží se trasy. */
  | { kind: 'routeSeg'; routeId: string; index: number; t: number }
  /** Osazený prvek — kotva drží jeho střed. */
  | { kind: 'fixture'; fixtureId: string }
  /** Bod výdřevy: střed (du=dv=0) nebo roh (du,dv ∈ {−1,1}) jako násobek půl-rozměru od středu. */
  | { kind: 'area'; areaId: string; du: -1 | 0 | 1; dv: -1 | 0 | 1 }
  | { kind: 'edge'; edge: 'top' | 'bottom' | 'left' | 'right' }
  | { kind: 'point'; uMm: number; vMm: number };

/** Typy osazovaných prvků (paleta). */
export type FixtureKind =
  | 'socket'   // zásuvka
  | 'touch'    // Touch Pure (Loxone) — nástěnný ovladač
  | 'switch'   // tlačítko (momentové)
  | 'lightswitch' // vypínač (klasický on/off)
  | 'light'    // vývod na světlo
  | 'panel'    // rozvaděč
  | 'speaker'  // vývod repro
  | 'spkmaster' // aktivní reproduktor — master (napájení + signál)
  | 'spkslave'  // aktivní reproduktor — slave (propojení z masteru)
  | 'data'     // datová zásuvka
  | 'flood'    // čidlo zaplavení
  | 'magnet'   // magnetický kontakt
  | 'doorbell' // domácí vrátný / video zvonek (dveřní stanice)
  | 'ac'       // klimatizace
  | 'shutter'  // vývod roleta
  | 'presence' // Loxone Presence Sensor (stropní přítomnostní čidlo)
  | 'nfc'      // Loxone NFC Code Touch (přístup u dveří)
  | 'tablet'   // nástěnný tablet (iPad) — centrální ovládání Loxone
  | 'valve'    // roháček na vodu
  | 'faucet'   // vodovodní baterie
  | 'bidet'    // bidetová baterie
  | 'geberit'  // závěsný systém Geberit
  | 'drain'    // kanálek / podlahový žlab (lineární)
  | 'drainsq'  // podlahová vpust čtvercová
  | 'drainround' // podlahová vpust kulatá
  | 'washsiphon' // sifon pračkový (podomítkový)
  | 'sinkoutlet'; // vývod na dřez (odpad + voda)

/** Prvek osazený na stěně; (uMm, vMm) je jeho STŘED v souřadnicích stěny. */
export interface Fixture {
  id: string;
  kind: FixtureKind;
  /** Vrstva prvku (kategorie) — určuje jeho viditelnost. Barva symbolu jde podle kind. */
  categoryId: string;
  uMm: number;
  vMm: number;
  /** Šířka prvku (mm); když chybí, bere se výchozí rozměr typu. */
  widthMm?: number;
  /** Výška prvku (mm); když chybí, bere se výchozí rozměr typu. */
  heightMm?: number;
  /** Označení / číslo prvku dle projektu (např. „Z1", „SA3", „1.12"). */
  code?: string;
  /** Volitelný uživatelský popisek; když chybí, bere se výchozí název typu. */
  label?: string;
}

/** Tvar značky prvku: obdélník (většina) nebo kruh/elipsa (repro, světlo, čidla). */
export type FixtureShape = 'rect' | 'round';

export interface FixtureDef {
  label: string;
  color: string;
  shape: FixtureShape;
  /** Výchozí šířka a výška prvku (mm). */
  wMm: number;
  hMm: number;
}

/** Metadata palety — pořadí zde určuje pořadí v paletě; rozměry jsou orientační. */
export const FIXTURE_DEFS: Record<FixtureKind, FixtureDef> = {
  socket: { label: 'Zásuvka', color: '#f43f5e', shape: 'rect', wMm: 80, hMm: 80 },
  touch: { label: 'Touch Pure', color: '#2dd4bf', shape: 'rect', wMm: 90, hMm: 90 },
  switch: { label: 'Tlačítko', color: '#f97316', shape: 'rect', wMm: 80, hMm: 80 },
  lightswitch: { label: 'Vypínač', color: '#fb923c', shape: 'rect', wMm: 80, hMm: 80 },
  light: { label: 'Světlo', color: '#fbbf24', shape: 'round', wMm: 120, hMm: 120 },
  panel: { label: 'Rozvaděč', color: '#94a3b8', shape: 'rect', wMm: 400, hMm: 600 },
  speaker: { label: 'Repro', color: '#a855f7', shape: 'round', wMm: 165, hMm: 165 },
  spkmaster: { label: 'Aktiv. repro (M)', color: '#a855f7', shape: 'rect', wMm: 150, hMm: 240 },
  spkslave: { label: 'Aktiv. repro (S)', color: '#c084fc', shape: 'rect', wMm: 150, hMm: 240 },
  data: { label: 'Data', color: '#3b82f6', shape: 'rect', wMm: 80, hMm: 80 },
  flood: { label: 'Zaplavení', color: '#06b6d4', shape: 'round', wMm: 90, hMm: 90 },
  magnet: { label: 'Magnet. kontakt', color: '#84cc16', shape: 'rect', wMm: 90, hMm: 40 },
  doorbell: { label: 'Video zvonek', color: '#ec4899', shape: 'rect', wMm: 100, hMm: 160 },
  ac: { label: 'Klimatizace', color: '#38bdf8', shape: 'rect', wMm: 800, hMm: 280 },
  shutter: { label: 'Roleta', color: '#d97706', shape: 'round', wMm: 50, hMm: 50 },
  presence: { label: 'Presence', color: '#22c55e', shape: 'round', wMm: 80, hMm: 80 },
  nfc: { label: 'NFC Code Touch', color: '#4ade80', shape: 'rect', wMm: 80, hMm: 80 },
  tablet: { label: 'Tablet (iPad)', color: '#10b981', shape: 'rect', wMm: 250, hMm: 175 },
  valve: { label: 'Roháček', color: '#22d3ee', shape: 'round', wMm: 45, hMm: 45 },
  faucet: { label: 'Baterie', color: '#0ea5e9', shape: 'rect', wMm: 150, hMm: 120 },
  bidet: { label: 'Bidet. baterie', color: '#818cf8', shape: 'rect', wMm: 150, hMm: 120 },
  geberit: { label: 'Geberit', color: '#64748b', shape: 'rect', wMm: 500, hMm: 1120 },
  drain: { label: 'Kanálek žlab', color: '#57534e', shape: 'rect', wMm: 700, hMm: 70 },
  drainsq: { label: 'Vpust čtverc.', color: '#6b7280', shape: 'rect', wMm: 150, hMm: 150 },
  drainround: { label: 'Vpust kulatá', color: '#78716c', shape: 'round', wMm: 150, hMm: 150 },
  washsiphon: { label: 'Sifon pračka', color: '#78716c', shape: 'rect', wMm: 100, hMm: 100 },
  sinkoutlet: { label: 'Vývod na dřez', color: '#a8a29e', shape: 'rect', wMm: 90, hMm: 90 },
};

export const FIXTURE_KINDS = Object.keys(FIXTURE_DEFS) as FixtureKind[];

/** Efektivní rozměry prvku (mm) — vlastní hodnoty, jinak výchozí z typu. */
export function fixtureSize(f: Fixture): { w: number; h: number } {
  const def = FIXTURE_DEFS[f.kind];
  return { w: f.widthMm ?? def.wMm, h: f.heightMm ?? def.hMm };
}

/** Popisek pod značkou prvku: číslo/označení a popisek; když chybí, název typu. */
export function fixtureCaption(f: Fixture): string {
  const parts: string[] = [];
  if (f.code?.trim()) parts.push(f.code.trim());
  if (f.label?.trim()) parts.push(f.label.trim());
  return parts.length ? parts.join(' · ') : FIXTURE_DEFS[f.kind].label;
}

export interface Dimension {
  id: string;
  from: Anchor;
  to: Anchor;
  /** Naměřená hodnota; null = zobrazit geometrickou vzdálenost. */
  valueMm: number | null;
}

export interface Category {
  id: string;
  name: string;
  color: string;
  /** Viditelnost vrstvy; undefined/true = zobrazená, false = skrytá. */
  visible?: boolean;
}

/** Vrstva je viditelná, dokud není výslovně skrytá. */
export function isCategoryVisible(cat: Category | undefined): boolean {
  return cat?.visible !== false;
}

/**
 * Komparátor pro řazení kreslených prvků (tras, výdřev, osazených prvků) podle
 * pořadí vrstev. Pořadí vrstvy = její index v `categories`; vrstva výše v seznamu
 * (menší index) se vykreslí NAVRCHU. V renderu (SVG/PDF/DXF) se kreslí odspodu
 * nahoru, proto řadíme SESTUPNĚ dle indexu — vrstva na indexu 0 se emituje jako
 * poslední, tedy leží na vrchu. Řazení je stabilní (Array.sort), takže v rámci
 * jedné vrstvy zůstává pořadí vložení. Prvek s neznámou vrstvou padá naspod.
 */
export function byLayerOrder(
  categories: Category[],
): (a: { categoryId: string }, b: { categoryId: string }) => number {
  const rank = new Map(categories.map((c, i) => [c.id, i]));
  const r = (id: string): number => rank.get(id) ?? Number.MAX_SAFE_INTEGER;
  return (a, b) => r(b.categoryId) - r(a.categoryId);
}

export const DEFAULT_CATEGORIES: Category[] = [
  { id: 'silnoproud', name: 'Silnoproud', color: '#e11d48' },
  { id: 'slaboproud', name: 'Slaboproud', color: '#f59e0b' },
  { id: 'loxone', name: 'Loxone', color: '#16a34a' },
  // Voda i odpad (ZTI) v jedné vrstvě — id zůstává 'voda' kvůli zpětné kompatibilitě.
  { id: 'voda', name: 'Voda a odpad', color: '#2563eb' },
  { id: 'topeni', name: 'Topení', color: '#9333ea' },
  // Stavební (nevyhýbá se jim vrtání jako u rozvodů — jen dokumentace konstrukce).
  { id: 'nosnik-sdk', name: 'Nosníky SDK', color: '#a3a3a3' },
  { id: 'nosnik-strop', name: 'Stropní nosníky', color: '#57534e' },
  { id: 'vydreva', name: 'Výdřevy', color: '#b45309' },
];

/**
 * Kanonická vrstva každého typu prvku — jediný zdroj pravdy pro mapování
 * prvek → vrstva. Řídí filtr palety (které ikony patří dané vrstvě) i výchozí
 * vrstvu nově osazeného prvku. Uživatel může prvku vrstvu kdykoli ručně změnit.
 */
export const FIXTURE_LAYER: Record<FixtureKind, string> = {
  socket: 'silnoproud',
  switch: 'silnoproud',
  lightswitch: 'silnoproud',
  light: 'silnoproud',
  panel: 'silnoproud',
  ac: 'silnoproud',
  shutter: 'silnoproud',
  data: 'slaboproud',
  speaker: 'slaboproud',
  spkmaster: 'slaboproud',
  spkslave: 'slaboproud',
  flood: 'slaboproud',
  magnet: 'slaboproud',
  doorbell: 'slaboproud',
  touch: 'loxone',
  presence: 'loxone',
  nfc: 'loxone',
  tablet: 'loxone',
  valve: 'voda',
  faucet: 'voda',
  bidet: 'voda',
  geberit: 'voda',
  drain: 'voda',
  drainsq: 'voda',
  drainround: 'voda',
  washsiphon: 'voda',
  sinkoutlet: 'voda',
};

/** Výchozí vrstva nově osazeného prvku podle jeho typu. */
export function defaultCategoryForFixture(kind: FixtureKind): string {
  return FIXTURE_LAYER[kind];
}

/** Vrstvy, které mají alespoň jeden typ prvku (pro filtr palety) — v pořadí DEFAULT_CATEGORIES. */
export function fixtureLayerIds(): string[] {
  const used = new Set(FIXTURE_KINDS.map((k) => FIXTURE_LAYER[k]));
  return DEFAULT_CATEGORIES.filter((c) => used.has(c.id)).map((c) => c.id);
}

/**
 * Typy prvků dané vrstvy, seřazené podle volitelného globálního pořadí `order`
 * (typy mimo `order` se doplní na konec v pořadí FIXTURE_KINDS). Sdílené paletou
 * i panelem řazení.
 */
export function fixtureKindsForLayer(catId: string, order?: FixtureKind[]): FixtureKind[] {
  const ranked = order && order.length
    ? [...order.filter((k) => FIXTURE_KINDS.includes(k)),
       ...FIXTURE_KINDS.filter((k) => !order.includes(k))]
    : FIXTURE_KINDS;
  return ranked.filter((k) => FIXTURE_LAYER[k] === catId);
}

export function newId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/**
 * Natočí polygon tak, aby jeho NEJDELŠÍ hrana ležela vodorovně — kreslicí plocha
 * (bounding box) pak není zešikmená vůči osám X/Y a těsněji obepíná místnost.
 * Rotujeme nejmenším úhlem (|α| ≤ 90°), ať se plocha nepřevrátí vzhůru nohama.
 * Zbyde jen reálná nepravoúhlost místnosti (když stěny nesvírají přesně 90°).
 */
function orientToLongestEdge(poly: XY[]): XY[] {
  let bestLen = -1, angle = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 > bestLen) { bestLen = len2; angle = Math.atan2(dy, dx); }
  }
  if (angle > Math.PI / 2) angle -= Math.PI;
  else if (angle < -Math.PI / 2) angle += Math.PI;
  const c = Math.cos(-angle), s = Math.sin(-angle);
  return poly.map((p) => ({ x: p.x * c - p.y * s, y: p.x * s + p.y * c }));
}

/**
 * Kreslicí plocha podlahy/stropu místnosti jako „stěna" v půdorysu: obdélník =
 * ohraničení (bounding box) půdorysu místnosti, u = X, v = Y. Editor stěny pak
 * funguje beze změny; skutečný obrys místnosti se kreslí jako vodítko (planOutline).
 */
export function roomSurface(room: Room, kind: 'floor' | 'ceiling'): Wall {
  // Kreslí se světlý (vnitřní) obrys — rozměry sedí s naměřenými; fallback na slab.
  const poly = room.clearPolygon?.length ? room.clearPolygon : room.polygon;
  // Srovnat natočení místnosti (nejdelší stěna vodorovně), ať plátno neleží šikmo.
  const rot = orientToLongestEdge(poly);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of rot) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  const w = Math.max(1, Math.round(maxX - minX));
  const h = Math.max(1, Math.round(maxY - minY));
  return {
    id: newId(),
    ifcGuid: '',
    name: `${room.name} — ${kind === 'floor' ? 'podlaha' : 'strop'}`,
    axis: [{ x: 0, y: 0 }, { x: w, y: 0 }],
    thicknessMm: 0,
    heightMm: h,
    openings: [],
    // Obrys po srovnání natočení, posunutý do počátku (u = X, v = Y v otočené soustavě).
    planOutline: rot.map((p) => ({ x: Math.round(p.x - minX), y: Math.round(p.y - minY) })),
    // Podlaha/strop se kreslí jen z jedné strany (A); B zůstává prázdná.
    faces: { A: emptyFace(), B: emptyFace() },
  };
}

/** Všechny existující kreslicí plochy místnosti: podlaha, rovný strop a šikmé stropy. */
export function roomSurfaces(room: Room): Wall[] {
  const out: Wall[] = [];
  if (room.floor) out.push(room.floor);
  if (room.ceiling) out.push(room.ceiling);
  for (const sc of room.slopeCeilings ?? []) if (sc.surface) out.push(sc.surface);
  return out;
}

/**
 * Nominální šířka fotostěny (mm). Fotka měřítko nemá, ale rozměry musí být řádově
 * „jako stěna" — kótovací čáry, šipky i písmo mají v SVG absolutní velikost v mm,
 * takže na ploše 4 m široké vycházejí čitelně stejně jako u skutečné stěny.
 */
export const PHOTO_WALL_WIDTH_MM = 4000;

/**
 * Kreslicí plocha z fotografie („fotostěna") — obdélník s poměrem stran fotky.
 * Jen líc A, bez tloušťky a bez měřítka (freeScale). Editor stěny, exporty i ZIP
 * s ní pak pracují úplně stejně jako se skutečnou stěnou.
 */
export function photoWallSurface(name: string, aspect: number): Wall {
  const w = PHOTO_WALL_WIDTH_MM;
  const h = Math.max(1, Math.round(w / (aspect > 0 ? aspect : 1)));
  return {
    id: newId(),
    ifcGuid: '',
    name,
    axis: [{ x: 0, y: 0 }, { x: w, y: 0 }],
    thicknessMm: 0,
    heightMm: h,
    openings: [],
    freeScale: true,
    faces: { A: emptyFace(), B: emptyFace() },
  };
}

/** Sběrné podlaží fotostěn; `create` = založit, když ještě není. */
export function photoStorey(project: Project, create = false): Storey | undefined {
  let s = project.storeys.find((x) => x.photoWalls);
  if (!s && create) {
    s = { id: PHOTO_STOREY_ID, name: 'Fotostěny', wallHeightMm: 2700, walls: [], photoWalls: true };
    project.storeys.push(s);
  }
  return s;
}

export function emptyProject(): Project {
  return {
    id: newId(),
    name: 'Můj dům',
    storeys: [],
    categories: structuredClone(DEFAULT_CATEGORIES),
    photoPhases: structuredClone(DEFAULT_PHOTO_PHASES),
  };
}

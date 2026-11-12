// "CompX-B" driver: the report-8, 16-byte, 0x55-checksum protocol that CompX (the ODM) ships on
// Pulsar's Nordic mice and on VXE / ATK / VGN / Kysona / Scyrox / Lamzu Atlantis / Teevolution.
// Layout from Pulsar's own web app (bbb.pulsar.gg/cMouse: cfg.json, sensor.json, devicename.json),
// ATK HUB, Scyrox S-center and VGN HUB (the same CompX web-app family), checked against
// pulsar-mouse-linux, the Linux hid-pulsar / hid-kysona drivers and OpenMouse's notes.
//
// Frame (16 data bytes after report id 8):
//   [cmd, status, addrHi, addrLo, len, payload x10, checksum]
//   checksum = 0x55 - (8 + sum of the first 15 bytes)  (mod 256)
// Settings live in a per-profile memory map read with cmd 0x08 and written with cmd 0x07.
// Single-byte settings are stored as (value, 0x55 - value).
//
// What differs between brands/models is mostly the DPI encoding, which follows the SENSOR:
//   'x1'    Pulsar "pulsar x1" / PAW3950 Ultra: 10-DPI steps, flag bit1 = (v+1)*50+10000, bit0 doubles
//   's50'   PAW3395 / 3950 (VGN, VXE, Pulsar 3554 models, Scyrox V8...): (v+1)*50, bit0 doubles
//   's3955' PAW3955: 6-byte records at 0x1B00 [xLo, xHi, yLo, yHi, flags, ck], dpi = v+1, bit0 doubles
// The identify reply (cmd 0x01) carries (cid, mid) in bytes 9/10 and the link type in byte 11;
// every vendor web app keys its model table on that pair.
//
// Only 3710:5406 (Pulsar 8K CrazyLight dongle) has been checked on real hardware: everything
// else reports verified = false and the app keeps it read-only until the user allows changes.
import type { DeviceKind, Driver, DriverFactory, Setting, Value } from './types';
import { sleep as realSleep } from './types';
import { ATK_DONGLES, ATK_MICE, atkPhoto } from './compxb-atk';

const REPORT_ID = 8;

// cmd bytes
const CMD_IDENTIFY = 0x01;
const CMD_AWAKE = 0x03;
const CMD_BATTERY = 0x04;
const CMD_WRITE = 0x07;
const CMD_READ = 0x08;
const CMD_GET_PROFILE = 0x0e;
const CMD_SET_PROFILE = 0x0f;
const CMD_VERSION = 0x12;
const CMD_DONGLE_VERSION = 0x1d;
const CMD_STATUS_EVENT = 0x0a;

/**
 * The only commands this driver will ever send. Everything else (0x09 factory reset,
 * 0x05 pairing, 0x0B/0x0C identity, 0x0D/0x11 bootloader, firmware upload...) is refused.
 */
const ALLOWED_CMDS = new Set([CMD_IDENTIFY, CMD_AWAKE, CMD_BATTERY, CMD_WRITE, CMD_READ, CMD_GET_PROFILE, CMD_SET_PROFILE, CMD_VERSION, CMD_DONGLE_VERSION]);

// memory map (per profile)
const A_RATE = 0x00;
const A_STAGES = 0x02;
const A_ACTIVE = 0x04;
const A_LOD = 0x0a;
const A_DPI = 0x0c; // + 4i: [xLo, yLo, hi, ck]
const A_COLOR = 0x2c; // + 4i: [R, G, B, ck]
const A_BTN = 0x60; // + 4i: [type, paramHi, paramLo, ck]
const A_DEBOUNCE = 0xa9;
const A_MSYNC = 0xab;
const A_SLEEP = 0xad;
const A_ANGLE = 0xaf;
const A_RIPPLE = 0xb1;
/** PAW3955 models keep their DPI stages here (Pulsar's web app: Sensor3955DPI = 6912), 6 bytes each */
const A_DPI3955 = 0x1b00;
const DPI3955_LEN = 6 * 8;

/** Addresses we may write, with their length. Anything else is refused. */
const WRITABLE: [from: number, to: number][] = [
  [A_RATE, A_RATE + 1],
  [A_STAGES, A_STAGES + 1],
  [A_ACTIVE, A_ACTIVE + 1],
  [A_LOD, A_LOD + 1],
  [A_DPI, A_DPI + 4 * 8 - 1],
  [A_BTN, A_BTN + 4 * 5 - 1],
  [A_DEBOUNCE, A_DEBOUNCE + 1],
  [A_MSYNC, A_MSYNC + 1],
  [A_SLEEP, A_SLEEP + 1],
  [A_ANGLE, A_ANGLE + 1],
  [A_RIPPLE, A_RIPPLE + 1],
  // Pulsar's own web app writes 3955 DPI stages here (6-byte records, function Si/ki)
  [A_DPI3955, A_DPI3955 + DPI3955_LEN - 1],
];
const writable = (addr: number, len: number) => WRITABLE.some(([a, b]) => addr >= a && addr + len - 1 <= b);

const MAP_SIZE = 0x100;

function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}
const hex4 = (n: number) => n.toString(16).padStart(4, '0');
const key = (vid: number, pid: number) => `${hex4(vid)}:${hex4(pid)}`;

// ---------------------------------------------------------------- device tables

/** 3710 PIDs on this protocol (Pulsar's web app, router /cMouse). 1401-1404, 3401/3409/3410 and 5402-5405 use other ones. */
const PIDS_3710 = [
  0x5406, 0x5407, 0x5501, 0x5502, 0x5503, 0x5504, 0x5601, 0x5603, 0xf517, 0xf004, 0xf005,
  0x3414, 0x3415, ...range(0x3501, 0x3529), ...range(0x3601, 0x3611), ...range(0x7501, 0x7510), ...range(0x7601, 0x7605),
  0x9502, 0x9503, 0x9601,
];
/** Pulsar on CompX's vendor id: F40A (Pulsar web app), F507 wired / F508 1K / F509 4K (X2 V2 generation; Linux hid-pulsar) */
const PIDS_3554_PULSAR = [0xf40a, 0xf507, 0xf508, 0xf509];
const WIRELESS_PULSAR = new Set([0x5406, 0x5407, 0x5501, 0x5502, 0x5503, 0x5504, 0x5601, 0x5603, 0xf517, 0xf508, 0xf509]);

type Codec = 'x1' | 's50' | 's3955' | null;
type Rates = 'compx' | 'lamzu';

/** What one USB id is before we know the mouse behind it. */
interface Base {
  brand: string;
  model: string;
  wireless: boolean;
  codec: Codec;
  maxDpi: number;
  rates?: Rates;
  lod?: [string, number][] | null;
  buttons?: boolean;
  angle?: boolean;
  /** VXE R1 SE 1K receivers keep polling/LOD/debounce/angle in a live row at 0x70 (OpenVXE): hide those */
  r1Live?: boolean;
  /** families keyed by cid/mid */
  catalog?: 'atk';
  /** official photo when the USB id alone identifies the model */
  image?: string;
}

const PULSAR_LOD: [string, number][] = [
  ['0.7 mm', 3],
  ['1 mm', 1],
  ['2 mm', 2],
];
/** Lamzu hub "Atlantis" (IsCompx): LOD "0.7;1;2", with 0.7 mm stored as code 3 */
const LAMZU_LOD: [string, number][] = [
  ['0.7 mm', 3],
  ['1 mm', 1],
  ['2 mm', 2],
];
/** PAW3955 heights as codes 1-5 (Scyrox S-center) */
const LOD_3955: [string, number][] = [
  ['0.7 mm', 1],
  ['0.9 mm', 2],
  ['1.2 mm', 3],
  ['1.4 mm', 4],
  ['1.6 mm', 5],
];

const BASES = new Map<string, Base>();
function add(vid: number, pids: number[], b: Base) {
  for (const p of pids) if (!BASES.has(key(vid, p))) BASES.set(key(vid, p), b);
}

const pulsarBase = (wireless: boolean): Base => ({ brand: 'PULSAR', model: 'Pulsar mouse', wireless, codec: 'x1', maxDpi: 32000, lod: PULSAR_LOD, buttons: true, angle: true });
for (const p of PIDS_3710) BASES.set(key(0x3710, p), pulsarBase(WIRELESS_PULSAR.has(p)));
BASES.set(key(0x3554, 0xf40a), pulsarBase(false));
add(0x3554, [0xf507], { brand: 'PULSAR', model: 'Pulsar mouse', wireless: false, codec: 's50', maxDpi: 26000, lod: null, buttons: true, angle: true });
add(0x3554, [0xf508, 0xf509], { brand: 'PULSAR', model: 'Pulsar receiver', wireless: true, codec: 's50', maxDpi: 26000, lod: null, buttons: true, angle: true });

// ATK HUB catalog (ATK, VXE, MAD R, Dragonfly): mice and receivers
for (const [vid, pid, , , name, c] of ATK_MICE) {
  const [brand, model] = splitAtkName(name);
  add(vid, [pid], { brand, model, wireless: false, codec: codecOf(c), maxDpi: maxOf(c), lod: null, buttons: false, angle: false, catalog: 'atk' });
}
for (const [vid, pid, name] of ATK_DONGLES) {
  const r1Live = (vid === 0x373b && pid === 0x1085) || (vid === 0x3554 && pid === 0xf58e);
  add(vid, [pid], { brand: /vxe/i.test(name) || r1Live ? 'VXE' : 'ATK', model: name.trim(), wireless: true, codec: null, maxDpi: 26000, lod: null, buttons: false, angle: false, catalog: 'atk', r1Live });
}

// VGN HUB entries on this protocol (types "vgn-y2" and "vgn-f1-pm", report id 8)
const VGN: [number, number, string, boolean][] = [
  [0x3554, 0xf502, 'Dragonfly F1 Pro', false], [0x3554, 0xf503, 'Dragonfly F1 receiver', true], [0x3554, 0xf505, 'Dragonfly F1 4K receiver', true],
  [0x3554, 0xf506, 'Dragonfly F1 MOBA', false], [0x3554, 0xf50a, 'Dragonfly F1', false], [0x3554, 0xf50b, 'Dragonfly F1 receiver', true],
  [0x3554, 0xf511, 'Dragonfly F1 SE', false], [0x3554, 0xfb50, 'Dragonfly F1 SE', true], [0x3554, 0xfb51, 'Dragonfly F1 SE', false],
  [0x3554, 0xfb3d, 'Y2 Ultra', false], [0x3554, 0xfb3e, 'Y2 Ultra', true], [0x3554, 0xfb49, 'VGN receiver', true],
  [0x3554, 0xfb4a, 'UFO Pro', true], [0x3554, 0xfb4b, 'UFO Ultra', true], [0x3554, 0xfb52, 'Y2 Master', true], [0x3554, 0xfb53, 'Y2 Master', false],
  [0x3554, 0xfb54, 'Y2 Pro Max', true], [0x3554, 0xfb55, 'Y2 Pro Max', false], [0x3554, 0xfb56, 'Dragonfly F2 Master', true],
  [0x3554, 0xfb57, 'Dragonfly F2 Master', false], [0x3554, 0xfb58, 'VGN receiver', true], [0x3554, 0xfb59, 'Dragonfly 3 Master', false],
  [0x391d, 0x1005, 'Dragonfly 3 Master', false], [0x391d, 0x101d, 'Dragonfly 3 MasterGT', false], [0x391d, 0x102d, 'Dragonfly F2 MasterGT', true],
  [0x391d, 0x1032, 'Dragonfly F2 MasterGT', false], [0x391d, 0x1034, 'Dragonfly Y2 V2 MasterGT', false], [0x391d, 0x1035, 'Dragonfly F2 Turbo', false],
  [0x391d, 0x1036, 'Dragonfly F2 Turbo+', false], [0x391d, 0x1038, 'Dragonfly F1 V2 SE+', false], [0x391d, 0x1039, 'Dragonfly 3 MINI SE+', true],
  [0x391d, 0x1a05, 'VGN receiver', true], [0x391d, 0x1a1a, 'Dragonfly 3 MasterGT', true], [0x391d, 0x1a2f, 'Dragonfly Y2 V2 MasterGT', true],
  [0x391d, 0x1a30, 'Dragonfly F2 Turbo', true], [0x391d, 0x1a31, 'Dragonfly F2 Turbo+', true], [0x391d, 0x1a32, 'Dragonfly F1 V2 SE+', true],
  [0x391d, 0x1a33, 'Dragonfly 3 MINI SE+', false],
];
/**
 * Top-down photos (transparent, 620x1000) from VGN's own web hub, hub.vgnlab.com: its images chunk maps each
 * "cover" key to a hashed asset; the hub's mid table picks the cover per model (receivers: mouse unknown, none).
 */
const VGN_HUB = 'https://hub.vgnlab.com/assets/';
const VGN_PHOTO: [RegExp, string][] = [
  [/F1 Pro\b/, 'F1ProMaxBLACK-BC3o1kDF.webp'],
  [/F1 MOBA/, 'F1MobaBLACK-DVPkz4T5.webp'],
  [/F1 V2 SE\+/, 'F1V2BLACK-BJrT3swp.webp'],
  [/F1 SE/, 'F1SEBLACK-BGs3eTRn.webp'],
  [/^Dragonfly F1$/, 'F1BLACK-BK6mG4-j.webp'],
  [/^Y2 Ultra$/, 'Y2BLACK-z7WRnzVp.webp'],
  [/^Y2 Master$/, 'Y2MasterBLACK-oA_lZjf4.webp'],
  [/Y2 Pro Max|Y2 V2 MasterGT/, 'Y2MasterWHITE-z73MX36R.webp'],
  [/F2 Master$/, 'F2MasterBLACK-DAVajiLz.webp'],
  [/F2 MasterGT|F2 Turbo/, 'F2MasterBLACKFAN-DN-tMO3B.webp'],
  [/3 MINI SE\+/, 'Dragonfly3MiniSEBLACK-C2RFO8LP.webp'],
  [/Dragonfly 3 Master/, 'Dragonfly3BLACK-CxOBPuq0.webp'],
];
const vgnPhoto = (model: string): string | undefined => {
  const hit = /receiver/i.test(model) ? undefined : VGN_PHOTO.find(([re]) => re.test(model));
  return hit ? VGN_HUB + hit[1] : undefined;
};
for (const [vid, pid, model, wireless] of VGN) add(vid, [pid], { brand: 'VGN', model, image: vgnPhoto(model), wireless, codec: 's50', maxDpi: 26000, lod: null, buttons: true, angle: true, catalog: 'atk' });

// Kysona (Linux hid-kysona ids); settings layout unconfirmed, so no LOD/button writes
add(0x3554, [0xf57c], { brand: 'KYSONA', model: 'M600', wireless: true, codec: 's50', maxDpi: 26000, lod: null, buttons: false, angle: true });
add(0x3554, [0xf5d5], { brand: 'KYSONA', model: 'M600 V2', wireless: true, codec: 's50', maxDpi: 26000, lod: null, buttons: false, angle: true });
add(0x3554, [0xf57d], { brand: 'KYSONA', model: 'M600', wireless: false, codec: 's50', maxDpi: 26000, lod: null, buttons: false, angle: true });

// Scyrox S-center (cid 62): pid list from its cfg.json
add(0x3554, [0xf5f4, 0xf5f7, 0xf517], { brand: 'SCYROX', model: 'Scyrox mouse', wireless: true, codec: 's50', maxDpi: 30000, lod: PULSAR_LOD, buttons: true, angle: true });
add(0x3554, [0xf5f6, 0xf515], { brand: 'SCYROX', model: 'Scyrox mouse', wireless: false, codec: 's50', maxDpi: 30000, lod: PULSAR_LOD, buttons: true, angle: true });

const ATLANTIS_IMG = 'https://lamzu.net/Config/Atlantis/Device_1.png';
// Lamzu Atlantis generation: own polling bytes (0x10 also means 1000 Hz) and two LOD stops
add(0x3554, [0xf50f], { brand: 'LAMZU', model: 'Atlantis', image: ATLANTIS_IMG, wireless: false, codec: 's50', maxDpi: 26000, rates: 'lamzu', lod: LAMZU_LOD, buttons: true, angle: true });
add(0x3554, [0xf50d], { brand: 'LAMZU', model: 'Atlantis', image: ATLANTIS_IMG, wireless: true, codec: 's50', maxDpi: 26000, rates: 'lamzu', lod: LAMZU_LOD, buttons: true, angle: true });
add(0x3554, [0xf510], { brand: 'LAMZU', model: 'Atlantis', image: ATLANTIS_IMG, wireless: true, codec: 's50', maxDpi: 26000, lod: LAMZU_LOD, buttons: true, angle: true });

// Teevolution (Terra Pro family, TeevoLink)
add(0x3554, [0xf520, 0xf522, 0xf523, 0xf5bb], { brand: 'TEEVOLUTION', model: 'Teevolution mouse', wireless: false, codec: 's50', maxDpi: 42000, lod: null, buttons: true, angle: true });

function codecOf(c: string): Codec {
  return c === 'x' ? 'x1' : c === '5' ? 's50' : c === '9' ? 's3955' : null;
}
function maxOf(c: string): number {
  return c === 'x' ? 42000 : c === '9' ? 40000 : 26000;
}
function splitAtkName(name: string): [string, string] {
  const n = name.replace(/\s+/g, ' ').trim();
  if (/^VXE /i.test(n)) return ['VXE', n.slice(4)];
  if (/^MAD R/i.test(n)) return ['VXE', n];
  if (/^ATK /i.test(n)) return ['ATK', n.slice(4)];
  if (/^DRAGONFLY/i.test(n)) return ['VGN', n];
  return ['ATK', n];
}

/** Pulsar (cid 87) model names by mid, from bbb.pulsar.gg/cMouse/devicename.json (index = mid - 1) */
const PULSAR_NAMES: string[] = [
  'X2 Crazylight Mini', 'X2 Crazylight Mini', 'X2 Crazylight Mini', 'X2 Crazylight Mini', 'X2 Crazylight Mini',
  'X2 Crazylight Mini', 'TenZ Signature Edition', 'TenZ', 'X2 Crazylight Mini', 'X2 Crazylight Mini',
  'Pulsar X VSPO! Aizawa Ema', 'X2 Crazylight Mini T1 Edition', 'X2 Crazylight Mini T1 Edition',
  'X2 Crazylight Mini PRX Edition', 'X2 Crazylight Mini Boardzy Edition', 'X2 Crazylight Mini Randomfrankp Edition',
  'Xlite Crazylight Mini', 'Xlite Crazylight Mini', 'X3 Crazylight Mini', 'X3 Crazylight Mini',
  'X3 LHD Crazylight Mini', 'X3 LHD Crazylight Mini', 'X2H Crazylight Mini', 'X2H Crazylight Mini',
  'X2N Crazylight Mini', 'X2N Crazylight Mini', 'X2 Crazylight Medium', 'X2 Mini Pulsar By You XS-1',
  'X2H Crazylight Medium', 'X2H Medium Pulsar By You XS-1', 'X2A Medium Pulsar By You XS-1',
  'X2A Mini Pulsar By You XS-1', 'Xlite Mini Pulsar By You XS-1', 'Xlite Crazylight Medium',
  'Xlite Large Pulsar By You XS-1', 'Pulsar Lab. X2F', 'TenZ Signature RED', 'JV-X Pro Series',
  'Susanto-X Pro Series', 'TenZ Signature Edition', 'X2 Crazylight 5th Anniversary Edition',
  'X2 Crazylight WildScape Desert Edition', 'X2 Crazylight Mini Forest',
  'X2 Crazylight Mini WildScape Ocean Edition', 'Pulsar X VSPO! Asumi Sena', 'Pulsar X VSPO! Hanabusa Lisa',
  'Pulsar X VSPO! Ichinose Uruha', 'Pulsar X VSPO! Kaga Sumire', 'Pulsar X VSPO! Kisaragi Ren',
  'Pulsar X VSPO! Kogara Toto', 'Pulsar X VSPO! Komori Met', 'Pulsar X VSPO! Kurumi Noah',
  'Pulsar X VSPO! Kaga Nazuna', 'Pulsar X VSPO! Nekota Tsuna', 'Pulsar X VSPO! Kaminari Qpi',
  'Pulsar X VSPO! Sendo Yuuhi', 'Pulsar X VSPO! Shinomiya Runa', 'Pulsar X VSPO! Shiranami Ramune',
  'Pulsar X VSPO! Tachibana Hinano', 'Pulsar X VSPO! Tosaki Mimi', 'Pulsar X VSPO! Tsumugi Kokage',
  'Pulsar X VSPO! Yakumo Beni', 'Pulsar X VSPO! Yano Kuromu', 'Pulsar X VSPO! Yumeno Akari',
  'Pulsar X VSPO! Amayui Moka', 'Pulsar X VSPO! Choya Hanabi', 'Pulsar Lab. X2F 5th Anniversary Edition',
  'ZywOo The Chosen Mouse Gen.2', 'ZywOo The Chosen Mouse Gen.2', 'X2 Crazylight Medium', 'Xlite Crazylight Medium',
  'X3 Crazylight Medium', 'X3 Crazylight Medium', 'X3 LHD Crazylight Medium', 'X3 LHD Crazylight Medium',
  'X2H Crazylight Medium', 'X2N Crazylight Medium', 'X2N Crazylight Medium',
  'X2 Crazylight Medium The Finals Edition', 'X2 Crazylight Medium THE GRAND MAJOR 2025 Edition',
  'X2 Crazylight Medium Bruce Lee 85th Edition', 'X2 Crazylight Mini Bruce Lee 85th Edition',
  'X2 Crazylight Medium PRX Pacific Gold Edition', 'X2 Crazylight Medium Pokemon Pikachu Edition',
  'X2 Crazylight Mini Pokemon Pikachu Edition', 'X2 Crazylight Mini Pokemon Mew-Two FF Edition',
  'X2 Crazylight Medium BlueArchive Hoshino Edition', 'X2 Crazylight Medium BlueArchive Shiroko Edition',
  'X2 Crazylight Medium BlueArchive Nonomi Edition', 'X2 Crazylight Medium BlueArchive Hoshino FF Edition',
  'Pulsar eS FS-1 Medium', 'BUZZ-X Pro Series - MOON GRAY',
  'STA-X Pro Series - STEALTH BLACK', 'CARPE-X Pro Series - CARP ORANGE',
  'X2 Crazylight Mini Pokemon Mew-Two FF Edition', 'X2 Crazylight Mini PRX Pacific Gold Edition',
  'X2H Crazylight Mini BadSeedTech Edition', 'X2H Crazylight Medium BadSeedTech Edition', 'Jinggg-X Pro Series',
  'ZywOo The Chosen Mouse Gen.2', 'Feinmann F01 Noctua Edition', 'X3 Crazylight Desert',
  'X3 Crazylight Medium Desert', 'X3 LHD Crazylight Medium Desert', 'X2N Crazylight Mini Ocean',
  'X2N Crazylight Medium Ocean', 'TenZ 2.0 Mini Misty Blue', '', 'X2 Crazylight Medium Forest',
  'TenZ Signature Edition 2.0 Mini', '', 'Susanto-X 2.0 Large Black', '', '', '', 'Xlite Crazylight Rock',
  'X2H Crazylight Volcano', 'Xlite Crazylight Medium Rock', 'X2H Crazylight Medium Volcano',
  'Susanto-X 2.0 Large Phantom Jungle', '', 'TenZ Signature Edition 2.0 Medium', 'TenZ 2.0 Medium Misty Blue',
  'Susanto-X 2.0 Medium Phantom Jungle', 'Susanto-X 2.0 Medium Black', 'X2F Crazylight Black',
  'Pulsar eS FS-1 GT Silver', 'Pulsar eS FS-1 Tournament Red', 'Pulsar eS FS-1 Tournament Blue',
  'X2 Crazylight Mini Shibuki', 'X2 Crazylight Mini Yuni', 'X2 Crazylight Mini Mashiro',
  'ZywOo The Chosen Mouse Gen.3 Mini', 'ZywOo The Chosen Mouse Gen.3 Mini', 'ZywOo The Chosen Mouse Gen.3 Medium',
  'ZywOo The Chosen Mouse Gen.3 Medium', '', '', '', '', '', '', '', '', '', 'X2 Crazylight 2 Mini 2026 PRX Edition',
  'X2 Crazylight 2 Medium 2026 PRX Edition', '', '',
];
/** Pulsar (cid 87) mids by sensor (cfg.json); everything else is "pulsar x1" */
const PULSAR_3950 = new Set([68, 69, 91, 92, 93, 94, 99, 100, 127, 128, 129]);
const PULSAR_3955 = new Set([101, 107, 108, 110, 111, 112, 113, 114, 115, 120, 121, 122, 123, 124, 125, 126, ...range(133, 149)]);
/**
 * Product photos at bbb.pulsar.gg/cMouse/img/devices/mouse/57XX.png (checked: HTTP 200, image/png). Missing (404):
 * the "By You XS-1" custom builds. The unnamed, unreleased mids get a black silhouette placeholder there, not a photo.
 */
const PULSAR_NO_PHOTO = new Set([28, 30, 31, 32, 33, 35, 108, 111, 113, 114, 115, 121, ...range(137, 145), 148, 149]);
/** "By You XS-1" builds are customised shells of a stock model: show that model's photo (mid -> photo mid) */
const PULSAR_PHOTO_OF: Record<number, number> = { 28: 1, 30: 29, 33: 17 };
const PULSAR_PHOTO_MAX = 149;
function pulsarPhoto(mid: number): string | undefined {
  const m = PULSAR_PHOTO_OF[mid] ?? mid;
  if (m < 1 || m > PULSAR_PHOTO_MAX || PULSAR_NO_PHOTO.has(m)) return undefined;
  return `https://bbb.pulsar.gg/cMouse/img/devices/mouse/57${hexByte(m)}.png`;
}

/** Pulsar's X2 V2 generation on 3554 (cid 6), from Linux hid-pulsar */
const PULSAR_CID6: Record<number, string> = {
  0x07: 'Xlite V3', 0x0e: 'Xlite V3', 0x0f: 'Xlite V3', 0x10: 'Xlite V3', 0x11: 'Xlite V3',
  0x08: 'X2A', 0x09: 'X2A',
  0x0a: 'X2 V2', 0x0b: 'X2 V2', 0x12: 'X2 V2', 0x13: 'X2 V2', 0x14: 'X2 V2', 0x15: 'X2 V2',
  0x0c: 'X2H', 0x0d: 'X2H',
};

/** Scyrox (cid 62) by mid, from scyrox.net S-center (cfg.json + its device cards) */
const SCYROX: Record<number, [string, '3950' | '3955']> = {
  1: ['V8', '3950'], 10: ['V8', '3950'], 11: ['V8', '3950'],
  2: ['V6', '3950'], 12: ['V6', '3950'], 13: ['V6', '3950'],
  5: ['V8S', '3955'], 14: ['V8S', '3955'], 15: ['V8S', '3955'], 16: ['V8S', '3955'],
  6: ['V6S', '3955'], 17: ['V6S', '3955'], 18: ['V6S', '3955'], 19: ['V6S', '3955'],
  7: ['V10', '3955'], 8: ['V10', '3955'], 9: ['V10', '3955'],
};

const CID_PULSAR = 87;
const CID_PULSAR_GEN2 = 6;
const CID_SCYROX = 62;
const CID_TEEVOLUTION = 14;

/** Everything the driver needs to know about one connected mouse. */
export interface Variant {
  brand: string;
  model: string;
  image?: string;
  codec: Codec;
  maxDpi: number;
  maxStages: number;
  rates: Rates;
  /** null: show the stored code, don't offer changes */
  lod: [string, number][] | null;
  msync: boolean;
  angle: boolean;
  ripple: boolean;
  buttons: boolean;
  r1Live: boolean;
  wireless: boolean;
}

const UNKNOWN: Base = { brand: 'COMPX', model: 'CompX mouse', wireless: false, codec: null, maxDpi: 26000, lod: null };

/** Pure lookup: USB id plus (once identified) the cid/mid pair -> variant. */
export function resolveVariant(vid: number, pid: number, cid?: number, mid?: number): Variant {
  const b = BASES.get(key(vid, pid)) ?? UNKNOWN;
  const v: Variant = {
    brand: b.brand,
    model: b.model,
    codec: b.codec,
    maxDpi: b.maxDpi,
    maxStages: 6,
    rates: b.rates ?? 'compx',
    lod: b.lod ?? null,
    msync: true,
    angle: b.angle ?? false,
    ripple: true,
    buttons: b.buttons ?? false,
    r1Live: b.r1Live ?? false,
    wireless: b.wireless,
    image: b.image,
  };
  if (cid === undefined || mid === undefined || (cid === 0 && mid === 0)) return v;

  if (cid === CID_PULSAR) {
    const sensor = PULSAR_3955.has(mid) ? '3955' : PULSAR_3950.has(mid) ? '3950' : 'x1';
    Object.assign(v, {
      brand: 'PULSAR',
      model: PULSAR_NAMES[mid - 1] || 'CrazyLight mouse',
      image: pulsarPhoto(mid),
      codec: sensor === '3955' ? 's3955' : sensor === '3950' ? 's50' : 'x1',
      maxDpi: sensor === '3955' ? 42000 : 32000,
      rates: 'compx',
      // Pulsar's sensor.json offers LOD / motion sync / angle / ripple only for x1, 3950 and 3395
      lod: sensor === '3955' ? null : PULSAR_LOD,
      msync: sensor !== '3955',
      angle: sensor !== '3955',
      ripple: sensor !== '3955',
      buttons: true,
    });
    return v;
  }
  if (cid === CID_PULSAR_GEN2 && b.brand === 'PULSAR') {
    v.model = PULSAR_CID6[mid] ?? v.model;
    return v;
  }
  if (cid === CID_SCYROX && (b.brand === 'SCYROX' || b === UNKNOWN)) {
    const sc = SCYROX[mid];
    v.brand = 'SCYROX';
    v.maxStages = 5;
    if (sc) {
      v.model = sc[0];
      v.codec = sc[1] === '3955' ? 's3955' : 's50';
      v.maxDpi = sc[1] === '3955' ? 50000 : 30000;
      v.lod = sc[1] === '3955' ? LOD_3955 : PULSAR_LOD;
      // top + bottom view on transparent background, from Scyrox's own web app
      v.image = `https://www.scyrox.net/img/devices/mouse/3E${hexByte(mid)}.png`;
    }
    return v;
  }
  if (cid === CID_TEEVOLUTION && b.brand === 'TEEVOLUTION') {
    v.model = 'Terra Pro';
    // top + bottom view (transparent) from TeevoLink, the hub teevolution.gg links to; one file per colour mid
    if ([2, 3, 5, 6].includes(mid)) v.image = `https://www.controlhub.top/teevolink/img/devices/mouse/0E${hexByte(mid)}.png`;
    return v;
  }
  if (b.catalog === 'atk') {
    const hits = ATK_MICE.filter((m) => m[2] === cid && m[3] === mid);
    const hit = hits.find((m) => m[0] === vid && m[1] === pid) ?? hits[0];
    if (hit) {
      const [brand, model] = splitAtkName(hit[4]);
      Object.assign(v, { brand, model, image: atkPhoto(hit[6]), codec: codecOf(hit[5]), maxDpi: maxOf(hit[5]) });
    }
  }
  return v;
}
const hexByte = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();

// ---------------------------------------------------------------- encoding

export function checksum(d: ArrayLike<number>): number {
  let sum = REPORT_ID;
  for (let i = 0; i < 15; i++) sum += d[i] ?? 0;
  return (0x55 - sum) & 0xff;
}

export function frame(cmd: number, addr: number, payload: number[], len = payload.length): Uint8Array<ArrayBuffer> {
  if (payload.length > 10) throw new Error('payload too long');
  const d = new Uint8Array(16);
  d[0] = cmd;
  d[2] = (addr >> 8) & 0xff;
  d[3] = addr & 0xff;
  d[4] = len;
  payload.forEach((b, i) => (d[5 + i] = b & 0xff));
  d[15] = checksum(d);
  return d;
}

const comp = (v: number) => (0x55 - v) & 0xff;
const comp3 = (a: number, b: number, c: number) => (0x55 - a - b - c) & 0xff;
const sealed = (bytes: number[]) => [...bytes, (0x55 - bytes.reduce((a, b) => a + b, 0)) & 0xff];

/** "pulsar x1" axis from its low byte and 4-bit field (bit0 doubles, bit1 = 50-steps above 10000, bits 2-3 high bits). */
export function decodeDpi(lo: number, field: number): number {
  const v = lo | (((field >> 2) & 3) << 8);
  let dpi = (v + 1) * 10;
  if (field & 2) dpi = dpi * 5 + 10000;
  if (field & 1) dpi *= 2;
  return dpi;
}

/** DPI -> [lo, 4-bit field], as Pulsar's app encodes it: 10-steps to 10000, 50 to 30000, then 100. */
export function encodeDpi(dpi: number): [number, number] {
  let mode: number;
  let v: number;
  if (dpi >= 30100) {
    mode = 3;
    v = Math.round((dpi / 2 - 10050) / 50);
  } else if (dpi >= 10050) {
    mode = 2;
    v = Math.round((dpi - 10050) / 50);
  } else {
    mode = 0;
    v = Math.round(dpi / 10) - 1;
  }
  v = Math.max(0, Math.min(1023, v));
  return [v & 0xff, mode | ((v >> 8) << 2)];
}

/** 50-step axis (PAW3395/3950 and most 3554 mice): (v+1)*50, bit0 (or bit1) doubles. */
export function decodeDpi50(lo: number, field: number): number {
  const v = lo | (((field >> 2) & 3) << 8);
  let dpi = (v + 1) * 50;
  if (field & 1) dpi *= 2;
  if (field & 2) dpi *= 2;
  return dpi;
}

export function encodeDpi50(dpi: number): [number, number] {
  const doubled = dpi > 30000;
  let v = Math.round((doubled ? dpi / 2 : dpi) / 50) - 1;
  v = Math.max(0, Math.min(1023, v));
  return [v & 0xff, (doubled ? 1 : 0) | ((v >> 8) << 2)];
}

/** Stage block [xLo, yLo, hi, ck] for the same X and Y. */
export function stageBytes(dpi: number, codec: 'x1' | 's50' = 'x1'): number[] {
  const [lo, f] = codec === 's50' ? encodeDpi50(dpi) : encodeDpi(dpi);
  const hi = f | (f << 4);
  return [lo, lo, hi, comp3(lo, lo, hi)];
}

/** PAW3955 record [xLo, xHi, yLo, yHi, flags, ck] -> X DPI */
export function decodeDpi3955(r: ArrayLike<number>): number {
  const f = r[4];
  const v = r[0] | (r[1] << 8) | (((f >> 2) & 3) << 16);
  let dpi = v + 1;
  if (f & 1) dpi *= 2;
  if (f & 2) dpi *= 2;
  return dpi;
}

/** Same X and Y, as Pulsar's app writes it: 1-steps below 42002, halved (flag 0x11) above. */
export function stageBytes3955(dpi: number): number[] {
  const high = dpi >= 42002;
  const v = Math.max(0, Math.min(0x3ffff, Math.floor(high ? dpi / 2 : dpi) - 1));
  const ex = high ? 0x11 : 0;
  const top = v >> 16;
  return sealed([v & 0xff, (v >> 8) & 0xff, v & 0xff, (v >> 8) & 0xff, (top << 2) | (top << 6) | ex]);
}

// ---------------------------------------------------------------- tables

const POLLING: [string, number, number][] = [
  // label, code, Hz
  ['125 Hz', 8, 125],
  ['250 Hz', 4, 250],
  ['500 Hz', 2, 500],
  ['1000 Hz', 1, 1000],
  ['2000 Hz', 0x10, 2000],
  ['4000 Hz', 0x20, 4000],
  ['8000 Hz', 0x40, 8000],
];
/** Lamzu Atlantis: 0x10 is 1000 Hz too and the fast codes are shifted (OpenMouse, on hardware). Only 125-1000 are written. */
const POLLING_LAMZU: [string, number, number][] = [
  ['125 Hz', 8, 125],
  ['250 Hz', 4, 250],
  ['500 Hz', 2, 500],
  ['1000 Hz', 1, 1000],
];
const LAMZU_READ_ONLY: Record<number, string> = { 0x10: '1000 Hz', 0x20: '2000 Hz', 0x40: '4000 Hz', 0x80: '8000 Hz' };
/** link type from the identify reply -> highest polling rate */
const LINK_MAX: Record<number, number> = { 0: 1000, 1: 4000, 2: 1000, 3: 8000, 4: 2000, 5: 8000 };
const LINK_NAME: Record<number, string> = { 0: 'Wireless', 1: 'Wireless 4K', 2: 'Wired', 3: 'Wired 8K', 4: 'Wireless 2K', 5: 'Wireless 8K' };
const LINK_WIRELESS = new Set([0, 1, 4, 5]);

/** sleep is stored in steps of 10 s */
const SLEEP: [string, number][] = [
  ['10 sec', 1],
  ['30 sec', 3],
  ['1 min', 6],
  ['2 min', 12],
  ['5 min', 30],
  ['10 min', 60],
  ['20 min', 120],
];

/** [label, type, param] — types from Pulsar's web app (MouseKey 1, DPISwitch 2, Disable 0). */
export const ACTIONS: [string, number, number][] = [
  ['Left click', 1, 0x0100],
  ['Right click', 1, 0x0200],
  ['Middle click', 1, 0x0400],
  ['Back', 1, 0x0800],
  ['Forward', 1, 0x1000],
  ['DPI cycle', 2, 0x0100],
  ['Disabled', 0, 0],
];
export const KEEP = 1000;
const BTN_KEYS = ['btn1', 'btn2', 'btn3', 'btn4', 'btn5'];
const BTN_LABELS = ['Left button', 'Right button', 'Middle button (wheel click)', 'Back side button', 'Forward side button'];

const s = (key: string, label: string, group: string, value: Value): Setting => ({ key, label, group, value });
const text = (key: string, label: string, group: string, t: string) => s(key, label, group, { kind: 'text', text: t });
const choice = (options: [string, number][], current: number): Value => ({ kind: 'choice', options, current });
const toggle = (on: boolean): Value => ({ kind: 'toggle', on });

// ---------------------------------------------------------------- transport

type Reply = Uint8Array;

/** Sends frames on report 8 and pairs each answer with its request. */
class Link {
  private waiters: { cmd: number; addr: number; resolve: (r: Reply) => void }[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly dev: HIDDevice) {
    dev.addEventListener('inputreport', this.onReport);
  }

  detach(): void {
    this.dev.removeEventListener('inputreport', this.onReport);
  }

  private onReport = (e: HIDInputReportEvent) => {
    if (e.reportId !== REPORT_ID) return;
    const d = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
    if (d[0] === CMD_STATUS_EVENT) return; // unsolicited "something changed on the mouse"
    const addr = (d[2] << 8) | d[3];
    const i = this.waiters.findIndex((w) => w.cmd === d[0] && (w.cmd !== CMD_READ && w.cmd !== CMD_WRITE ? true : w.addr === addr));
    if (i >= 0) this.waiters.splice(i, 1)[0].resolve(d.slice());
  };

  /** one request at a time; resends up to 5 times */
  send(cmd: number, addr: number, payload: number[], len = payload.length): Promise<Reply> {
    if (!ALLOWED_CMDS.has(cmd)) return Promise.reject(new Error(`command ${cmd.toString(16)} is blocked`));
    if (cmd === CMD_WRITE && !writable(addr, payload.length)) return Promise.reject(new Error(`address ${addr.toString(16)} is not writable`));
    const run = async () => {
      const f = frame(cmd, addr, payload, len);
      for (let attempt = 0; attempt < 5; attempt++) {
        const got = new Promise<Reply | null>((resolve) => {
          const w = { cmd, addr, resolve: (r: Reply) => resolve(r) };
          this.waiters.push(w);
          // real time, not the injectable delay: answers arrive as events
          setTimeout(() => {
            const i = this.waiters.indexOf(w);
            if (i >= 0) {
              this.waiters.splice(i, 1);
              resolve(null);
            }
          }, 200);
        });
        await this.dev.sendReport(REPORT_ID, f);
        const r = await got;
        if (r) {
          if (r[1] !== 0) throw new Error('not supported');
          return r;
        }
      }
      throw new Error('no answer — is the mouse awake?');
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }
}

// ---------------------------------------------------------------- driver

export interface PulsarOptions {
  sleep?: (ms: number) => Promise<void>;
}

export class PulsarDriver implements Driver {
  readonly id: string;
  readonly family: string;
  readonly kind: DeviceKind = 'mouse';
  /** only the Pulsar 8K CrazyLight dongle has been checked on real hardware */
  readonly verified: boolean;
  private v: Variant;
  private cid?: number;
  private mid?: number;
  private link: Link;
  private delay: (ms: number) => Promise<void>;
  private linkType: number;
  private map = new Uint8Array(MAP_SIZE);
  private map3955 = new Uint8Array(DPI3955_LEN);
  private profile = 0;
  private profiles = 0;

  constructor(
    private readonly device: HIDDevice,
    opts: PulsarOptions = {},
  ) {
    this.id = `${hex4(device.vendorId)}:${hex4(device.productId)}`;
    this.delay = opts.sleep ?? realSleep;
    this.link = new Link(device);
    this.v = resolveVariant(device.vendorId, device.productId);
    this.family = this.v.brand === 'PULSAR' ? 'Pulsar (CrazyLight / Nordic)' : 'CompX-B (report 8)';
    this.verified = device.vendorId === 0x3710 && device.productId === 0x5406;
    this.linkType = this.v.wireless ? 5 : 2;
  }

  brand(): string {
    return this.v.brand;
  }
  model(): string {
    return this.v.model;
  }
  image(): string | undefined {
    return this.v.image;
  }
  /** (cid, mid) from the last identify, e.g. for diagnostics */
  identity(): [number, number] | undefined {
    return this.cid === undefined || this.mid === undefined ? undefined : [this.cid, this.mid];
  }

  private get wireless(): boolean {
    return this.linkType in LINK_MAX ? LINK_WIRELESS.has(this.linkType) : this.v.wireless;
  }

  /** wake the mouse up for a batch of commands (the receiver relays them) */
  private async awake(on: boolean): Promise<void> {
    for (let i = 0; i < 20; i++) {
      // Pulsar's app sends this with len 0 and the flag in the first payload byte
      const r = await this.link.send(CMD_AWAKE, 0, [on ? 1 : 0], 0);
      if (on && r[5] === 0) throw new Error('the mouse is off or asleep — move it and try again');
      if (r[9] !== 1) return;
      await this.delay(10);
    }
  }

  private async batch<T>(fn: () => Promise<T>): Promise<T> {
    await this.awake(true);
    try {
      return await fn();
    } finally {
      await this.awake(false).catch(() => undefined);
    }
  }

  async identify(): Promise<void> {
    const rnd = [0, 0, 0, 0].map(() => Math.floor(Math.random() * 256));
    const r = await this.link.send(CMD_IDENTIFY, 0, [...rnd, 0, 0, 0, 0]);
    this.cid = r[9];
    this.mid = r[10];
    if (r[11] in LINK_MAX) this.linkType = r[11];
    this.v = resolveVariant(this.device.vendorId, this.device.productId, this.cid, this.mid);
  }

  private async readRange(base: number, out: Uint8Array): Promise<void> {
    for (let a = 0; a < out.length; a += 10) {
      const n = Math.min(10, out.length - a);
      const r = await this.link.send(CMD_READ, base + a, new Array(n).fill(0));
      for (let i = 0; i < n; i++) out[a + i] = r[5 + i];
    }
  }

  private stageDpi(i: number): number {
    const m = this.map;
    if (this.v.codec === 's3955') return decodeDpi3955(this.map3955.subarray(6 * i, 6 * i + 6));
    const o = A_DPI + 4 * i;
    return this.v.codec === 's50' ? decodeDpi50(m[o], m[o + 2] & 0x0f) : decodeDpi(m[o], m[o + 2] & 0x0f);
  }

  private pollingTable(): [string, number, number][] {
    if (this.v.rates === 'lamzu') return POLLING_LAMZU;
    const max = LINK_MAX[this.linkType] ?? 1000;
    return POLLING.filter(([, , hz]) => hz <= max);
  }

  async read(): Promise<Setting[]> {
    return this.batch(async () => {
      await this.identify();
      const v = this.v;
      const out: Setting[] = [];
      out.push(text('model', 'Model', 'Info', v.model));
      out.push(text('connection', 'Connection', 'Info', LINK_NAME[this.linkType] ?? 'Unknown'));
      const ver = await this.link.send(CMD_VERSION, 0, []).catch(() => null);
      if (ver) out.push(text('fw', 'Mouse firmware', 'Info', `v${ver[5]}.${ver[6].toString(16).padStart(2, '0')}`));
      if (this.wireless) {
        const dv = await this.link.send(CMD_DONGLE_VERSION, 0, []).catch(() => null);
        if (dv) out.push(text('dongle_fw', 'Receiver firmware', 'Info', `v${dv[5]}.${dv[6].toString(16).padStart(2, '0')}`));
        const b = await this.link.send(CMD_BATTERY, 0, []).catch(() => null);
        if (b) out.push(text('battery', 'Battery', 'Info', `${b[5]}%${b[6] ? ' (charging)' : ''}`));
      }

      const p = await this.link.send(CMD_GET_PROFILE, 0, []).catch(() => null);
      if (p) {
        this.profile = p[5];
        this.profiles = 4;
        out.push(s('profile', 'Active profile (all settings below belong to it)', 'Profile', choice([0, 1, 2, 3].map((i) => [`Profile ${i + 1}`, i]), this.profile)));
      }

      await this.readRange(0, this.map);
      if (v.codec === 's3955') await this.readRange(A_DPI3955, this.map3955);
      const m = this.map;

      // DPI
      const count = Math.min(v.maxStages, Math.max(1, m[A_STAGES]));
      if (v.codec) {
        const stages: number[] = [];
        const colors: number[] = [];
        for (let i = 0; i < count; i++) {
          stages.push(this.stageDpi(i));
          const c = A_COLOR + 4 * i;
          colors.push((m[c] << 16) | (m[c + 1] << 8) | m[c + 2]);
        }
        const active = Math.min(count - 1, m[A_ACTIVE]);
        out.push(s('dpi', 'DPI stages', 'DPI', { kind: 'dpi', stages, active, min: 50, max: v.maxDpi, step: 50, colors }));
        out.push(s('dpi_count', 'Number of DPI stages', 'DPI', choice(range(1, v.maxStages).map((i) => [String(i), i]), count)));
      } else {
        out.push(text('dpi_note', 'DPI', 'DPI', `${count} stages, stage ${Math.min(count, m[A_ACTIVE] + 1)} active (this sensor's DPI encoding isn't supported yet)`));
      }

      // performance
      if (!v.r1Live) {
        const table = this.pollingTable();
        const rate = table.map(([l, c]) => [l, c] as [string, number]);
        if (!rate.some(([, c]) => c === m[A_RATE])) rate.push([v.rates === 'lamzu' && LAMZU_READ_ONLY[m[A_RATE]] ? `${LAMZU_READ_ONLY[m[A_RATE]]} (keep)` : `Code ${m[A_RATE]}`, m[A_RATE]]);
        out.push(s('polling', 'Polling rate', 'Performance', choice(rate, m[A_RATE])));
        if (v.lod) {
          const lod = [...v.lod];
          if (!lod.some(([, c]) => c === m[A_LOD])) lod.push([`Code ${m[A_LOD]}`, m[A_LOD]]);
          out.push(s('lod', 'Lift-off distance', 'Performance', choice(lod, m[A_LOD])));
        } else {
          out.push(text('lod_code', 'Lift-off distance', 'Performance', `code ${m[A_LOD]}`));
        }
      }
      if (v.msync) out.push(s('motion_sync', 'Motion sync', 'Performance', toggle(m[A_MSYNC] !== 0)));
      if (v.angle && !v.r1Live) out.push(s('angle_snap', 'Angle snapping', 'Performance', toggle(m[A_ANGLE] !== 0)));
      if (v.ripple) out.push(s('ripple', 'Ripple control', 'Performance', toggle(m[A_RIPPLE] !== 0)));

      // buttons
      if (v.buttons) {
        for (let bi = 0; bi < 5; bi++) {
          const o = A_BTN + 4 * bi;
          const type = m[o];
          const param = (m[o + 1] << 8) | m[o + 2];
          const opts: [string, number][] = ACTIONS.map((a, i) => [a[0], i]);
          let current = ACTIONS.findIndex((a) => a[1] === type && (type === 0 || a[2] === param));
          if (current < 0) {
            opts.unshift([`Custom (type ${type}) (keep)`, KEEP]);
            current = KEEP;
          }
          out.push(s(BTN_KEYS[bi], BTN_LABELS[bi], 'Buttons', choice(opts, current)));
        }
      }
      if (!v.r1Live) out.push(s('debounce', 'Click debounce', 'Buttons', { kind: 'number', min: 0, max: 15, current: m[A_DEBOUNCE], unit: ' ms' }));

      // power (wireless only)
      if (this.wireless) {
        const sl = m[A_SLEEP];
        const opts = SLEEP.map(([l, val]) => [l, val * 10] as [string, number]);
        if (!opts.some(([, val]) => val === sl * 10)) opts.push([`${sl * 10} sec`, sl * 10]);
        out.push(s('sleep', 'Sleep after', 'Power', choice(opts, sl * 10)));
      }
      return out;
    });
  }

  private writeByte(addr: number, v: number): Promise<Reply> {
    return this.link.send(CMD_WRITE, addr, [v & 0xff, comp(v)]);
  }

  async write(st: Setting): Promise<void> {
    const v = st.value;
    const vr = this.v;
    await this.batch(async () => {
      switch (st.key) {
        case 'profile':
          if (v.kind !== 'choice' || v.current < 0 || v.current >= Math.max(1, this.profiles)) throw new Error('bad profile');
          await this.link.send(CMD_SET_PROFILE, 0, [v.current]);
          this.profile = v.current;
          return;
        case 'dpi': {
          if (v.kind !== 'dpi') throw new Error('bad value');
          if (!vr.codec) throw new Error("this mouse's DPI encoding isn't supported");
          for (let i = 0; i < v.stages.length && i < vr.maxStages; i++) {
            const dpi = Math.max(50, Math.min(vr.maxDpi, v.stages[i]));
            if (vr.codec === 's3955') {
              const b = stageBytes3955(dpi);
              const o = 6 * i;
              if (b.some((x, k) => x !== this.map3955[o + k])) {
                await this.link.send(CMD_WRITE, A_DPI3955 + o, b);
                b.forEach((x, k) => (this.map3955[o + k] = x));
              }
            } else {
              const b = stageBytes(dpi, vr.codec);
              const o = A_DPI + 4 * i;
              if (b.some((x, k) => x !== this.map[o + k])) {
                await this.link.send(CMD_WRITE, o, b);
                b.forEach((x, k) => (this.map[o + k] = x));
              }
            }
          }
          if (v.active !== this.map[A_ACTIVE]) {
            await this.writeByte(A_ACTIVE, v.active);
            this.map[A_ACTIVE] = v.active;
          }
          return;
        }
        case 'dpi_count': {
          if (v.kind !== 'choice' || v.current < 1 || v.current > vr.maxStages) throw new Error('bad value');
          await this.writeByte(A_STAGES, v.current);
          if (this.map[A_ACTIVE] >= v.current) await this.writeByte(A_ACTIVE, 0);
          return;
        }
        case 'polling':
          if (vr.r1Live) throw new Error("this receiver's polling rate lives elsewhere");
          if (v.kind !== 'choice' || !this.pollingTable().some(([, c]) => c === v.current)) throw new Error('bad value');
          await this.writeByte(A_RATE, v.current);
          return;
        case 'lod':
          if (!vr.lod || vr.r1Live || v.kind !== 'choice' || !vr.lod.some(([, c]) => c === v.current)) throw new Error('bad value');
          await this.writeByte(A_LOD, v.current);
          return;
        case 'motion_sync':
        case 'angle_snap':
        case 'ripple': {
          if (v.kind !== 'toggle') throw new Error('bad value');
          const ok = st.key === 'motion_sync' ? vr.msync : st.key === 'angle_snap' ? vr.angle && !vr.r1Live : vr.ripple;
          if (!ok) throw new Error(`${st.key} can't be changed on this mouse`);
          const a = st.key === 'motion_sync' ? A_MSYNC : st.key === 'angle_snap' ? A_ANGLE : A_RIPPLE;
          await this.writeByte(a, v.on ? 1 : 0);
          return;
        }
        case 'debounce':
          if (vr.r1Live || v.kind !== 'number' || v.current < 0 || v.current > 15) throw new Error('bad value');
          await this.writeByte(A_DEBOUNCE, v.current);
          return;
        case 'sleep': {
          if (v.kind !== 'choice') throw new Error('bad value');
          const steps = Math.round(v.current / 10);
          if (steps < 1 || steps > 255) throw new Error('bad value');
          await this.writeByte(A_SLEEP, steps);
          return;
        }
        default: {
          const bi = BTN_KEYS.indexOf(st.key);
          if (bi >= 0) {
            if (!vr.buttons) throw new Error("this mouse's buttons can't be changed here");
            if (v.kind !== 'choice') throw new Error('bad value');
            if (v.current === KEEP) return;
            const a = ACTIONS[v.current];
            if (!a) throw new Error('bad action');
            if (bi === 0 && !(a[1] === 1 && a[2] === 0x0100)) {
              // never leave the mouse without a left click
              const leftElsewhere = [1, 2, 3, 4].some((k) => this.map[A_BTN + 4 * k] === 1 && ((this.map[A_BTN + 4 * k + 1] << 8) | this.map[A_BTN + 4 * k + 2]) === 0x0100);
              if (!leftElsewhere) throw new Error('Put Left click on another button first');
            }
            const hi = (a[2] >> 8) & 0xff;
            const lo = a[2] & 0xff;
            const b = [a[1], hi, lo, comp3(a[1], hi, lo)];
            const o = A_BTN + 4 * bi;
            await this.link.send(CMD_WRITE, o, b);
            b.forEach((x, k) => (this.map[o + k] = x));
            return;
          }
          throw new Error(`${st.key} can't be changed`);
        }
      }
    });
  }

  async close(): Promise<void> {
    this.link.detach();
    if (this.device.opened) await this.device.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------- factories

const hasReport8 = (d: HIDDevice) =>
  (d.collections ?? []).some((c) => (c.outputReports ?? []).some((r) => r.reportId === REPORT_ID) && (c.inputReports ?? []).some((r) => r.reportId === REPORT_ID));

const PULSAR_KEYS = new Set([...PIDS_3710.map((p) => key(0x3710, p)), ...PIDS_3554_PULSAR.map((p) => key(0x3554, p))]);
const OTHER_KEYS = [...BASES.keys()].filter((k) => !PULSAR_KEYS.has(k));
const toFilter = (k: string): HIDDeviceFilter => ({ vendorId: parseInt(k.slice(0, 4), 16), productId: parseInt(k.slice(5), 16) });

async function createWith(f: DriverFactory, device: HIDDevice): Promise<Driver | null> {
  if (!f.match(device)) return null;
  const openedHere = !device.opened;
  if (openedHere) await device.open();
  const drv = new PulsarDriver(device);
  // the receiver can be plugged in with the mouse switched off: keep it, read() says so
  await drv.identify().catch(() => undefined);
  // 3554:F50A is both ATK's Dragonfly F1S (cid 2) and, in Pulsar's app config, a Pulsar keyboard
  const id = drv.identity();
  if (device.vendorId === 0x3554 && device.productId === 0xf50a && id && id[0] !== 2) {
    await drv.close();
    return null;
  }
  return drv;
}

export const pulsarFactory: DriverFactory = {
  name: 'Pulsar',
  filters: [...PULSAR_KEYS].map(toFilter),
  match(d: HIDDevice): boolean {
    return PULSAR_KEYS.has(key(d.vendorId, d.productId)) && hasReport8(d);
  },
  create: (device) => createWith(pulsarFactory, device),
};

/** VXE / ATK / VGN / Kysona / Scyrox / Lamzu Atlantis / Teevolution on the same protocol (all unverified). */
export const compxbFactory: DriverFactory = {
  name: 'CompX-B (VXE / ATK / VGN / Kysona / Scyrox / Lamzu / Teevolution)',
  filters: OTHER_KEYS.map(toFilter),
  match(d: HIDDevice): boolean {
    return BASES.has(key(d.vendorId, d.productId)) && !PULSAR_KEYS.has(key(d.vendorId, d.productId)) && hasReport8(d);
  },
  create: (device) => createWith(compxbFactory, device),
};

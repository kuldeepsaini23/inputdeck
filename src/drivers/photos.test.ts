// Every product photo a driver can hand to the UI: https, on the brand's own domain (or its official
// configurator's), never a retailer / review site. Walks the same ids each driver detects.
import { describe, expect, it } from 'vitest';
import { ATK_MICE, atkPhoto } from './compxb-atk';
import { MODELS as LOGITECH } from './logitech';
import { PHOTO as ORBITAL_PHOTO } from './orbital';
import { resolveVariant } from './pulsar';
import { MODELS as RAZER } from './razer';
import { compxEntry } from './wlmouse';

const BRAND_HOSTS = [
  'gm.wlmouse.gg', // WLMouse hub
  'lamzu.net', // Lamzu Aurora hub
  'webapp.arbiterstudio.com', // Vancer x Arbiter hub
  'bbb.pulsar.gg', // Pulsar web app
  'www.pulsar.gg', // Pulsar store
  'bpcdn.atkgear.com', // ATK HUB
  'hub.vgnlab.com', // VGN HUB
  'www.scyrox.net', // Scyrox S-center
  'www.controlhub.top', // TeevoLink (linked from teevolution.gg)
  'resource.logitechg.com',
  'medias-p1.phoenix.razer.com',
  'orbitalworks.co',
];

function allPhotos(): [string, string][] {
  const out: [string, string][] = [];
  const add = (label: string, url: string | undefined) => {
    if (url !== undefined) out.push([label, url]);
  };
  for (const [vid, pid, cid, mid, name] of ATK_MICE) add(`ATK ${name}`, resolveVariant(vid, pid, cid, mid).image);
  for (const [, , , , name, , p] of ATK_MICE) add(`ATK table ${name}`, atkPhoto(p));
  for (let mid = 0; mid <= 160; mid++) add(`Pulsar mid ${mid}`, resolveVariant(0x3710, 0x5406, 87, mid).image);
  for (let mid = 0; mid <= 0x20; mid++) add(`Pulsar cid6 ${mid}`, resolveVariant(0x3554, 0xf507, 6, mid).image);
  for (let mid = 0; mid <= 20; mid++) add(`Scyrox ${mid}`, resolveVariant(0x3554, 0xf5f4, 62, mid).image);
  for (let mid = 0; mid <= 8; mid++) add(`Teevolution ${mid}`, resolveVariant(0x3554, 0xf520, 14, mid).image);
  for (const vid of [0x3554, 0x391d]) for (let pid = 0; pid <= 0xffff; pid++) add(`CompX-B ${vid.toString(16)}:${pid.toString(16)}`, resolveVariant(vid, pid).image);
  for (const vid of [0x373e, 0x37b0]) {
    for (let pid = 0; pid < 0x100; pid++) for (const m of compxEntry(vid, pid)?.models ?? []) add(`${m.brand} ${m.name}`, m.img);
  }
  for (const m of Object.values(RAZER)) add(`Razer ${m.name}`, m.image);
  for (const [re, url] of LOGITECH) add(`Logitech ${re}`, url);
  add('Orbital', ORBITAL_PHOTO);
  return out;
}

describe('product photos', () => {
  const photos = allPhotos();

  it('covers the catalogs', () => {
    expect(photos.length).toBeGreaterThan(300);
  });

  it('are https URLs on an allow-listed brand domain', () => {
    const bad = photos.filter(([, url]) => {
      try {
        const u = new URL(url);
        return u.protocol !== 'https:' || !BRAND_HOSTS.includes(u.hostname);
      } catch {
        return true;
      }
    });
    expect(bad).toEqual([]);
  });

  it('point at an image file', () => {
    const bad = photos.filter(([, url]) => !/\.(png|webp|jpe?g)(\?width=\d+)?$/i.test(new URL(url).pathname + new URL(url).search));
    expect(bad).toEqual([]);
  });

  it('maps the X2 V2 generation and the By You builds to Pulsar store photos', () => {
    expect(resolveVariant(0x3554, 0xf507, 6, 0x0a).image).toMatch(/^https:\/\/www\.pulsar\.gg\/cdn\/shop\/products\/X2V2gamingmouse_.+\.png\?width=600$/);
    expect(resolveVariant(0x3710, 0x5406, 87, 31).image).toMatch(/X2AgamingMouse_top/);
  });

  it('gives the ATK hub skin to models the hub shows through a shared skin list', () => {
    expect(resolveVariant(0x373b, 0x115c, 2, 97).image).toBe('https://bpcdn.atkgear.com/device/ossAssets/y9/black.webp');
    expect(resolveVariant(0x373b, 0x11a0, 2, 107).image).toBe('https://bpcdn.atkgear.com/device/ossAssets/a9/a9-x-black.webp');
  });
});

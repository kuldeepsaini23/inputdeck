// Simulated SteelSeries mouse (rivalcfg protocol): records every report it gets; answers through `answer`.
// The demo one is a Rival 3 that reports firmware 1.33. Used by the tests and ?demo.
export class FakeSteelSeries {
  opened = false;
  vendorId = 0x1038;
  productName = 'SteelSeries Rival 3';
  /** tells the driver to keep remembered values in memory (demo) */
  simulated = true;
  sent: { type: string; data: number[] }[] = [];
  collections = [{ usagePage: 0xffc0, usage: 1, inputReports: [{ reportId: 0 }], outputReports: [{ reportId: 0 }], featureReports: [{ reportId: 0 }] }] as unknown as HIDCollectionInfo[];
  private listeners: ((e: HIDInputReportEvent) => void)[] = [];
  constructor(
    public productId = 0x1824,
    private answer: (data: number[]) => number[] | undefined = (d) => (d[0] === 0x10 ? [1, 33] : undefined),
  ) {}
  asHid(): HIDDevice {
    return this as unknown as HIDDevice;
  }
  async open() {
    this.opened = true;
  }
  async close() {
    this.opened = false;
  }
  addEventListener(_t: string, f: (e: HIDInputReportEvent) => void) {
    this.listeners.push(f);
  }
  removeEventListener(_t: string, f: (e: HIDInputReportEvent) => void) {
    this.listeners = this.listeners.filter((x) => x !== f);
  }
  private got(type: string, id: number, d: BufferSource) {
    if (!this.opened) throw new Error('closed');
    if (id !== 0) throw new Error('report id ' + id);
    const data = Array.from(new Uint8Array(d as ArrayBuffer));
    this.sent.push({ type, data });
    const r = this.answer(data);
    if (r) queueMicrotask(() => this.listeners.forEach((f) => f({ reportId: 0, data: new DataView(Uint8Array.from(r).buffer) } as unknown as HIDInputReportEvent)));
  }
  async sendReport(id: number, d: BufferSource) {
    this.got('output', id, d);
  }
  async sendFeatureReport(id: number, d: BufferSource) {
    this.got('feature', id, d);
  }
}

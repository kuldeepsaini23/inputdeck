// Demo mode (?demo): the simulated HUAN M and W75 from the tests stand in for real devices,
// so the app can be previewed and checked without anything plugged in.
import { FakeMouse } from './fake-mouse'
import { FakeKeyboard } from './fake-keyboard'
import { FakePulsar } from './fake-pulsar'
import { FakeLogitech } from './fake-logitech'
import { FakeRazer } from './fake-razer'
import { FakeLofree } from './fake-lofree'
import { FakeDareu } from './fake-dareu'

let devices: HIDDevice[] | undefined

export function demoDevices(): HIDDevice[] {
  devices ??= [
    new FakeMouse().asHid(),
    new FakeKeyboard({ socd: true }).asDevice(),
    new FakePulsar().asHid(),
    new FakePulsar({ vendorId: 0x3554, productId: 0xf510, productName: 'LAMZU Atlantis 8K Receiver', cid: 1, mid: 1, link: 5, codec: 's50' }).asHid(),
    new FakeLogitech({ wired: true }).asHid(),
    new FakeRazer().asHid(),
    new FakeLofree().asDevice(),
    new FakeDareu().asDevice(),
  ]
  return devices
}

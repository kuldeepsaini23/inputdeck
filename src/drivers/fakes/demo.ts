// Demo mode (?demo): the simulated HUAN M and W75 from the tests stand in for real devices,
// so the app can be previewed and checked without anything plugged in.
import { FakeMouse } from './fake-mouse'
import { FakeKeyboard } from './fake-keyboard'
import { FakePulsar } from './fake-pulsar'
import { FakeLogitech } from './fake-logitech'
import { FakeRazer } from './fake-razer'

let devices: HIDDevice[] | undefined

export function demoDevices(): HIDDevice[] {
  devices ??= [
    new FakeMouse().asHid(),
    new FakeKeyboard().asDevice(),
    new FakePulsar().asHid(),
    new FakeLogitech({ wired: true }).asHid(),
    new FakeRazer().asHid(),
  ]
  return devices
}

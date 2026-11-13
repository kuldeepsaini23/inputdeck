// Gamepad targets a VGN FLASH68 / FLASH68+ key can send in "Classic gamepad" mode.
// A key sends target `id` when its keymap entry is [0xF1, id, 0x0A].
// Source: VGN hub vgn/keypadKeyCodeMap-LCS6_gux.js, list `N`:
//   {name:"handelName.xAxisLeft",icon:"joystick/xAxisLeft.png",value:[241,1,10]}, ... value:[241,37,10] (throttle)
// Ids 15-18 are not in the hub's list and are never offered.

export const VGN_GAMEPAD_TAG = 0xf1;
export const VGN_GAMEPAD_TAIL = 0x0a;

export interface VgnGamepadTarget {
  id: number;
  name: string;
  kind: 'axis' | 'button';
}

const axis = (id: number, name: string): VgnGamepadTarget => ({ id, name, kind: 'axis' });
const button = (id: number, name: string): VgnGamepadTarget => ({ id, name, kind: 'button' });

/** In the hub's order. */
export const VGN_GAMEPAD_TARGETS: readonly VgnGamepadTarget[] = [
  axis(1, 'X axis left'),
  axis(2, 'X axis right'),
  axis(3, 'Y axis up'),
  axis(4, 'Y axis down'),
  axis(5, 'Z axis forward'),
  axis(6, 'Z axis backward'),
  axis(7, 'Z rotation'),
  axis(8, 'Z forward rotation'),
  axis(9, 'X rotation left'),
  axis(10, 'X rotation right'),
  axis(11, 'Y rotation up'),
  axis(12, 'Y rotation down'),
  axis(37, 'Throttle'),
  axis(14, 'Elevator'),
  axis(13, 'Accelerator'),
  axis(19, 'Rudder'),
  axis(20, 'Trigger'),
  button(21, 'Button 1 (A)'),
  button(22, 'Button 2 (B)'),
  button(23, 'Button 3 (X)'),
  button(24, 'Button 4 (Y)'),
  button(25, 'Button 5 (LB)'),
  button(26, 'Button 6 (RB)'),
  button(27, 'Button 7 (LT)'),
  button(28, 'Button 8 (RT)'),
  button(29, 'Button 9 (Back)'),
  button(30, 'Button 10 (Start)'),
  button(31, 'Button 11 (LS)'),
  button(32, 'Button 12 (RS)'),
  button(33, 'D-pad up'),
  button(34, 'D-pad down'),
  button(35, 'D-pad left'),
  button(36, 'D-pad right'),
];

export const VGN_GAMEPAD_IDS: ReadonlySet<number> = new Set(VGN_GAMEPAD_TARGETS.map((t) => t.id));

export const isVgnGamepadEntry = (e: ArrayLike<number>) => e[0] === VGN_GAMEPAD_TAG && e[2] === VGN_GAMEPAD_TAIL && VGN_GAMEPAD_IDS.has(e[1]);

import { createGameTest, expect } from '@izakyl/blockwright-test';
import { world } from '@izakyl/blockwright-minecraft';

const test = createGameTest({ config: 'blockwright.toml' });
test.setTimeout(600_000);

test('places a block in the test world', async ({ server }) => {
  const pos = { x: 0, y: -60, z: 0 };
  await world.command(server, 'setblock 0 -60 0 minecraft:diamond_block');
  expect((await world.block(server, pos)).id).toBe('minecraft:diamond_block');
});

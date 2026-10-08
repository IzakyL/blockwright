# Standalone Playwright example

Copy this directory into a new project, then run:

```sh
npm init -y
npm install --save-dev @playwright/test @izakyl/blockwright-test @izakyl/blockwright-minecraft
```

Install the [runtime prerequisites](../../docs/environment.md). Read
https://www.minecraft.net/eula and set `eula = true` in `blockwright.toml` if you
accept it. From this directory run `npx playwright test`. The test starts a fresh
client/server pair, places a diamond block, verifies it, and closes the game.
No Playwright browser download is needed.

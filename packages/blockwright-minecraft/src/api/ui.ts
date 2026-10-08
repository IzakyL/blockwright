// `ui`: the Minecraft platform and the vanilla-screen adapter for @izakyl/blockwright-ui.
export {
  minecraftUiAdapter as adapter,
  createMinecraftUiAdapter as createAdapter,
  minecraftUiHost as host,
  menuSlotKey,
  MINECRAFT_ADAPTER as ADAPTER_ID,
  type MinecraftUiAdapter as Adapter,
  type MinecraftUiAdapterOptions as AdapterOptions,
  type VanillaUiState as VanillaState,
} from "../ui/adapter.js";
export { minecraftUiPlatform as platform, uiReflectProbe as reflectProbe, type MinecraftUiProbe as Probe } from "../ui/platform.js";

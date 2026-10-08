package dev.blockwright.agent.mixin;

import dev.blockwright.agent.CrashHandler;

import java.io.File;
import java.util.List;

import net.neoforged.fml.ModLoadingIssue;
import net.neoforged.neoforge.client.gui.LoadingErrorScreen;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * NeoForge answers failed mod loading with this screen and keeps the JVM up, so a driven client
 * would sit on it until its readiness timeout. The agent reports the errors and exits instead.
 */
@Mixin(LoadingErrorScreen.class)
public abstract class LoadingErrorScreenMixin {
    @Inject(method = "<init>", at = @At("RETURN"))
    private void blockwright$exitOnLoadingErrors(
            List<ModLoadingIssue> issues, File dumpedLocation, Runnable nextScreenTask, CallbackInfo callback) {
        CrashHandler.exitOnModLoadingErrors(issues, dumpedLocation);
    }
}

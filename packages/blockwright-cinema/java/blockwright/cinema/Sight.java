package blockwright.cinema;

import static blockwright.minecraft.core.Values.obj;

import blockwright.minecraft.core.Args;
import blockwright.minecraft.core.Fail;
import blockwright.minecraft.core.Levels;

import dev.blockwright.api.Context;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.CollisionContext;

/**
 * How much of a subject a camera would see from each of several eyes, by casting rays through the blocks that
 * are there now: a neighbouring roof or a hillside can hide a subject from a pose that looked right on paper.
 */
public final class Sight {
    /** Rays per side of the grid cast over the subject. */
    private static final int GRID = 5;

    private Sight() {
    }

    /**
     * {@code {candidates: [{x,y,z}], subject: {minX,maxX,minZ,maxZ}, y, dimension?}}: casts a {@value #GRID} by
     * {@value #GRID} grid of rays from each candidate eye to the subject's rectangle at height {@code y}. A ray
     * counts when it reaches the rectangle or first hits a block inside it; an eye inside a solid block sees
     * nothing. Answers {@code {index, visible, of, seen}}: the best eye (the first of equals, -1 without
     * candidates), the rays it got through, the rays cast, and every eye's count.
     */
    public static Map<String, Object> clearest(Context ctx, Args args) {
        ServerLevel level = Levels.serverLevel(Levels.requireServer(ctx), args.string("dimension", null));
        Args subject = args.object("subject");
        double minX = subject.number("minX");
        double maxX = subject.number("maxX");
        double minZ = subject.number("minZ");
        double maxZ = subject.number("maxZ");
        if (maxX < minX || maxZ < minZ) {
            throw Fail.invalid("subject must have minX <= maxX and minZ <= maxZ");
        }
        double y = args.number("y");
        List<Object> candidates = args.list("candidates");
        List<Integer> seen = new ArrayList<>();
        int best = -1;
        int most = -1;
        for (int index = 0; candidates != null && index < candidates.size(); index++) {
            Args at = Args.of(candidates.get(index), "candidates[" + index + "]");
            Vec3 eye = new Vec3(at.number("x"), at.number("y"), at.number("z"));
            int visible = visible(level, eye, minX, maxX, minZ, maxZ, y);
            seen.add(visible);
            if (visible > most) {
                most = visible;
                best = index;
            }
        }
        return obj("index", best, "visible", Math.max(0, most), "of", GRID * GRID, "seen", seen);
    }

    private static int visible(ServerLevel level, Vec3 eye, double minX, double maxX, double minZ, double maxZ, double y) {
        BlockPos at = BlockPos.containing(eye);
        if (!level.getBlockState(at).getCollisionShape(level, at).isEmpty()) {
            return 0;
        }
        int visible = 0;
        for (int i = 0; i < GRID; i++) {
            for (int j = 0; j < GRID; j++) {
                double u = (i + 0.5) / GRID;
                double v = (j + 0.5) / GRID;
                Vec3 end = new Vec3(minX + (maxX - minX) * u, y, minZ + (maxZ - minZ) * v);
                BlockHitResult hit = level.clip(new ClipContext(eye, end, ClipContext.Block.COLLIDER,
                    ClipContext.Fluid.NONE, CollisionContext.empty()));
                BlockPos cell = hit.getBlockPos();
                if (hit.getType() == HitResult.Type.MISS
                    || (cell.getX() >= Math.floor(minX) && cell.getX() <= maxX && cell.getZ() >= Math.floor(minZ) && cell.getZ() <= maxZ)) {
                    visible++;
                }
            }
        }
        return visible;
    }
}

package dev.blockwright.coverage;

import org.objectweb.asm.AnnotationVisitor;
import org.objectweb.asm.ClassWriter;
import org.objectweb.asm.Label;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;
import org.objectweb.asm.Type;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.jar.Attributes;
import java.util.jar.JarEntry;
import java.util.jar.JarOutputStream;
import java.util.jar.Manifest;

/** Builds small classes and jars with ASM, shaped like what Mixin and NeoForge produce. */
final class Fixtures {
    private Fixtures() {
    }

    /** A method whose every listed line holds a little straight-line code. */
    record MethodSpec(String name, int[] lines, String mergedFrom) {
        static MethodSpec of(String name, int... lines) {
            return new MethodSpec(name, lines, null);
        }

        MethodSpec mergedFrom(String mixin) {
            return new MethodSpec(name, lines, mixin);
        }
    }

    static final class ClassSpec {
        final String name;
        String sourceFile;
        String smap;
        boolean isInterface;
        final List<String> mixinValues = new ArrayList<>();
        final List<String> mixinTargets = new ArrayList<>();
        final List<MethodSpec> methods = new ArrayList<>();

        ClassSpec(String name) {
            this.name = name;
            this.sourceFile = name.substring(name.lastIndexOf('/') + 1) + ".java";
        }

        ClassSpec smap(String smap) {
            this.smap = smap;
            return this;
        }

        ClassSpec asInterface() {
            this.isInterface = true;
            return this;
        }

        ClassSpec mixin(List<String> values, List<String> targets) {
            mixinValues.addAll(values);
            mixinTargets.addAll(targets);
            return this;
        }

        ClassSpec method(MethodSpec method) {
            methods.add(method);
            return this;
        }

        byte[] bytes() {
            ClassWriter writer = new ClassWriter(ClassWriter.COMPUTE_FRAMES | ClassWriter.COMPUTE_MAXS);
            int access = Opcodes.ACC_PUBLIC | (isInterface ? Opcodes.ACC_INTERFACE | Opcodes.ACC_ABSTRACT : 0);
            writer.visit(Opcodes.V21, access, name, null, "java/lang/Object", null);
            writer.visitSource(sourceFile, smap);
            if (!mixinValues.isEmpty() || !mixinTargets.isEmpty()) {
                AnnotationVisitor mixin = writer.visitAnnotation(ModJars.MIXIN_DESC, false);
                if (!mixinValues.isEmpty()) {
                    AnnotationVisitor values = mixin.visitArray("value");
                    mixinValues.forEach(value -> values.visit(null, Type.getObjectType(value)));
                    values.visitEnd();
                }
                if (!mixinTargets.isEmpty()) {
                    AnnotationVisitor targets = mixin.visitArray("targets");
                    mixinTargets.forEach(target -> targets.visit(null, target));
                    targets.visitEnd();
                }
                mixin.visitEnd();
            }
            for (MethodSpec spec : methods) {
                boolean init = spec.name().equals("<init>");
                MethodVisitor method = writer.visitMethod(init ? Opcodes.ACC_PUBLIC : Opcodes.ACC_PUBLIC | Opcodes.ACC_STATIC,
                    spec.name(), "()V", null, null);
                if (spec.mergedFrom() != null) {
                    AnnotationVisitor merged = method.visitAnnotation(Report.MERGED_DESC, true);
                    merged.visit("mixin", spec.mergedFrom());
                    merged.visit("priority", 1000);
                    merged.visit("sessionId", "test");
                    merged.visitEnd();
                }
                method.visitCode();
                if (init) {
                    method.visitVarInsn(Opcodes.ALOAD, 0);
                    method.visitMethodInsn(Opcodes.INVOKESPECIAL, "java/lang/Object", "<init>", "()V", false);
                }
                for (int line : spec.lines()) {
                    Label label = new Label();
                    method.visitLabel(label);
                    method.visitLineNumber(line, label);
                    method.visitInsn(Opcodes.ICONST_0);
                    method.visitInsn(Opcodes.POP);
                }
                method.visitInsn(Opcodes.RETURN);
                method.visitMaxs(0, 0);
                method.visitEnd();
            }
            writer.visitEnd();
            return writer.toByteArray();
        }
    }

    static ClassSpec type(String name) {
        return new ClassSpec(name);
    }

    /** Writes a jar of classes (by internal name) and resources (by path), with an optional MixinConfigs. */
    static Path jar(Path file, Map<String, byte[]> classes, Map<String, String> resources, String mixinConfigs)
        throws IOException {
        Manifest manifest = new Manifest();
        manifest.getMainAttributes().put(Attributes.Name.MANIFEST_VERSION, "1.0");
        if (mixinConfigs != null) {
            manifest.getMainAttributes().put(new Attributes.Name("MixinConfigs"), mixinConfigs);
        }
        try (OutputStream out = Files.newOutputStream(file); JarOutputStream jar = new JarOutputStream(out, manifest)) {
            for (Map.Entry<String, byte[]> entry : classes.entrySet()) {
                jar.putNextEntry(new JarEntry(entry.getKey() + ".class"));
                jar.write(entry.getValue());
                jar.closeEntry();
            }
            for (Map.Entry<String, String> entry : resources.entrySet()) {
                jar.putNextEntry(new JarEntry(entry.getKey()));
                jar.write(entry.getValue().getBytes(StandardCharsets.UTF_8));
                jar.closeEntry();
            }
        }
        return file;
    }

    static Map<String, byte[]> classes(ClassSpec... specs) {
        Map<String, byte[]> classes = new LinkedHashMap<>();
        for (ClassSpec spec : specs) {
            classes.put(spec.name, spec.bytes());
        }
        return classes;
    }
}

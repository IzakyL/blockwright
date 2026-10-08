package dev.blockwright.coverage;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import com.google.gson.JsonParser;
import com.google.gson.stream.JsonReader;

import org.objectweb.asm.AnnotationVisitor;
import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.Opcodes;
import org.objectweb.asm.Type;

import java.io.IOException;
import java.io.InputStream;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.function.Consumer;
import java.util.jar.Attributes;
import java.util.jar.JarFile;
import java.util.jar.Manifest;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;

/**
 * The classes and mixins of the mods under test, read straight from their jars. Only top-level entries count
 * as the mod's classes: jar-in-jar libraries under {@code META-INF/} belong to other artifacts.
 */
final class ModJars {
    static final String MIXIN_DESC = "Lorg/spongepowered/asm/mixin/Mixin;";

    private static final Pattern BINARY_NAME =
        Pattern.compile("[\\p{javaJavaIdentifierStart}][\\p{javaJavaIdentifierPart}]*(/[\\p{javaJavaIdentifierStart}][\\p{javaJavaIdentifierPart}]*)*");

    /** A mixin class: its internal name, the classes it targets, and whether it is an accessor-style interface. */
    record Mixin(String name, Set<String> targets, boolean isInterface) {
    }

    /** Internal name to class bytes, for every class of every jar. */
    final Map<String, byte[]> classes = new LinkedHashMap<>();
    /** Internal names of the mixins the jars' configs declare, mapped to what their bytecode says. */
    final Map<String, Mixin> mixins = new LinkedHashMap<>();

    private ModJars() {
    }

    static ModJars read(List<Path> jars, Consumer<String> warn) throws IOException {
        ModJars mods = new ModJars();
        List<String> declared = new ArrayList<>();
        for (Path path : jars) {
            try (JarFile jar = new JarFile(path.toFile())) {
                mods.readClasses(jar);
                declared.addAll(mixinNames(jar, path, warn));
            } catch (IOException error) {
                throw new IOException("cannot read jar " + path + ": " + error.getMessage(), error);
            }
        }
        for (String name : declared) {
            byte[] bytes = mods.classes.get(name);
            if (bytes == null) {
                warn.accept("mixin " + name.replace('/', '.') + " is declared but not in any jar");
                mods.mixins.putIfAbsent(name, new Mixin(name, Set.of(), false));
                continue;
            }
            mods.mixins.putIfAbsent(name, readMixin(name, bytes, warn));
        }
        return mods;
    }

    private void readClasses(JarFile jar) throws IOException {
        Enumeration<? extends ZipEntry> entries = jar.entries();
        while (entries.hasMoreElements()) {
            ZipEntry entry = entries.nextElement();
            String name = classEntryName(entry);
            if (name == null || classes.containsKey(name)) {
                continue;
            }
            try (InputStream in = jar.getInputStream(entry)) {
                classes.put(name, in.readAllBytes());
            }
        }
    }

    /** The internal class name of a jar entry, or null if it is not one of the mod's own classes. */
    static String classEntryName(ZipEntry entry) {
        String name = entry.getName();
        if (entry.isDirectory() || !name.endsWith(".class") || name.startsWith("META-INF/")) {
            return null;
        }
        String internal = name.substring(0, name.length() - ".class".length());
        String simple = internal.substring(internal.lastIndexOf('/') + 1);
        if (simple.equals("module-info") || simple.equals("package-info")) {
            return null;
        }
        return internal;
    }

    /** Mixin class names (internal) of every config the jar declares, in neoforge.mods.toml or the manifest. */
    private static List<String> mixinNames(JarFile jar, Path path, Consumer<String> warn) throws IOException {
        Set<String> configs = new LinkedHashSet<>();
        ZipEntry toml = jar.getEntry("META-INF/neoforge.mods.toml");
        if (toml != null) {
            try (InputStream in = jar.getInputStream(toml)) {
                configs.addAll(tomlMixinConfigs(new String(in.readAllBytes(), StandardCharsets.UTF_8)));
            }
        }
        Manifest manifest = jar.getManifest();
        if (manifest != null) {
            String attribute = manifest.getMainAttributes().getValue(new Attributes.Name("MixinConfigs"));
            if (attribute != null) {
                for (String config : attribute.split(",")) {
                    if (!config.isBlank()) {
                        configs.add(config.trim());
                    }
                }
            }
        }
        List<String> names = new ArrayList<>();
        for (String config : configs) {
            ZipEntry entry = jar.getEntry(config);
            if (entry == null) {
                warn.accept("mixin config " + config + " is not in " + path);
                continue;
            }
            try (InputStream in = jar.getInputStream(entry)) {
                names.addAll(configMixins(new String(in.readAllBytes(), StandardCharsets.UTF_8), config, warn));
            }
        }
        return names;
    }

    /**
     * The {@code config} values of every {@code [[mixins]]} table. A full TOML parser is not worth carrying for
     * one key, and mods.toml files only ever use simple {@code key = "value"} lines for it.
     */
    static List<String> tomlMixinConfigs(String toml) {
        List<String> configs = new ArrayList<>();
        boolean inMixins = false;
        for (String raw : toml.split("\r\n|\r|\n")) {
            String line = stripComment(raw).trim();
            if (line.startsWith("[")) {
                inMixins = line.replace(" ", "").equals("[[mixins]]");
                continue;
            }
            if (!inMixins) {
                continue;
            }
            int equals = line.indexOf('=');
            if (equals < 0 || !line.substring(0, equals).trim().equals("config")) {
                continue;
            }
            String value = line.substring(equals + 1).trim();
            if (value.length() >= 2 && (value.charAt(0) == '"' || value.charAt(0) == '\'')
                && value.charAt(value.length() - 1) == value.charAt(0)) {
                configs.add(value.substring(1, value.length() - 1));
            }
        }
        return configs;
    }

    private static String stripComment(String line) {
        char quote = 0;
        for (int i = 0; i < line.length(); i++) {
            char c = line.charAt(i);
            if (quote != 0) {
                if (c == quote) {
                    quote = 0;
                }
            } else if (c == '"' || c == '\'') {
                quote = c;
            } else if (c == '#') {
                return line.substring(0, i);
            }
        }
        return line;
    }

    /** Internal names of the classes listed in a mixin config's {@code mixins}, {@code client} and {@code server}. */
    static List<String> configMixins(String json, String config, Consumer<String> warn) {
        JsonObject root;
        try {
            JsonReader reader = new JsonReader(new StringReader(json));
            reader.setLenient(true);
            JsonElement element = JsonParser.parseReader(reader);
            if (!element.isJsonObject()) {
                warn.accept("mixin config " + config + " is not a JSON object");
                return List.of();
            }
            root = element.getAsJsonObject();
        } catch (JsonParseException error) {
            warn.accept("mixin config " + config + " is not valid JSON: " + error.getMessage());
            return List.of();
        }
        String pkg = root.has("package") && root.get("package").isJsonPrimitive()
            ? root.get("package").getAsString().trim() : "";
        List<String> names = new ArrayList<>();
        for (String list : List.of("mixins", "client", "server")) {
            JsonElement element = root.get(list);
            if (element == null || !element.isJsonArray()) {
                continue;
            }
            for (JsonElement item : (JsonArray) element) {
                if (!item.isJsonPrimitive() || item.getAsString().isBlank()) {
                    continue;
                }
                String dotted = pkg.isEmpty() ? item.getAsString().trim() : pkg + "." + item.getAsString().trim();
                names.add(dotted.replace('.', '/'));
            }
        }
        return names;
    }

    /** Reads {@code @Mixin}; it has class retention, so it is among the invisible annotations. */
    static Mixin readMixin(String name, byte[] bytes, Consumer<String> warn) {
        Set<String> targets = new TreeSet<>();
        boolean[] isInterface = new boolean[1];
        new ClassReader(bytes).accept(new ClassVisitor(Opcodes.ASM9) {
            @Override
            public void visit(int version, int access, String className, String signature, String superName,
                              String[] interfaces) {
                isInterface[0] = (access & Opcodes.ACC_INTERFACE) != 0;
            }

            @Override
            public AnnotationVisitor visitAnnotation(String descriptor, boolean visible) {
                if (!MIXIN_DESC.equals(descriptor)) {
                    return null;
                }
                return new AnnotationVisitor(Opcodes.ASM9) {
                    @Override
                    public AnnotationVisitor visitArray(String attribute) {
                        return new AnnotationVisitor(Opcodes.ASM9) {
                            @Override
                            public void visit(String unused, Object value) {
                                if ("value".equals(attribute) && value instanceof Type type
                                    && type.getSort() == Type.OBJECT) {
                                    targets.add(type.getInternalName());
                                } else if ("targets".equals(attribute) && value instanceof String target) {
                                    String internal = target.trim().replace('.', '/');
                                    if (BINARY_NAME.matcher(internal).matches()) {
                                        targets.add(internal);
                                    } else {
                                        warn.accept("mixin " + name.replace('/', '.') + " has an unusable target \""
                                            + target + "\"");
                                    }
                                }
                            }
                        };
                    }
                };
            }
        }, ClassReader.SKIP_CODE | ClassReader.SKIP_DEBUG | ClassReader.SKIP_FRAMES);
        if (targets.isEmpty()) {
            warn.accept("mixin " + name.replace('/', '.') + " names no target classes");
        }
        return new Mixin(name, targets, isInterface[0]);
    }
}
